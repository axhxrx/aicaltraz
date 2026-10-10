/**
 * In-browser backend: runs the real state machine (core/machine.ts) with simulated actions, so the
 * UI can be tried with no host. Config lives in localStorage. Mirrors host semantics: ack first
 * (with the run's id), then state; whileRunning (a press on an already queued run is `ignored`);
 * a queued re-run REQUEUE_GAP_MS after the result shows; timeouts; cancel = kill; `stops`; the
 * `none` action; `confirm` buttons refuse presses without `confirm` (`needs-confirm`); presses older
 * than PRESS_MAX_AGE_MS are `expired`; `@state` lines latch; result text rules; last 20 runs per
 * button; and when a press gets `ignored` (cancel within 700 ms of the start, the start rate limit).
 *
 * The demo's "host clock" is the page's own (lib/clock.ts), so clockSkew is 0.
 */
import { buttonKey, findButton, parseConfig, type Button, type Config } from '../../core/config.ts';
import { initialState, transition, type Effect, type MachineEvent, type RunState } from '../../core/machine.ts';
import { PRESS_MAX_AGE_MS, type PressResult, type RunRecord } from '../../core/protocol.ts';
import { wall } from '../lib/clock.ts';
import { mono } from '../lib/env.ts';
import { KEYS, lsJSON, lsSet } from '../lib/settings.ts';
import { createStore } from '../lib/store.ts';
import { DEMO_CONFIG } from './demo-config.ts';
import { simulate, type SimHandle } from './demo-script.ts';
import { CANCEL_GRACE_MS, emptySnapshot, PressError, type Backend, type PressAck, type PressOpts, type SaveResult, type Snapshot } from './types.ts';

/**
 * As on the host for one connection (src/server/limits.ts): presses that start or queue a run,
 * over all buttons, bursts of 10, then 5/s (the host's global 40 then 20/s takes more than one
 * device); 32 runs at once.
 */
const LIMITS = { burst: 10, perSec: 5, maxRunning: 32 };

interface Run {
  handle: SimHandle;
  stdout: string[];
  stderr: string[];
  result?: string;
  timeout?: ReturnType<typeof setTimeout>;
  done: boolean;
  /** mono() at start. */
  t0: number;
  /** Stopped by another button's `stops`: its result text says by which. */
  stoppedBy?: string;
  finish(exitCode: number | null, reason?: 'timeout'): void;
}

/** FNV-1a, 64-bit-ish, hex: crypto.subtle isn't available on plain-http LAN pages. */
function rev(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 16);
}

const TAIL = 16 * 1024;
const tail = (lines: string[]) => lines.join('\n').slice(-TAIL);

/** `pad/button`, `pad/*` or `*` (config.ts STOP_PATTERN) against a button key. */
const stopMatches = (pattern: string, key: string) => pattern === '*' || pattern === key || (pattern.endsWith('/*') && key.startsWith(pattern.slice(0, -1)));

export function loadDemoConfig(): Config {
  const stored = lsJSON<unknown>(KEYS.demoConfig);
  if (stored) {
    const r = parseConfig(stored);
    if (r.ok) return r.config;
  }
  const r = parseConfig(DEMO_CONFIG);
  if (!r.ok) throw new Error(`demo config invalid: ${r.errors.join('; ')}`);
  lsSet(KEYS.demoConfig, JSON.stringify(DEMO_CONFIG));
  return r.config;
}

