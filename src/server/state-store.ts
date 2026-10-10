/**
 * Owns the RunState of every button: feeds events through `transition()` (src/core/machine.ts),
 * performs its effects (spawn, kill, reset timers) and reports every state change. Also keeps the
 * run history (last HISTORY_SIZE runs per button) behind GET /api/runs, and limits how fast presses
 * can start actions.
 */
import { buttonKey, type Button, type Config } from '../core/config.ts';
import { transition, type Effect, type MachineEvent, type RunState } from '../core/machine.ts';
import type { PressResult, RunRecord, StateMap } from '../core/protocol.ts';
import { KILL_GRACE_MS, MAX_DELAY_MS, startRun, type RunHandle, type RunHooks, type RunOutcome, type RunSpec } from './runner.ts';

export const HISTORY_SIZE = 20;
/** A cancel press this soon after its run started is taken as a double press, not a cancel: ignored. */
export const CANCEL_GRACE_MS = 700;

/** Over all buttons together. A press refused by them gets the result "ignored". */
export interface StartLimits {
  /** Token bucket for presses that start (or queue) a run: up to `burst` at once… */
  burst: number;
  /** …refilled at `perSec`. */
  perSec: number;
  /** Runs at the same time. */
  maxRunning: number;
}
export const START_LIMITS: StartLimits = { burst: 20, perSec: 10, maxRunning: 32 };

interface LiveRun {
  runId: number;
  key: string;
  handle: RunHandle;
  record: RunRecord;
  /** Start time on the monotonic clock. */
  t0: number;
  /** Its button was removed from the config while it ran, and the kill reached it. */
  orphaned?: boolean;
}

interface Slot {
  key: string;
  pad: string;
  button: Button;
  state: RunState;
  run?: LiveRun;
  resetTimer?: ReturnType<typeof setTimeout>;
}

export interface StateStoreOptions {
  /** Directory actions' relative paths resolve against (the config file's directory). */
  baseDir: string;
  onState?(key: string, state: RunState): void;
  onRunStart?(key: string, runId: number, button: Button): void;
  onRunEnd?(key: string, record: RunRecord, outcome: RunOutcome): void;
  /** Messages for the operator, e.g. that the limits refuse presses. */
  log?(msg: string): void;
  cancelGraceMs?: number;
  limits?: Partial<StartLimits>;
  /** Injection points for tests. */
  spawn?: (spec: RunSpec, hooks: RunHooks) => RunHandle;
  /** Epoch ms, for the timestamps clients display. */
  now?: () => number;
  /** Monotonic ms, for the cancel grace and the rate limit. */
  clock?: () => number;
}

