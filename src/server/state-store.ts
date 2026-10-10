/**
 * Owns the RunState of every button: feeds events through `transition()` (src/core/machine.ts),
 * performs its effects (spawn, kill, reset and requeue timers) and reports every state change.
 *
 * Also: the press gate (stale presses, confirm, rate limits, never two instances of a button),
 * `stops`, latched device state (`@state`), the run history behind GET /api/runs, and what
 * survives a restart or a crash (buttpad.state.json, see persist.ts).
 */
import { buttonKey, type Button, type Config } from '../core/config.ts';
import { transition, type Effect, type LastResult, type MachineEvent, type RunState } from '../core/machine.ts';
import { PRESS_MAX_AGE_MS, type PressResult, type RunRecord, type StateMap } from '../core/protocol.ts';
import { BucketMap, ThrottledLog, TokenBucket, type PressSource } from './limits.ts';
import { loadState, StateFile, type ButtonMemo, type LiveEntry, type PersistedState } from './persist.ts';
import { Leftover, processFingerprint, processFingerprintAsync } from './proc.ts';
import { clip, finishedRun, KILL_GRACE_MS, LATCHED_MAX, MAX_DELAY_MS, sanitize, startRun, type RunHandle, type RunHooks, type RunOutcome, type RunSpec, type RunUpdate } from './runner.ts';

export const HISTORY_SIZE = 20;
/** A cancel press this soon after its run started is taken as a double press, not a cancel: ignored. */
export const CANCEL_GRACE_MS = 700;
/** A queued re-run waiting for the previous run's processes to go (or for a free slot) looks again this often. */
const REQUEUE_RETRY_MS = 100;
/** Buttons whose memo (last run id, result) is kept although they're no longer in the config. */
const MAX_MEMOS = 1000;
/** A run the host lost track of (it stopped or crashed while the run went on). */
export const INTERRUPTED_TEXT = 'Interrupted: host restarted';

/** How the host stopped a run: RunRecord.error, and the host log. */
export const STOP_REASONS = {
  device: 'cancelled from a device',
  removed: 'stopped: button removed by a config change',
  shutdown: 'stopped: host shutdown',
  by: (label: string) => `stopped by ${label}`,
} as const;

/** Limits on presses that start (or queue) a run. A press they refuse gets the result "ignored". */
export interface StartLimits {
  /** Over all sources together, a token bucket: up to `burst` at once… */
  burst: number;
  /** …refilled at `perSec`. */
  perSec: number;
  /** The same per source: each WebSocket connection, and each client address (all its connections and HTTP presses together), so no one device can use up everyone's. */
  sourceBurst: number;
  sourcePerSec: number;
  /** Runs at the same time. */
  maxRunning: number;
}
export const START_LIMITS: StartLimits = { burst: 40, perSec: 20, sourceBurst: 10, sourcePerSec: 5, maxRunning: 32 };

export interface PressOptions {
  /** When the user pressed, by the host's clock (epoch ms). Older than PRESS_MAX_AGE_MS → `expired`; later than now counts as now; absent = now. */
  at?: number;
  /** The user went through the button's confirm step: needed to start (or queue) a `confirm` button. */
  confirm?: boolean;
  /** Who pressed: its own rate limit, and log lines. */
  source?: PressSource;
  /** Gets the result before any state change is reported, so an ack can precede the broadcasts. */
  onResult?(reply: PressReply): void;
}

export interface PressReply {
  result: PressResult;
  key: string;
  /** started: the run it started; queued: the run it's queued behind; cancelling: the run being cancelled. */
  runId?: number;
  /** Why a limit refused it (result `ignored`): `rate` = presses coming too fast, `busy` = too many runs at once. */
  refused?: 'rate' | 'busy';
  /** The button's state after the press. */
  state?: RunState;
}

/** Something whose processes may still be alive: a run, or a group a previous host left behind. */
interface Straggler {
  key: string;
  handle: Pick<RunHandle, 'alive' | 'dying' | 'forceKill'>;
}