export class DemoBackend implements Backend {
  readonly kind = 'demo';
  readonly snapshot = createStore<Snapshot>(emptySnapshot());
  private config: Config;
  private states = new Map<string, RunState>();
  private latched = new Map<string, string>();
  private runs_ = new Map<string, Run>();
  private history = new Map<string, RunRecord[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private online = true;
  private dropping = 0;
  /** The next press reaches the "host" this much later (it sat in a dead link). */
  private delayNext = 0;
  /** Presses whose ack was dropped: the link "drops" under them when going offline. */
  private lostAcks = new Set<(e: Error) => void>();
  private tokens = LIMITS.burst;
  private tokensAt = mono();
  private disposed = false;

  constructor(private readonly opts: { exact: boolean } = { exact: false }) {
    this.config = loadDemoConfig();
    this.publish('online');
  }

  private publish(status: Snapshot['status']) {
    this.snapshot.set({
      ...emptySnapshot(),
      status,
      role: 'admin',
      config: this.config,
      rev: rev(JSON.stringify(this.config)),
      states: Object.fromEntries(this.states),
      latched: Object.fromEntries(this.latched),
      host: { name: 'Demo (in this browser)', version: 'demo', platform: 'browser' },
    });
  }

  private setState(key: string, s: RunState) {
    this.states.set(key, s);
    if (this.online) this.snapshot.set((snap) => ({ ...snap, states: { ...snap.states, [key]: s } }));
  }

  private latch(key: string, text: string) {
    if (text) this.latched.set(key, text);
    else this.latched.delete(key);
    if (this.online) this.snapshot.set((snap) => ({ ...snap, latched: Object.fromEntries(this.latched) }));
  }

  private feed(pad: string, b: Button, e: MachineEvent) {
    const key = buttonKey(pad, b.id);
    const [next, effects] = transition(this.states.get(key) ?? initialState(), e, b);
    this.setState(key, next);
    for (const fx of effects) this.perform(pad, b, fx);
  }

  private later(key: string, ms: number, fn: () => void) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(fn, ms));
  }

  private perform(pad: string, b: Button, fx: Effect) {
    const key = buttonKey(pad, b.id);
    const now = () => this.button(pad, b.id) ?? b;
    if (fx.type === 'scheduleReset') this.later(key, fx.afterMs, () => this.feed(pad, now(), { type: 'reset', runId: fx.runId }));
    else if (fx.type === 'scheduleRequeue') this.later(key, fx.afterMs, () => this.feed(pad, now(), { type: 'requeue', runId: fx.runId, now: wall() }));
    else if (fx.type === 'start') this.start(pad, now(), fx.runId);
    else this.kill(key);
  }

  private button(pad: string, id: string) {
    return findButton(this.config, pad, id);
  }

  private start(pad: string, b: Button, runId: number) {
    const key = buttonKey(pad, b.id);
    // Before its own action starts (a queued re-run's too).
    const stopped = this.stopOthers(key, b);
    const startedAt = wall();
    const record: RunRecord = { runId, pad, button: b.id, startedAt, stdout: '', stderr: '' };
    const list = [record, ...(this.history.get(key) ?? [])].slice(0, 20);
    this.history.set(key, list);
    const run: Run = { handle: { kill() {} }, stdout: [], stderr: [], done: false, t0: mono(), finish: (c, r) => finish(c, r) };
    this.runs_.set(key, run);
    const finish = (exitCode: number | null, reason?: 'timeout') => {
      if (run.done) return;
      run.done = true;
      clearTimeout(run.timeout);
      if (this.runs_.get(key) === run) this.runs_.delete(key);
      const out = run.stdout.filter((l) => l.trim() && !l.startsWith('@'));
      const err = run.stderr.filter((l) => l.trim());
      let text = run.stoppedBy ?? run.result ?? out.at(-1);
      if (text === undefined && exitCode !== 0) text = err.at(-1);
      Object.assign(record, { endedAt: wall(), exitCode, reason: reason ?? (exitCode === 0 ? undefined : 'exit'), stdout: tail(run.stdout), stderr: tail(run.stderr) });
      if (run.stoppedBy) record.error = run.stoppedBy;
      this.feed(pad, this.button(pad, b.id) ?? b, { type: 'exit', runId, now: wall(), exitCode, text: text?.slice(0, 200), reason });
      const after = this.states.get(key);
      if (after?.phase === 'failure' && after.runId === runId) record.reason = after.reason;
    };
    // Runs nothing and succeeds at once: what it did was stop the others.
    if (b.action.type === 'none') {
      record.command = '(nothing)';
      run.result = stopped ? `Stopped ${stopped}` : 'Done';
      queueMicrotask(() => finish(0));
      return;
    }
    run.handle = simulate(b.action, {
      exact: this.opts.exact,
      line: (text, stream) => {
        if (run.done) return;
        if (stream === 'stderr') return void run.stderr.push(text);
        run.stdout.push(text);
        const m = /^@(progress|status|result|state)(?:\s+(.*))?$/.exec(text);
        if (!m) return;
        const arg = (m[2] ?? '').trim();
        if (m[1] === 'result') run.result = arg;
        else if (m[1] === 'state') this.latch(key, arg.slice(0, 40));
        else this.feed(pad, this.button(pad, b.id) ?? b, { type: 'progress', runId, ...(m[1] === 'progress' ? { progress: Number(arg) || 0 } : { status: arg }) });
      },
      exit: (code) => finish(code),
    });
    run.timeout = setTimeout(() => {
      run.handle.kill();
      finish(null, 'timeout');
    }, b.timeoutMs);
  }

  private kill(key: string) {
    const run = this.runs_.get(key);
    if (!run) return;
    run.handle.kill();
    // Like SIGTERM: the process takes a moment to die.
    setTimeout(() => run.finish(null), this.opts.exact ? 50 : 150 + Math.random() * 250);
  }

  press(pad: string, button: string, opts: PressOpts = {}): Promise<PressResult> {
    if (!this.online || this.disposed) return Promise.reject(new PressError(false, 'not connected to the host'));
    const at = wall();
    opts.onSent?.();
    if (this.dropping > 0) {
      this.dropping--;
      // Lost on the way: no ack, ever (until the "link" drops: see setOnline).
      return new Promise((_, reject) => void this.lostAcks.add(reject));
    }
    const latency = (this.opts.exact ? 10 : 20 + Math.random() * 60) + this.delayNext;
    this.delayNext = 0;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (!this.online || this.disposed) return reject(new PressError(true, 'the link to the host dropped before it answered'));
        const ack = this.handle(pad, button, at, !!opts.confirm);
        opts.onAck?.(ack);
        resolve(ack.result);
      }, latency);
    });
  }

  /** The host's side of a press: decide, answer, then act (an ignored press changes nothing). */
  private handle(pad: string, button: string, at: number, confirm: boolean): PressAck {
    const b = this.button(pad, button);
    if (!b) return { result: 'unknown-button' };
    if (wall() - at > PRESS_MAX_AGE_MS) return { result: 'expired' };
    const key = buttonKey(pad, b.id);
    const s = this.states.get(key) ?? initialState();
    // A queued re-run is coming already (still running, or showing the result before it starts).
    if (s.phase !== 'ready' && s.queued && (s.phase !== 'running' || b.whileRunning === 'queue')) return { result: 'ignored' };
    const starts = s.phase !== 'running' || b.whileRunning === 'queue';
    if (b.confirm && starts && !confirm) return { result: 'needs-confirm' };
    const result = this.decide(key, b);
    if (result === 'ignored') return { result };
    const runId = s.phase === 'running' ? s.runId : s.runId + 1;
    this.feed(pad, b, { type: 'press', now: wall() });
    return { result, runId };
  }

  /** `stops`: cancels the running buttons `b.stops` names (never itself), dropping queued re-runs; how many it stopped. */
  private stopOthers(self: string, b: Button): number {
    if (!b.stops?.length) return 0;
    const by = b.label || b.id;
    let n = 0;
    for (const [key, s] of this.states) {
      if (key === self || !b.stops.some((p) => stopMatches(p, key))) continue;
      const [pad, id] = key.split('/') as [string, string];
      const other = this.button(pad, id);
      if (!other) continue;
      const run = this.runs_.get(key);
      if (s.phase === 'running' && run && !s.cancelling) {
        run.stoppedBy = `Stopped by ${by}`;
        const [next, effects] = transition(s, { type: 'press', now: wall() }, { ...other, whileRunning: 'cancel' });
        this.setState(key, next);
        for (const fx of effects) this.perform(pad, other, fx);
        n++;
      } else if (s.phase !== 'ready' && s.phase !== 'running' && s.queued) {
        // Its result is showing and a re-run is about to start: drop the re-run.
        const { queued: _q, ...next } = s;
        this.setState(key, next);
        this.perform(pad, other, { type: 'scheduleReset', runId: s.runId, afterMs: other.resultHoldMs });
      }
    }
    return n;
  }

  /** The host's answer to a press (src/server/state-store.ts, press()). */
  private decide(key: string, b: Button): PressResult {
    const s = this.states.get(key) ?? initialState();
    if (s.phase !== 'running') return this.runs_.size < LIMITS.maxRunning && this.takeStart() ? 'started' : 'ignored';
    if (b.whileRunning === 'cancel') {
      // A double press would start the run and cancel it right away. Already cancelling: says so again.
      const run = this.runs_.get(key);
      return !s.cancelling && run && mono() - run.t0 < CANCEL_GRACE_MS ? 'ignored' : 'cancelling';
    }
    // Already queued: nothing changes (the UI says ALREADY QUEUED).
    if (b.whileRunning === 'queue') return !s.queued && this.takeStart() ? 'queued' : 'ignored';
    return 'ignored';
  }

  /** Token bucket for presses that start (or queue) a run. */
  private takeStart(): boolean {
    const now = mono();
    this.tokens = Math.min(LIMITS.burst, this.tokens + ((now - this.tokensAt) / 1000) * LIMITS.perSec);
    this.tokensAt = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  kick(): void {}

  async getConfig(): Promise<{ config: Config; rev: string }> {
    if (!this.online || this.disposed) throw new Error('not connected to the host');
    return { config: this.config, rev: rev(JSON.stringify(this.config)) };
  }

  async saveConfig(config: Config, baseRev: string, { force = false } = {}): Promise<SaveResult> {
    const current = rev(JSON.stringify(this.config));
    if (baseRev !== current && !force) return { ok: false, kind: 'conflict', rev: current };
    const r = parseConfig(config);
    if (!r.ok) return { ok: false, kind: 'invalid', errors: r.errors };
    // Removing a running button kills it.
    for (const [key, run] of this.runs_) {
      const [pad, id] = key.split('/') as [string, string];
      if (findButton(r.config, pad, id)) continue;
      run.stoppedBy = 'Stopped: button removed by a config change';
      this.kill(key);
    }
    this.config = r.config;
    lsSet(KEYS.demoConfig, JSON.stringify(r.config));
    const next = rev(JSON.stringify(r.config));
    this.snapshot.set((s) => ({ ...s, config: r.config, rev: next, configErrors: null }));
    return { ok: true, rev: next };
  }

  async runs(q: { pad?: string; button?: string } = {}): Promise<RunRecord[]> {
    const all = [...this.history.values()].flat().filter((r) => (!q.pad || r.pad === q.pad) && (!q.button || r.button === q.button));
    return all.sort((a, b) => b.startedAt - a.startedAt).map((r) => ({ ...r }));
  }

  // ---- demo-only controls (menu + tests) ----

  /** Pretend the link to the host dropped (or came back, with a fresh "hello"). */
  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    if (online) return this.publish('online');
    this.snapshot.set((s) => ({ ...s, status: 'offline', retryAt: Date.now() + 1000, lastSeen: wall() }));
    const err = new PressError(true, 'the link to the host dropped before it answered');
    for (const reject of this.lostAcks) reject(err);
    this.lostAcks.clear();
  }

  isOnline(): boolean {
    return this.online;
  }

  /** The next n presses vanish without an ack (to see "NO RESPONSE"). */
  dropAcks(n = 1): void {
    this.dropping = n;
  }

  /** The next press reaches the "host" `ms` late, like one that sat in a dead link (> 3 s: `expired`). */
  delayNextPress(ms: number): void {
    this.delayNext = ms;
  }

  /**
   * The next press reaches the "host" and runs, but the link dies before the ack gets back (the
   * page shows offline until setOnline(true)).
   */
  dropLinkOnNextPress(): void {
    const press = this.press.bind(this);
    this.press = (pad, button, opts = {}) => {
      this.press = press;
      if (!this.online) return press(pad, button, opts);
      const at = wall();
      opts.onSent?.();
      this.setOnline(false);
      this.handle(pad, button, at, !!opts.confirm);
      return Promise.reject(new PressError(true, 'the link to the host dropped before it answered'));
    };
  }

  /** Like a host that crashed and came back: what was running ends INTERRUPTED. */
  restart(): void {
    for (const [key, run] of [...this.runs_]) {
      run.done = true;
      run.handle.kill();
      clearTimeout(run.timeout);
      this.runs_.delete(key);
      const s = this.states.get(key);
      if (s?.phase !== 'running') continue;
      const [pad, id] = key.split('/') as [string, string];
      const b = this.button(pad, id);
      const ended: RunState = { phase: 'failure', runId: s.runId, startedAt: s.startedAt, endedAt: wall(), exitCode: null, reason: 'interrupted', text: 'Interrupted: host restarted' };
      this.setState(key, ended);
      if (b) this.perform(pad, b, { type: 'scheduleReset', runId: s.runId, afterMs: b.resultHoldMs });
    }
    this.publish(this.online ? 'online' : 'offline');
  }

  /** Back to the starter pads. */
  reset(): void {
    for (const key of [...this.runs_.keys()]) this.kill(key);
    lsSet(KEYS.demoConfig, null);
    this.config = loadDemoConfig();
    this.states.clear();
    this.latched.clear();
    this.publish(this.online ? 'online' : 'offline');
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.runs_.values()) r.handle.kill();
    for (const t of this.timers.values()) clearTimeout(t);
  }
}