/** `take()` succeeds `burst` times at once, then at `perSec` on average. */
class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly perSec: number,
    private readonly clock: () => number,
  ) {
    this.tokens = burst;
    this.last = clock();
  }

  take(): boolean {
    const now = this.clock();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

export class StateStore {
  private slots = new Map<string, Slot>();
  private history = new Map<string, RunRecord[]>();
  private live = new Set<LiveRun>();
  /** Killed runs whose action exited while the rest of their process group may live on (SIGKILL pending). */
  private dying = new Set<LiveRun>();
  private closed = false;
  /** Presses are being refused by the limits (logged once per streak). */
  private refusing = false;
  private readonly spawn: NonNullable<StateStoreOptions['spawn']>;
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly cancelGraceMs: number;
  private readonly limits: StartLimits;
  private readonly bucket: TokenBucket;

  constructor(
    config: Config,
    private opts: StateStoreOptions,
  ) {
    this.spawn = opts.spawn ?? startRun;
    this.now = opts.now ?? Date.now;
    this.clock = opts.clock ?? (() => performance.now());
    this.cancelGraceMs = opts.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.limits = { ...START_LIMITS, ...opts.limits };
    this.bucket = new TokenBucket(this.limits.burst, this.limits.perSec, this.clock);
    this.setConfig(config);
  }

  /**
   * Reconcile with a new config. Removed buttons lose their state (and a running action is killed);
   * kept buttons pick up their new settings, but a current run keeps the action it started with.
   * Returns the keys of added buttons.
   */
  setConfig(config: Config): string[] {
    const wanted = new Map<string, { pad: string; button: Button }>();
    for (const p of config.pads) for (const b of p.buttons) wanted.set(buttonKey(p.id, b.id), { pad: p.id, button: b });
    for (const [key, slot] of this.slots) if (!wanted.has(key)) this.removeSlot(slot);
    const added: string[] = [];
    for (const [key, { pad, button }] of wanted) {
      const slot = this.slots.get(key);
      if (slot) {
        slot.button = button;
        continue;
      }
      // Keep runIds increasing for a key that comes back, so clients never see an old runId reused.
      const runId = this.history.get(key)?.[0]?.runId ?? 0;
      this.slots.set(key, { key, pad, button, state: { phase: 'ready', runId } });
      added.push(key);
    }
    return added;
  }

  /** `onResult` runs before any state change is reported, so an ack can precede the broadcasts. */
  press(padId: string, buttonId: string, onResult?: (result: PressResult, key: string) => void): { result: PressResult; key: string; state?: RunState } {
    const key = buttonKey(padId, buttonId);
    const slot = this.slots.get(key);
    const reply = (result: PressResult) => {
      onResult?.(result, key);
      return { result, key, state: slot?.state };
    };
    if (!slot) return reply('unknown-button');
    if (this.closed) return reply('ignored');
    const prev = slot.state;
    const mode = slot.button.whileRunning;
    if (prev.phase !== 'running') {
      if (!this.mayStart(key)) return reply('ignored');
    } else if (mode === 'cancel') {
      // A double press would start the run and cancel it right away.
      if (!prev.cancelling && slot.run && this.clock() - slot.run.t0 < this.cancelGraceMs) return reply('ignored');
    } else if (mode === 'queue') {
      // The queued re-run is a start too.
      if (!prev.queued && !this.takeStart()) return reply('ignored');
    }
    const [next, effects] = transition(prev, { type: 'press', now: this.now() }, this.machineOpts(slot));
    // A cancel must reach the process. If the action already exited and only its output is still
    // draining, it's too late: the run ends as what it was.
    const kill = effects.find((e) => e.type === 'kill');
    if (kill && !this.kill(slot, kill.runId)) return reply('ignored');
    const result: PressResult = prev.phase !== 'running' ? 'started' : ({ cancel: 'cancelling', queue: 'queued', ignore: 'ignored' } as const)[mode];
    onResult?.(result, key);
    this.apply(slot, next, kill ? effects.filter((e) => e !== kill) : effects);
    return { result, key, state: slot.state };
  }

  get(key: string): RunState | undefined {
    return this.slots.get(key)?.state;
  }

  states(): StateMap {
    const out: StateMap = {};
    for (const [key, slot] of this.slots) out[key] = slot.state;
    return out;
  }

  /** Newest first. Running records carry their output so far. */
  runs(filter: { pad?: string; button?: string } = {}): RunRecord[] {
    const out: RunRecord[] = [];
    for (const records of this.history.values())
      for (const r of records) if ((!filter.pad || r.pad === filter.pad) && (!filter.button || r.button === filter.button)) out.push(r);
    const liveByRecord = new Map([...this.live].map((l) => [l.record, l.handle]));
    return out
      .sort((a, b) => b.startedAt - a.startedAt || b.runId - a.runId)
      .map((r) => {
        const h = liveByRecord.get(r);
        return h ? { ...r, stdout: h.stdout(), stderr: h.stderr() } : { ...r };
      });
  }

  /** Number of actions currently running (including ones whose button was removed). */
  get running(): number {
    return this.live.size;
  }

  /** Stop accepting presses, SIGTERM every running action, SIGKILL what's left after `graceMs`. */
  async shutdown(graceMs = KILL_GRACE_MS): Promise<void> {
    this.closed = true;
    for (const slot of this.slots.values()) clearTimeout(slot.resetTimer);
    // Runs killed earlier that are still in their grace period get the rest of it, like the running ones.
    const runs = [...this.live, ...this.stragglers()];
    for (const r of this.live) r.handle.kill();
    const deadline = performance.now() + graceMs;
    while (runs.some((r) => r.handle.alive()) && performance.now() < deadline) await Bun.sleep(20);
    this.forceKillAll(runs);
  }

  /** Synchronous last resort (process 'exit' handler): SIGKILL every running or dying action. */
  forceKillAll(runs: Iterable<LiveRun> = [...this.live, ...this.stragglers()]) {
    for (const r of runs) if (r.handle.alive()) r.handle.forceKill();
  }

  private machineOpts(slot: Slot) {
    return { whileRunning: slot.button.whileRunning, resultHoldMs: slot.button.resultHoldMs };
  }

  /** Whether a press may start a new run of `key` now. */
  private mayStart(key: string): boolean {
    // An earlier run of this key is still on its way out: one of a removed-and-re-added button, or a
    // killed run's process group in its grace period. Never two instances at once.
    if ([...this.live, ...this.stragglers()].some((r) => r.key === key)) return false;
    if (this.live.size >= this.limits.maxRunning) return this.refuse(`${this.live.size} actions are running (max ${this.limits.maxRunning})`);
    return this.takeStart();
  }

  private takeStart(): boolean {
    if (!this.bucket.take()) return this.refuse(`presses are coming in too fast (max ${this.limits.burst} at once, then ${this.limits.perSec}/s)`);
    this.refusing = false;
    return true;
  }

  private refuse(why: string): false {
    if (!this.refusing) this.opts.log?.(`ignoring presses: ${why}`);
    this.refusing = true;
    return false;
  }

  /** The dying runs, minus those whose process group is gone or got its SIGKILL meanwhile. */
  private stragglers(): LiveRun[] {
    for (const r of this.dying) if (!r.handle.dying()) this.dying.delete(r);
    return [...this.dying];
  }

  private kill(slot: Slot, runId: number): boolean {
    return slot.run?.runId === runId && slot.run.handle.kill();
  }

  private dispatch(slot: Slot, event: MachineEvent) {
    if (this.slots.get(slot.key) !== slot) return; // button was removed
    const [next, effects] = transition(slot.state, event, this.machineOpts(slot));
    this.apply(slot, next, effects);
  }

  private apply(slot: Slot, next: RunState, effects: Effect[]) {
    if (next !== slot.state) {
      slot.state = next;
      this.opts.onState?.(slot.key, next);
    }
    for (const e of effects) this.perform(slot, e);
  }

  private perform(slot: Slot, e: Effect) {
    switch (e.type) {
      case 'start':
        this.startRun(slot, e.runId);
        break;
      case 'kill':
        this.kill(slot, e.runId);
        break;
      case 'scheduleReset':
        clearTimeout(slot.resetTimer);
        slot.resetTimer = setTimeout(() => {
          slot.resetTimer = undefined;
          this.dispatch(slot, { type: 'reset', runId: e.runId });
        }, Math.min(e.afterMs, MAX_DELAY_MS));
        break;
    }
  }

  private startRun(slot: Slot, runId: number) {
    const b = slot.button;
    const startedAt = slot.state.phase === 'running' ? slot.state.startedAt : this.now();
    const record: RunRecord = { runId, pad: slot.pad, button: b.id, startedAt, stdout: '', stderr: '' };
    const list = this.history.get(slot.key) ?? [];
    list.unshift(record);
    list.length = Math.min(list.length, HISTORY_SIZE);
    this.history.set(slot.key, list);

    let run: LiveRun | undefined;
    const handle = this.spawn(
      {
        action: b.action,
        baseDir: this.opts.baseDir,
        timeoutMs: b.timeoutMs,
        env: { BUTTPAD_PAD: slot.pad, BUTTPAD_BUTTON: b.id, BUTTPAD_RUN_ID: String(runId), BUTTPAD_LABEL: b.label },
      },
      {
        onUpdate: (u) => this.dispatch(slot, { type: 'progress', runId, ...u }),
        onExit: (o) => run && this.finishRun(slot, run, o),
      },
    );
    run = { runId, key: slot.key, handle, record, t0: this.clock() };
    slot.run = run;
    this.live.add(run);
    this.opts.onRunStart?.(slot.key, runId, b);
  }

  private finishRun(slot: Slot, run: LiveRun, o: RunOutcome) {
    const cancelling = slot.state.phase === 'running' && slot.state.runId === run.runId && slot.state.cancelling;
    const rec = run.record;
    rec.endedAt = this.now();
    rec.exitCode = o.exitCode;
    rec.reason = run.orphaned || cancelling ? 'cancelled' : (o.reason ?? 'exit');
    rec.stdout = o.stdout;
    rec.stderr = o.stderr;
    this.live.delete(run);
    if (run.handle.dying()) this.dying.add(run);
    if (slot.run === run) slot.run = undefined;
    this.opts.onRunEnd?.(run.key, rec, o);
    if (this.closed) return;
    this.dispatch(slot, { type: 'exit', runId: run.runId, now: rec.endedAt, exitCode: o.exitCode, text: o.text, reason: o.reason });
  }

  private removeSlot(slot: Slot) {
    clearTimeout(slot.resetTimer);
    this.slots.delete(slot.key);
    const run = slot.run;
    if (run?.handle.kill()) run.orphaned = true;
  }
}