interface LiveRun extends Straggler {
  runId: number;
  handle: RunHandle;
  record: RunRecord;
  /** Start time on the monotonic clock. */
  t0: number;
  timeoutMs: number;
  /** The host stopped it (RunRecord.error): cancel press, `stops`, button removed, shutdown. */
  stopReason?: string;
  /** Who sent the cancel, for the log. */
  stopSource?: string;
  /** Failure text instead of the run's own output (stopped by another button). */
  stopText?: string;
  /** Its button was removed from the config while it ran, and the kill reached it. */
  orphaned?: boolean;
  /** Its entry in buttpad.state.json `live`. */
  entry?: LiveEntry;
}

interface Slot {
  key: string;
  pad: string;
  button: Button;
  state: RunState;
  run?: LiveRun;
  resetTimer?: ReturnType<typeof setTimeout>;
  requeueTimer?: ReturnType<typeof setTimeout>;
}

export interface StateStoreOptions {
  /** Directory actions' relative paths resolve against (the config file's directory). */
  baseDir: string;
  onState?(key: string, state: RunState): void;
  /** A button's latched device state (`@state`) changed; null = cleared. */
  onLatched?(key: string, text: string | null): void;
  onRunStart?(key: string, runId: number, button: Button): void;
  onRunEnd?(key: string, record: RunRecord, outcome: RunOutcome, run: { stopSource?: string }): void;
  /** Messages for the operator, e.g. that the limits refuse presses. */
  log?(msg: string): void;
  /** buttpad.state.json; without it nothing survives a restart. */
  statePath?: string;
  /** Injection point for tests: writes the state file (default: atomic write). */
  stateWrite?: (path: string, text: string) => void;
  cancelGraceMs?: number;
  limits?: Partial<StartLimits>;
  /** Injection points for tests. */
  spawn?: (spec: RunSpec, hooks: RunHooks) => RunHandle;
  /** Epoch ms, for the timestamps clients display and the age of presses. */
  now?: () => number;
  /** Monotonic ms, for the cancel grace, the rate limits and log throttling. */
  clock?: () => number;
}

/** Whether a `stops` pattern list (`pad/button`, `pad/*`, `*`) covers this button. */
export function matchesStop(patterns: readonly string[], pad: string, button: string): boolean {
  return patterns.some((p) => p === '*' || p === `${pad}/*` || p === `${pad}/${button}`);
}

/** How a finished run ended, as READY's `last` will say it (the machine's rule). */
function lastOf(s: RunState): LastResult | undefined {
  if (s.phase === 'ready') return s.last;
  if (s.phase === 'running') return undefined;
  const last: LastResult = { runId: s.runId, ok: s.phase === 'success', endedAt: s.endedAt };
  if (s.phase === 'failure') last.reason = s.reason;
  if (s.text !== undefined) last.text = s.text;
  return last;
}

