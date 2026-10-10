/**
 * In-browser backend: runs the real state machine (core/machine.ts) with simulated actions, so the
 * UI can be tried with no host. Config lives in localStorage. Mirrors host semantics: ack first,
 * then state; whileRunning; timeouts; cancel = kill; result text rules; last 20 runs per button.
 */
import { buttonKey, findButton, parseConfig, type Button, type Config } from '../../core/config.ts';
import { initialState, transition, type Effect, type MachineEvent, type RunState } from '../../core/machine.ts';
import type { PressResult, RunRecord } from '../../core/protocol.ts';
import { KEYS, lsJSON, lsSet } from '../lib/settings.ts';
import { createStore } from '../lib/store.ts';
import { DEMO_CONFIG } from './demo-config.ts';
import { simulate, type SimHandle } from './demo-script.ts';
import { emptySnapshot, type Backend, type SaveResult, type Snapshot } from './types.ts';

interface Run {
  handle: SimHandle;
  stdout: string[];
  stderr: string[];
  result?: string;
  timeout?: ReturnType<typeof setTimeout>;
  done: boolean;
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
  private runs_ = new Map<string, Run>();
  private history = new Map<string, RunRecord[]>();
  private resets = new Map<string, ReturnType<typeof setTimeout>>();
  private online = true;
  private dropping = 0;
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
      host: { name: 'Demo (in this browser)', version: 'demo', platform: 'browser' },
    });
  }

  private setState(key: string, s: RunState) {
    this.states.set(key, s);
    if (this.online) this.snapshot.set((snap) => ({ ...snap, states: { ...snap.states, [key]: s } }));
  }

  private feed(pad: string, b: Button, e: MachineEvent) {
    const key = buttonKey(pad, b.id);
    const [next, effects] = transition(this.states.get(key) ?? initialState(), e, b);
    this.setState(key, next);
    for (const fx of effects) this.perform(pad, b, fx);
  }

  private perform(pad: string, b: Button, fx: Effect) {
    const key = buttonKey(pad, b.id);
    if (fx.type === 'scheduleReset') {
      clearTimeout(this.resets.get(key));
      this.resets.set(key, setTimeout(() => this.feed(pad, this.button(pad, b.id) ?? b, { type: 'reset', runId: fx.runId }), fx.afterMs));
    } else if (fx.type === 'start') this.start(pad, b, fx.runId);
    else this.kill(key);
  }

  private button(pad: string, id: string) {
    return findButton(this.config, pad, id);
  }

  private start(pad: string, b: Button, runId: number) {
    const key = buttonKey(pad, b.id);
    const startedAt = Date.now();
    const record: RunRecord = { runId, pad, button: b.id, startedAt, stdout: '', stderr: '' };
    const list = [record, ...(this.history.get(key) ?? [])].slice(0, 20);
    this.history.set(key, list);
    const run: Run = { handle: { kill() {} }, stdout: [], stderr: [], done: false, finish: (c, r) => finish(c, r) };
    this.runs_.set(key, run);
    const finish = (exitCode: number | null, reason?: 'timeout') => {
      if (run.done) return;
      run.done = true;
      clearTimeout(run.timeout);
      if (this.runs_.get(key) === run) this.runs_.delete(key);
      const out = run.stdout.filter((l) => l.trim() && !l.startsWith('@'));
      const err = run.stderr.filter((l) => l.trim());
      let text = run.result ?? out.at(-1);
      if (text === undefined && exitCode !== 0) text = err.at(-1);
      Object.assign(record, { endedAt: Date.now(), exitCode, reason: reason ?? (exitCode === 0 ? undefined : 'exit'), stdout: tail(run.stdout), stderr: tail(run.stderr) });
      this.feed(pad, this.button(pad, b.id) ?? b, { type: 'exit', runId, now: Date.now(), exitCode, text: text?.slice(0, 200), reason });
      const after = this.states.get(key);
      if (after?.phase === 'failure' && after.runId === runId) record.reason = after.reason;
    };
    run.handle = simulate(b.action, {
      exact: this.opts.exact,
      line: (text, stream) => {
        if (run.done) return;
        if (stream === 'stderr') return void run.stderr.push(text);
        run.stdout.push(text);
        const m = /^@(progress|status|result)\s*(.*)$/.exec(text);
        if (!m) return;
        if (m[1] === 'result') run.result = m[2];
        else this.feed(pad, this.button(pad, b.id) ?? b, { type: 'progress', runId, ...(m[1] === 'progress' ? { progress: Number(m[2]) || 0 } : { status: m[2] }) });
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

  press(pad: string, button: string): Promise<PressResult> {
    if (!this.online || this.disposed) return Promise.reject(new Error('offline'));
    if (this.dropping > 0) {
      this.dropping--;
      return new Promise(() => {});
    }
    const latency = this.opts.exact ? 10 : 20 + Math.random() * 60;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (!this.online) return reject(new Error('offline'));
        const b = this.button(pad, button);
        if (!b) return resolve('unknown-button');
        const s = this.states.get(buttonKey(pad, b.id)) ?? initialState();
        const result: PressResult =
          s.phase !== 'running' ? 'started' : b.whileRunning === 'cancel' ? (s.cancelling ? 'ignored' : 'cancelling') : b.whileRunning === 'queue' ? 'queued' : 'ignored';
        resolve(result);
        // The host acks first, then broadcasts the state change.
        setTimeout(() => this.feed(pad, b, { type: 'press', now: Date.now() }), 0);
      }, latency);
    });
  }

  kick(): void {}

  async saveConfig(config: Config, baseRev: string): Promise<SaveResult> {
    const current = rev(JSON.stringify(this.config));
    if (baseRev !== current) return { ok: false, kind: 'conflict', rev: current };
    const r = parseConfig(config);
    if (!r.ok) return { ok: false, kind: 'invalid', errors: r.errors };
    // Removing a running button kills it.
    for (const [key] of this.runs_) {
      const [pad, id] = key.split('/') as [string, string];
      if (!findButton(r.config, pad, id)) this.kill(key);
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
    if (!online) this.snapshot.set((s) => ({ ...s, status: 'offline', retryAt: Date.now() + 1000 }));
    else this.publish('online');
  }

  isOnline(): boolean {
    return this.online;
  }

  /** The next n presses vanish without an ack (to see "NO RESPONSE"). */
  dropAcks(n = 1): void {
    this.dropping = n;
  }

  /** Back to the starter pads. */
  reset(): void {
    for (const key of [...this.runs_.keys()]) this.kill(key);
    lsSet(KEYS.demoConfig, null);
    this.config = loadDemoConfig();
    this.states.clear();
    this.publish(this.online ? 'online' : 'offline');
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.runs_.values()) r.handle.kill();
    for (const t of this.resets.values()) clearTimeout(t);
  }
}