const sameLast = (a: LastResult | undefined, b: LastResult | undefined) =>
  a === b || (!!a && !!b && a.runId === b.runId && a.ok === b.ok && a.reason === b.reason && a.text === b.text && a.endedAt === b.endedAt);

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${+(ms / 1000).toFixed(1)} s` : `${+(ms / 60_000).toFixed(1)} min`);

export class StateStore {
  private slots = new Map<string, Slot>();
  private history = new Map<string, RunRecord[]>();
  private live = new Set<LiveRun>();
  /** Killed runs whose action exited while the rest of their process group may live on (SIGKILL pending), and leftovers of a previous host. */
  private dying = new Set<Straggler>();
  /** Per button: last run id, last result, latched state. Persisted; outlives the button (ids keep increasing if it comes back). */
  private memos = new Map<string, ButtonMemo>();
  /** buttpad.state.json `live`: runs in flight, and the ones a shutdown stopped. */
  private liveEntries = new Set<LiveEntry>();
  /** Left in flight by the previous host, for recover(). */
  private toRecover: LiveEntry[] = [];
  private persist: StateFile | undefined;
  private hostId: PersistedState['host'];
  private closed = false;
  private readonly spawn: NonNullable<StateStoreOptions['spawn']>;
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly cancelGraceMs: number;
  private readonly limits: StartLimits;
  private readonly bucket: TokenBucket;
  private readonly ipBuckets: BucketMap;
  private readonly refusals: ThrottledLog;
  private readonly expired: ThrottledLog;
  private readonly unconfirmed: ThrottledLog;

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
    this.ipBuckets = new BucketMap(() => new TokenBucket(this.limits.sourceBurst, this.limits.sourcePerSec, this.clock));
    const log = (m: string) => this.opts.log?.(m);
    this.refusals = new ThrottledLog(log, this.clock);
    this.expired = new ThrottledLog(log, this.clock);
    this.unconfirmed = new ThrottledLog(log, this.clock);
    if (opts.statePath) this.load(opts.statePath);
    this.setConfig(config);
  }

  /**
   * A press source with its own rate limit, e.g. one WebSocket connection. With `address`, it also
   * draws from that address's bucket (shared with the address's other connections and its HTTP
   * presses), so a device can't get past the limit by opening more connections.
   */
  newSource(label: string, address?: string): PressSource {
    const own = new TokenBucket(this.limits.sourceBurst, this.limits.sourcePerSec, this.clock);
    return { label, buckets: address === undefined ? [own] : [own, this.ipBuckets.get(address)] };
  }

  /** The press source of an HTTP client: its address's bucket. */
  addressSource(address: string, label = `http ${address}`): PressSource {
    return { label, buckets: [this.ipBuckets.get(address)] };
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
      // Keep runIds increasing for a key that comes back (or across a restart), so clients never see an old runId reused.
      const memo = this.memos.get(key);
      const runId = Math.max(this.history.get(key)?.[0]?.runId ?? 0, memo?.lastRunId ?? 0);
      const state: RunState = memo?.last ? { phase: 'ready', runId, last: memo.last } : { phase: 'ready', runId };
      this.slots.set(key, { key, pad, button, state });
      added.push(key);
    }
    this.trimMemos();
    return added;
  }

  /**
   * Handle a press. Results other than started/queued/cancelling run nothing: `unknown-button`,
   * `expired` (older than PRESS_MAX_AGE_MS by the host's clock: it sat in a dead link or a stalled
   * host), `needs-confirm` (a `confirm` button pressed without `confirm`), `ignored` (running
   * with whileRunning `ignore`, already queued, a cancel within the double-press grace, an earlier
   * run of the button still dying, or refused by the limits: then `refused` says which).
   */
  press(padId: string, buttonId: string, o: PressOptions = {}): PressReply {
    const key = buttonKey(padId, buttonId);
    const slot = this.slots.get(key);
    const reply = (result: PressResult, extra: Partial<PressReply> = {}): PressReply => {
      const r: PressReply = { result, key, ...extra, state: slot?.state };
      o.onResult?.(r);
      return r;
    };
    if (!slot) return reply('unknown-button');
    if (this.closed) return reply('ignored');
    const from = o.source ? ` from ${o.source.label}` : '';
    const now = this.now();
    if (o.at !== undefined && now - o.at > PRESS_MAX_AGE_MS) {
      this.expired.note(`dropped a stale press of ${key}${from}: made ${seconds(now - o.at)} ago (max ${seconds(PRESS_MAX_AGE_MS)}); it was held up on the way`);
      return reply('expired');
    }
    const prev = slot.state;
    const mode = slot.button.whileRunning;
    const running = prev.phase === 'running';
    // A queued re-run is already coming (still running, or showing the result before it starts).
    if (prev.phase !== 'ready' && prev.queued && (!running || mode === 'queue')) return reply('ignored');
    const starts = !running;
    const queues = running && mode === 'queue';
    if ((starts || queues) && slot.button.confirm && !o.confirm) {
      this.unconfirmed.note(`refused a press of ${key}${from}: the button needs confirm (WebSocket "confirm": true, HTTP ?confirm=1)`);
      return reply('needs-confirm');
    }
    if (running && mode === 'ignore') return reply('ignored');
    // A double press would start the run and cancel it right away.
    if (running && mode === 'cancel' && !prev.cancelling && slot.run && this.clock() - slot.run.t0 < this.cancelGraceMs) return reply('ignored');
    if (starts || queues) {
      const why = this.gate(key, starts, o.source);
      if (why) return reply('ignored', why === 'dying' ? {} : { refused: why });
    }
    const [next, effects] = transition(prev, { type: 'press', now }, this.machineOpts(slot));
    // A cancel must reach the process. If the action already exited and only its output is still
    // draining, it's too late: the run ends as what it was.
    const kill = effects.find((e) => e.type === 'kill');
    if (kill && !this.stop(slot.run, kill.runId, { reason: STOP_REASONS.device, source: o.source?.label })) return reply('ignored');
    const result: PressResult = starts ? 'started' : mode === 'cancel' ? 'cancelling' : 'queued';
    const r: PressReply = { result, key, runId: next.runId };
    o.onResult?.(r);
    this.apply(slot, next, kill ? effects.filter((e) => e !== kill) : effects);
    r.state = slot.state;
    return r;
  }

  get(key: string): RunState | undefined {
    return this.slots.get(key)?.state;
  }

  states(): StateMap {
    const out: StateMap = {};
    for (const [key, slot] of this.slots) out[key] = slot.state;
    return out;
  }

  /** Latched device state (`@state`) of the buttons in the config. */
  latched(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of this.slots.keys()) {
      const t = this.memos.get(key)?.latched;
      if (t) out[key] = t;
    }
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

  /**
   * Deal with the runs the previous host left in flight (buttpad.state.json `live`): a run whose
   * process is still alive and provably the same one (start-time fingerprint; a PID can be reused)
   * is stopped like a cancel (SIGTERM to its process group, SIGKILL after 2 s); every such button
   * shows FAILURE `interrupted` for its resultHoldMs, then READY with that as `last`. Call once,
   * after the host knows it is the only one (it got its port).
   */
  recover() {
    const entries = this.toRecover;
    this.toRecover = [];
    for (const e of entries) {
      let how = 'it had already ended';
      if (e.fingerprint && processFingerprint(e.pid) === e.fingerprint) {
        // Still running, and the same process (not a later one that got its PID): stop its group.
        this.dying.add({ key: e.key, handle: new Leftover(e.pgid, e.pid, KILL_GRACE_MS) });
        how = `still running as pid ${e.pid}: stopping it`;
      } else if (e.stopped === 'shutdown') how = 'stopped by the shutdown';
      else if (processFingerprint(e.pid)) how = `pid ${e.pid} is another process now: left alone`;
      this.log(`■ ${e.key} #${e.runId} was interrupted when the previous host stopped (${how})`);
      const endedAt = e.endedAt ?? this.now();
      const [pad = '', button = ''] = e.key.split('/');
      this.addRecord(e.key, {
        runId: e.runId,
        pad,
        button,
        startedAt: e.startedAt,
        endedAt,
        exitCode: null,
        reason: 'interrupted',
        error: e.stopped === 'shutdown' ? STOP_REASONS.shutdown : `interrupted: the host stopped while it ran (${how})`,
        ...(e.command !== undefined ? { command: e.command } : {}),
        ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
        stdout: '',
        stderr: '',
      });
      const memo = this.memo(e.key);
      if (e.runId < memo.lastRunId) continue; // a newer run is known: this one is old news
      memo.last = { runId: e.runId, ok: false, reason: 'interrupted', text: INTERRUPTED_TEXT, endedAt };
      const slot = this.slots.get(e.key);
      if (slot?.state.phase === 'ready' && slot.state.runId === e.runId)
        this.apply(
          slot,
          { phase: 'failure', runId: e.runId, startedAt: e.startedAt, endedAt, exitCode: null, reason: 'interrupted', text: INTERRUPTED_TEXT },
          [{ type: 'scheduleReset', runId: e.runId, afterMs: slot.button.resultHoldMs }],
        );
    }
    if (entries.length) this.persist?.flush();
  }

  /** Stop accepting presses, SIGTERM every running action, SIGKILL what's left after `graceMs`, save the state file. */
  async shutdown(graceMs = KILL_GRACE_MS): Promise<void> {
    this.closed = true;
    for (const slot of this.slots.values()) {
      clearTimeout(slot.resetTimer);
      clearTimeout(slot.requeueTimer);
    }
    for (const l of [this.refusals, this.expired, this.unconfirmed]) l.close();
    // Runs killed earlier that are still in their grace period get the rest of it, like the running ones.
    const runs: Straggler[] = [...this.live, ...this.stragglers()];
    const ending = [...this.live];
    for (const r of this.live) this.stop(r, r.runId, { reason: STOP_REASONS.shutdown });
    const deadline = performance.now() + graceMs;
    while (runs.some((r) => r.handle.alive()) && performance.now() < deadline) await Bun.sleep(20);
    this.forceKillAll(runs);
    // Let the killed runs report (run log, host log) before the state is saved for the last time.
    await Promise.race([Promise.all(ending.map((r) => r.handle.done)), Bun.sleep(1000)]);
    this.persist?.flush();
    this.persist?.close();
  }

  /**
   * Synchronous last resort (process 'exit' handler): SIGKILL every running or dying action. Their
   * entries stay in the state file, so the next host says those runs were interrupted.
   */
  forceKillAll(runs: Iterable<Straggler> = [...this.live, ...this.stragglers()]) {
    for (const r of runs) if (r.handle.alive()) r.handle.forceKill();
    this.persist?.flush();
  }

  private log(m: string) {
    this.opts.log?.(m);
  }

  private machineOpts(slot: Slot) {
    return { whileRunning: slot.button.whileRunning, resultHoldMs: slot.button.resultHoldMs };
  }

  /**
   * Whether a press may start (or, `starts` false, queue) a run of `key` now: never two instances
   * of a button at once, at most maxRunning runs, and the rate limits (the source's, then the
   * global one; a token is taken from both only when both have one).
   */
  private gate(key: string, starts: boolean, source?: PressSource): 'dying' | 'busy' | 'rate' | undefined {
    if (starts) {
      // An earlier run of this key is still on its way out: one of a removed-and-re-added button, a
      // killed run's process group in its grace period, or a leftover of the previous host.
      if ([...this.live, ...this.stragglers()].some((r) => r.key === key)) return 'dying';
      if (this.live.size >= this.limits.maxRunning) {
        this.refusals.note(`refusing presses: ${this.live.size} actions are running (max ${this.limits.maxRunning})`);
        return 'busy';
      }
    }
    if (source && !source.buckets.every((b) => b.available())) {
      this.refusals.note(`refusing presses from ${source.label}: too many (max ${this.limits.sourceBurst} at once, then ${this.limits.sourcePerSec}/s per device)`);
      return 'rate';
    }
    if (!this.bucket.available()) {
      this.refusals.note(`refusing presses: too many from all devices together (max ${this.limits.burst} at once, then ${this.limits.perSec}/s)`);
      return 'rate';
    }
    for (const b of source?.buckets ?? []) b.take();
    this.bucket.take();
    return undefined;
  }

  /** The dying runs, minus those whose process group is gone or got its SIGKILL meanwhile. */
  private stragglers(): Straggler[] {
    for (const r of this.dying) if (!r.handle.dying()) this.dying.delete(r);
    return [...this.dying];
  }

  private kill(slot: Slot, runId: number): boolean {
    return slot.run?.runId === runId && slot.run.handle.kill();
  }

  /**
   * Kill `run` (if it is run `runId`), saying why: RunRecord.error, and the text to show instead of
   * its output. A reason it already has (an earlier kill) stays. Whether the kill reached it.
   */
  private stop(run: LiveRun | undefined, runId: number, why: { reason: string; source?: string; text?: string }): boolean {
    if (!run || run.runId !== runId) return false;
    const before = { stopReason: run.stopReason, stopSource: run.stopSource, stopText: run.stopText };
    // Said before the kill, which may end the run at once.
    run.stopReason ??= why.reason;
    if (why.source !== undefined) run.stopSource ??= why.source;
    if (why.text !== undefined) run.stopText ??= why.text;
    if (run.handle.kill()) return true;
    Object.assign(run, before);
    return false;
  }

  private memo(key: string): ButtonMemo {
    let m = this.memos.get(key);
    if (!m) this.memos.set(key, (m = { lastRunId: 0 }));
    return m;
  }

  /** Forget the memos of buttons gone from the config, oldest first, beyond MAX_MEMOS. */
  private trimMemos() {
    for (const key of this.memos.keys()) {
      if (this.memos.size <= MAX_MEMOS) break;
      if (!this.slots.has(key)) this.memos.delete(key);
    }
  }

  private dispatch(slot: Slot, event: MachineEvent) {
    if (this.slots.get(slot.key) !== slot) return; // button was removed
    const [next, effects] = transition(slot.state, event, this.machineOpts(slot));
    this.apply(slot, next, effects);
  }

  private apply(slot: Slot, next: RunState, effects: Effect[]) {
    if (next !== slot.state) {
      slot.state = next;
      this.remember(slot.key, next);
      this.opts.onState?.(slot.key, next);
    }
    for (const e of effects) this.perform(slot, e);
  }

  /** Keep the memo (persisted) up to date: run ids and how the last run ended. */
  private remember(key: string, s: RunState) {
    const m = this.memo(key);
    let changed = false;
    if (s.runId > m.lastRunId) {
      m.lastRunId = s.runId;
      changed = true;
    }
    const last = lastOf(s);
    if (last && !sameLast(last, m.last)) {
      m.last = last;
      changed = true;
    }
    if (changed) this.persist?.request(true);
  }

  private perform(slot: Slot, e: Effect) {
    switch (e.type) {
      case 'start':
        clearTimeout(slot.requeueTimer);
        slot.requeueTimer = undefined;
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
      case 'scheduleRequeue':
        clearTimeout(slot.requeueTimer);
        slot.requeueTimer = setTimeout(() => this.requeue(slot, e.runId), Math.min(e.afterMs, MAX_DELAY_MS));
        break;
    }
  }

  /** The queued re-run's turn (its result has been on screen REQUEUE_GAP_MS). */
  private requeue(slot: Slot, runId: number) {
    slot.requeueTimer = undefined;
    if (this.closed || this.slots.get(slot.key) !== slot) return;
    // Never two instances at once, and no more than maxRunning: wait for the earlier processes, or a free slot.
    if ([...this.live, ...this.stragglers()].some((r) => r.key === slot.key) || this.live.size >= this.limits.maxRunning) {
      slot.requeueTimer = setTimeout(() => this.requeue(slot, runId), REQUEUE_RETRY_MS);
      return;
    }
    this.dispatch(slot, { type: 'requeue', runId, now: this.now() });
  }

  /** `stops`: cancel the running buttons it names (never itself), dropping their queued re-runs. How many it stopped. */
  private stopOthers(self: Slot): number {
    const patterns = self.button.stops ?? [];
    const by = self.button.label || self.button.id;
    let n = 0;
    for (const slot of this.slots.values()) {
      if (slot === self || !matchesStop(patterns, slot.pad, slot.button.id)) continue;
      const s = slot.state;
      if (s.phase === 'running') {
        // The machine's cancel, whatever the button's own whileRunning: kill, and drop a queued re-run.
        const [next, effects] = transition(s, { type: 'press', now: this.now() }, { whileRunning: 'cancel', resultHoldMs: slot.button.resultHoldMs });
        const kill = effects.find((e) => e.type === 'kill');
        if (kill) {
          // Exited already, output still draining: it ends as what it was.
          if (!this.stop(slot.run, kill.runId, { reason: STOP_REASONS.by(by), text: clip(`Stopped by ${by}`) })) continue;
          n++;
        }
        this.apply(slot, next, effects.filter((e) => e !== kill));
      } else if (s.phase !== 'ready' && s.queued) {
        // Its result is showing and a re-run is about to start: drop the re-run.
        clearTimeout(slot.requeueTimer);
        slot.requeueTimer = undefined;
        const next = { ...s };
        delete next.queued;
        this.apply(slot, next, [{ type: 'scheduleReset', runId: s.runId, afterMs: slot.button.resultHoldMs }]);
      }
    }
    return n;
  }

  private addRecord(key: string, record: RunRecord) {
    const list = this.history.get(key) ?? [];
    list.unshift(record);
    list.length = Math.min(list.length, HISTORY_SIZE);
    this.history.set(key, list);
  }

  private startRun(slot: Slot, runId: number) {
    const b = slot.button;
    const startedAt = slot.state.phase === 'running' ? slot.state.startedAt : this.now();
    // Before its own action starts.
    const stopped = b.stops?.length ? this.stopOthers(slot) : 0;
    const record: RunRecord = { runId, pad: slot.pad, button: b.id, startedAt, stdout: '', stderr: '' };
    this.addRecord(slot.key, record);

    let run: LiveRun | undefined;
    const hooks: RunHooks = {
      onUpdate: (u) => run && this.update(slot, run, u),
      onExit: (o) => run && this.finishRun(slot, run, o),
    };
    const handle =
      b.action.type === 'none'
        ? finishedRun({ text: stopped ? `Stopped ${stopped}` : 'Done' }, hooks)
        : this.spawn(
            {
              action: b.action,
              baseDir: this.opts.baseDir,
              timeoutMs: b.timeoutMs,
              env: { BUTTPAD_PAD: slot.pad, BUTTPAD_BUTTON: b.id, BUTTPAD_RUN_ID: String(runId), BUTTPAD_LABEL: b.label },
            },
            hooks,
          );
    run = { runId, key: slot.key, handle, record, t0: this.clock(), timeoutMs: b.timeoutMs };
    if (handle.command !== undefined) record.command = handle.command;
    if (handle.cwd !== undefined) record.cwd = handle.cwd;
    slot.run = run;
    this.live.add(run);
    if (this.persist && handle.pid !== undefined) this.track(run, handle.pid);
    this.opts.onRunStart?.(slot.key, runId, b);
  }

  /** List a spawned run in buttpad.state.json, with what a restarted host needs to find it again. */
  private track(run: LiveRun, pid: number) {
    const entry: LiveEntry = { key: run.key, runId: run.runId, pid, pgid: pid, startedAt: run.record.startedAt };
    if (run.record.command !== undefined) entry.command = run.record.command;
    if (run.record.cwd !== undefined) entry.cwd = run.record.cwd;
    const fp = process.platform === 'linux' ? processFingerprint(pid) : undefined;
    if (fp) entry.fingerprint = fp;
    else
      void processFingerprintAsync(pid).then((f) => {
        if (!f || !this.liveEntries.has(entry)) return;
        entry.fingerprint = f;
        this.persist?.request(true);
      });
    run.entry = entry;
    this.liveEntries.add(entry);
    this.persist?.request(true);
  }

  private update(slot: Slot, run: LiveRun, u: RunUpdate) {
    if (this.slots.get(slot.key) !== slot) return; // button was removed
    if (u.latched !== undefined) this.setLatched(slot.key, u.latched);
    if (u.progress !== undefined || u.status !== undefined) this.dispatch(slot, { type: 'progress', runId: run.runId, progress: u.progress, status: u.status });
  }

  private setLatched(key: string, text: string | null) {
    const t = text ? clip(sanitize(text), LATCHED_MAX) : '';
    const m = this.memo(key);
    if ((m.latched ?? '') === t) return;
    if (t) m.latched = t;
    else delete m.latched;
    this.opts.onLatched?.(key, t || null);
    this.persist?.request();
  }

  private finishRun(slot: Slot, run: LiveRun, o: RunOutcome) {
    const s = slot.state;
    const cancelling = s.phase === 'running' && s.runId === run.runId && !!s.cancelling;
    const shutdownKill = this.closed && run.stopReason === STOP_REASONS.shutdown;
    const rec = run.record;
    rec.endedAt = this.now();
    rec.exitCode = o.exitCode;
    rec.reason = shutdownKill ? 'interrupted' : run.stopReason || run.orphaned || cancelling ? 'cancelled' : (o.reason ?? 'exit');
    const error =
      run.stopReason ?? (o.reason === 'timeout' ? `timed out after ${duration(run.timeoutMs)}` : o.reason === 'spawn' ? (o.error ?? o.text) : undefined);
    if (error !== undefined) rec.error = error;
    rec.stdout = o.stdout;
    rec.stderr = o.stderr;
    this.live.delete(run);
    if (run.handle.dying()) this.dying.add(run);
    if (slot.run === run) slot.run = undefined;
    const text = run.stopText ?? o.text;
    const exit: MachineEvent = { type: 'exit', runId: run.runId, now: rec.endedAt, exitCode: o.exitCode, text, reason: o.reason };
    if (run.entry) {
      if (shutdownKill) {
        // Stays listed: the next host reports it as interrupted.
        run.entry.stopped = 'shutdown';
        run.entry.endedAt = rec.endedAt;
      } else {
        this.liveEntries.delete(run.entry);
        // Ended on its own while the host shut down: remember how, as the machine would have shown it.
        if (this.closed && this.slots.get(slot.key) === slot) this.remember(slot.key, transition(s, exit, this.machineOpts(slot))[0]);
      }
      this.persist?.request(true);
    }
    this.opts.onRunEnd?.(run.key, rec, o, { stopSource: run.stopSource });
    if (this.closed) return;
    this.dispatch(slot, exit);
  }

  private removeSlot(slot: Slot) {
    clearTimeout(slot.resetTimer);
    clearTimeout(slot.requeueTimer);
    this.slots.delete(slot.key);
    const run = slot.run;
    if (run && this.stop(run, run.runId, { reason: STOP_REASONS.removed })) run.orphaned = true;
    // A button that's gone has no device state to show.
    const m = this.memos.get(slot.key);
    if (m?.latched) {
      delete m.latched;
      this.opts.onLatched?.(slot.key, null);
      this.persist?.request();
    }
  }

  /** Read buttpad.state.json (at construction). */
  private load(path: string) {
    const clean = (s: string, max: number) => clip(sanitize(s), max);
    const r = loadState(path, clean);
    this.hostId = { pid: process.pid, fingerprint: processFingerprint(process.pid) };
    if (!r.ok) {
      this.log(r.missing ? `state: no ${path} yet; starting fresh` : `state: can't use ${path} (${r.error}); starting fresh`);
    } else {
      for (const [key, memo] of Object.entries(r.state.buttons)) this.memos.set(key, memo);
      // Ids continue past every run it knew, finished or not.
      for (const e of r.state.live) {
        const m = this.memo(e.key);
        m.lastRunId = Math.max(m.lastRunId, e.runId);
      }
      const prev = r.state.host;
      // Another host that is still running wrote it (two hosts on one config): its runs are its own.
      if (prev && prev.pid !== process.pid && prev.fingerprint && processFingerprint(prev.pid) === prev.fingerprint) {
        this.log(`state: ${path} belongs to another ButtPad host that is still running (pid ${prev.pid}); this one won't save run state or touch that host's actions`);
        return;
      }
      this.toRecover = r.state.live;
    }
    this.persist = new StateFile(path, () => this.snapshot(), { log: (m) => this.log(m), write: this.opts.stateWrite, clock: this.clock });
  }

  private snapshot(): PersistedState {
    const buttons: Record<string, ButtonMemo> = {};
    for (const [key, m] of this.memos) {
      const memo: ButtonMemo = { lastRunId: m.lastRunId };
      if (m.last) memo.last = m.last;
      if (m.latched) memo.latched = m.latched;
      buttons[key] = memo;
    }
    // Leftovers not yet recovered stay listed, so a crash before recover() loses nothing.
    return { version: 1, savedAt: this.now(), host: this.hostId, buttons, live: [...this.toRecover, ...this.liveEntries] };
  }
}

/** One host log line for a finished run. */
export function runEndLine(key: string, rec: RunRecord, o: RunOutcome, stopSource?: string): string {
  const secs = `${(o.durationMs / 1000).toFixed(1)}s`;
  const text = o.text && rec.reason !== 'spawn' ? `: ${o.text}` : '';
  const head = `${key} #${rec.runId} ${secs}`;
  switch (rec.reason) {
    case 'exit':
      return o.exitCode === 0 ? `✓ ${head}${text}` : `✗ ${head} exit ${o.exitCode ?? o.signal}${text}`;
    case 'spawn':
      return `✗ ${head} could not start: ${rec.error ?? o.text ?? 'spawn failed'}`;
    case 'timeout':
      return `✗ ${head} ${rec.error ?? 'timed out'}${text}`;
    default:
      return `■ ${head} ${rec.error ?? rec.reason}${rec.error === STOP_REASONS.device && stopSource ? ` (${stopSource})` : ''}${text}`;
  }
}
