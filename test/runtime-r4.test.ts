/**
 * Round-4 host runtime: a running button's changed `timeoutMs` applies to its run, per-button
 * `maxLatenessMs`, exclusive `group`s, the latched state of a run cut off by a crash marked "? ",
 * and the run log across restarts (buttpad.runs.json).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Config, type ConfigInput } from '../src/core/config.ts';
import type { RunState } from '../src/core/machine.ts';
import type { RunRecord } from '../src/core/protocol.ts';
import { startHost, type Host } from '../src/server/host.ts';
import { HISTORY_SIZE, MAX_RUN_ID, parseRuns, runsFileText, runsPathFor, SAVED_TAIL_BYTES, STATE_FILE, tailBytes, UNCERTAIN_PREFIX } from '../src/server/persist.ts';
import { processFingerprint } from '../src/server/proc.ts';
import { sanitize, startRun, type RunHandle, type RunHooks, type RunOutcome, type RunSpec, type RunUpdate } from '../src/server/runner.ts';
import { StateStore, stopsBeforeStart, type PressOptions, type StateStoreOptions } from '../src/server/state-store.ts';
import { cleanupTmp, isAlive, padConfig, readJson, TestClient, tmpDir, waitFor, writeJson } from './helpers.ts';

afterAll(cleanupTmp);

const posix = process.platform !== 'win32';
const shell = (script: string) => ({ type: 'shell' as const, script });
type Buttons = NonNullable<ConfigInput['pads'][number]['buttons']>;

class FakeRun implements RunHandle {
  pid: number | undefined = undefined;
  /** Ends (SIGTERM) when killed, as a real process would. */
  exitOnKill = false;
  kills = 0;
  finished = false;
  /** Every retime() call: the time left it was given. */
  readonly retimes: number[] = [];
  readonly done: Promise<RunOutcome>;
  private resolve!: (o: RunOutcome) => void;
  out = '';
  err = '';
  constructor(
    readonly spec: RunSpec,
    readonly hooks: RunHooks,
  ) {
    this.done = new Promise((r) => (this.resolve = r));
  }
  kill() {
    this.kills++;
    const ok = !this.finished;
    if (ok && this.exitOnKill) queueMicrotask(() => !this.finished && this.exit({ exitCode: null, signal: 'SIGTERM' }));
    return ok;
  }
  forceKill() {}
  retime(ms: number) {
    this.retimes.push(ms);
  }
  alive() {
    return !this.finished;
  }
  dying() {
    return false;
  }
  stdout() {
    return this.out;
  }
  stderr() {
    return this.err;
  }
  update(u: RunUpdate) {
    this.hooks.onUpdate?.(u);
  }
  exit(o: Partial<RunOutcome> = {}) {
    const out: RunOutcome = { exitCode: 0, signal: null, stdout: this.out, stderr: this.err, durationMs: 1, ...o };
    this.finished = true;
    this.hooks.onExit?.(out);
    this.resolve(out);
  }
}

function fakeStore(config: ConfigInput, opts: Partial<StateStoreOptions> = {}) {
  const runs: FakeRun[] = [];
  const logs: string[] = [];
  const states: [string, RunState][] = [];
  const clock = { now: 1_800_000_000_000, mono: 0 };
  const store = new StateStore(Config.parse(config), {
    baseDir: '/cfg',
    spawn: (spec, hooks) => {
      const r = new FakeRun(spec, hooks);
      runs.push(r);
      return r;
    },
    log: (m) => logs.push(m),
    onState: (k, s) => states.push([k, s]),
    now: () => clock.now,
    clock: () => clock.mono,
    cancelGraceMs: 0,
    limits: { burst: 1e9, perSec: 0, maxRunning: 1e9, sourceBurst: 1e9, sourcePerSec: 0 },
    ...opts,
  });
  const runOf = (key: string) => runs.find((r) => `${r.spec.env!.BUTTPAD_PAD}/${r.spec.env!.BUTTPAD_BUTTON}` === key && !r.finished);
  return { store, runs, logs, states, clock, runOf, press: (pad: string, b: string, o: PressOptions = {}) => store.press(pad, b, o) };
}

const hosts: Host[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});

async function hostWith(cfg: ConfigInput) {
  const dir = tmpDir('buttpad-r4-');
  const configPath = join(dir, 'buttpad.config.json');
  writeJson(configPath, cfg);
  const logs: string[] = [];
  const host = await startHost({ configPath, host: '127.0.0.1', port: 0, log: (m) => logs.push(m), debounceMs: 50 });
  hosts.push(host);
  const base = `http://127.0.0.1:${host.port}`;
  const api = (path: string, o: { method?: string; token?: string; body?: unknown } = {}) =>
    fetch(base + path, {
      method: o.method ?? 'GET',
      headers: { authorization: `Bearer ${o.token ?? host.secrets.adminToken}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  return { host, dir, configPath, base, api, logs };
}

/** PUT the config with one button changed (admin), as the editor does. */
async function editButton(api: Awaited<ReturnType<typeof hostWith>>['api'], pad: string, id: string, change: Record<string, unknown>) {
  const { config, rev } = (await (await api('/api/config')).json()) as { config: ConfigInput; rev: string };
  const b = config.pads.find((p) => p.id === pad)!.buttons!.find((x) => x.id === id)!;
  Object.assign(b, change);
  const r = await api('/api/config', { method: 'PUT', body: { config, baseRev: rev } });
  expect(r.status).toBe(200);
}

// ---------------------------------------------------------------------------------------------

describe('a changed timeoutMs applies to the run going on', () => {
  test('re-armed for what is left of the new limit; past it, it stops now; other changes wait for the next run', () => {
    const { store, runs, logs, clock, press } = fakeStore(padConfig([{ id: 'video', label: 'Video', x: 0, y: 0, timeoutMs: 150_000, action: shell('play opening.mp4') }]));
    press('p', 'video');
    const run = runs[0]!;
    clock.mono += 20_000;
    // Raised mid-show: 4 min from the start = 3:40 from now.
    const raised = padConfig([{ id: 'video', label: 'Video', x: 0, y: 0, timeoutMs: 240_000, action: shell('play opening.mp4') }]);
    store.setConfig(Config.parse(raised));
    expect(run.retimes).toEqual([220_000]);
    expect(logs.at(-1)).toBe('p/video #1: time limit 2.5 min → 4 min while it runs (3.7 min left)');
    // The same limit again (another field changed): nothing to re-arm; the action itself stays as started.
    store.setConfig(Config.parse(padConfig([{ id: 'video', label: 'Video!', x: 0, y: 0, timeoutMs: 240_000, action: shell('play other.mp4') }])));
    expect(run.retimes).toEqual([220_000]);
    expect(runs.length).toBe(1);
    expect(store.runs()[0]).toMatchObject({ runId: 1 });
    // Lowered below what it has run already: it times out now.
    clock.mono += 40_000;
    store.setConfig(Config.parse(padConfig([{ id: 'video', label: 'Video', x: 0, y: 0, timeoutMs: 30_000, action: shell('x') }])));
    expect(run.retimes).toEqual([220_000, -30_000]);
    expect(logs.at(-1)).toBe('p/video #1: time limit 4 min → 30 s, and it has run 60 s: stopping it');
    // The runner reports the time-out; the run log names the limit that was in force.
    run.exit({ exitCode: null, signal: 'SIGTERM', reason: 'timeout' });
    expect(store.get('p/video')).toMatchObject({ phase: 'failure', reason: 'timeout' });
    expect(store.runs()[0]).toMatchObject({ reason: 'timeout', error: 'timed out after 30 s' });
  });

  test('a run being cancelled keeps going down; action none has no limit', () => {
    const { store, runs, press } = fakeStore(
      padConfig([
        { id: 'a', x: 0, y: 0, whileRunning: 'cancel', timeoutMs: 10_000, action: shell('x') },
        { id: 'n', x: 1, y: 0, timeoutMs: 10_000, action: { type: 'none' } },
      ]),
    );
    press('p', 'a');
    expect(press('p', 'a').result).toBe('cancelling');
    store.setConfig(Config.parse(padConfig([{ id: 'a', x: 0, y: 0, whileRunning: 'cancel', timeoutMs: 100, action: shell('x') }, { id: 'n', x: 1, y: 0, timeoutMs: 100, action: { type: 'none' } }])));
    expect(runs[0]!.retimes).toEqual([]);
  });

  test.skipIf(!posix)('the real runner: retime() moves the deadline, ≤ 0 times out at once, after the end it does nothing', async () => {
    const t0 = performance.now();
    const h = startRun({ action: shell('sleep 5'), baseDir: tmpDir(), timeoutMs: 400 });
    await Bun.sleep(100);
    h.retime!(1000); // the deadline is now ~1.1 s after the start
    await Bun.sleep(500);
    expect(h.alive()).toBe(true); // past the original 400 ms
    const o = await h.done;
    const took = performance.now() - t0;
    expect(o.reason).toBe('timeout');
    expect(took).toBeGreaterThan(1000);
    expect(took).toBeLessThan(2500);

    const now = startRun({ action: shell('sleep 5'), baseDir: tmpDir(), timeoutMs: 60_000 });
    await Bun.sleep(50);
    const t1 = performance.now();
    now.retime!(0);
    expect((await now.done).reason).toBe('timeout');
    expect(performance.now() - t1).toBeLessThan(1500);

    const quick = startRun({ action: shell('true'), baseDir: tmpDir(), timeoutMs: 60_000 });
    const q = await quick.done;
    quick.retime!(-1);
    expect(q).toMatchObject({ exitCode: 0 });
    expect(q.reason).toBeUndefined();
  });

  test.skipIf(!posix)('over the wire (QA: a 3-min video with a 2:30 limit raised to 4 min mid-show was killed at 2:30)', async () => {
    const { api, host } = await hostWith(padConfig([{ id: 'video', label: 'Video', x: 0, y: 0, timeoutMs: 1200, resultHoldMs: 5000, action: shell('sleep 2; echo "@result video done"') }]));
    expect((await (await api('/api/press/p/video', { method: 'POST' })).json()).result).toBe('started');
    await Bun.sleep(300);
    await editButton(api, 'p', 'video', { timeoutMs: 4000 }); // saved "live" while it plays
    await waitFor(() => host.state.get('p/video')?.phase === 'success', 5000, 'the video to finish');
    expect(host.state.get('p/video')).toMatchObject({ phase: 'success', text: 'video done' });

    // Lowered under what it has run: stopped at once, as a time-out.
    expect((await (await api('/api/press/p/video', { method: 'POST' })).json()).result).toBe('started');
    await Bun.sleep(700);
    const t = performance.now();
    await editButton(api, 'p', 'video', { timeoutMs: 500 });
    await waitFor(() => host.state.get('p/video')?.phase === 'failure', 3000, 'the time-out');
    expect(performance.now() - t).toBeLessThan(1500);
    expect(host.state.get('p/video')).toMatchObject({ phase: 'failure', reason: 'timeout' });
    expect(host.state.runs()[0]).toMatchObject({ runId: 2, reason: 'timeout', error: 'timed out after 500 ms' });
  }, 15_000);
});

describe('maxLatenessMs: how late a press may reach the host, per button', () => {
  test('replaces the 3 s default for that button (WebSocket and HTTP `at` alike)', () => {
    const { runs, logs, clock, press } = fakeStore(
      padConfig([
        { id: 'patient', x: 0, y: 0, maxLatenessMs: 8000, action: shell('x') },
        { id: 'strict', label: 'GO', x: 1, y: 0, maxLatenessMs: 500, action: shell('x') },
        { id: 'default', x: 2, y: 0, action: shell('x') },
      ]),
    );
    expect(press('p', 'patient', { at: clock.now - 7000 }).result).toBe('started');
    expect(press('p', 'strict', { at: clock.now - 600 }).result).toBe('expired');
    expect(logs.at(-1)).toMatch(/^dropped a stale press of p\/strict: made 0\.6 s ago \(max 0\.5 s\)/);
    expect(press('p', 'strict', { at: clock.now - 500 }).result).toBe('started');
    expect(press('p', 'default', { at: clock.now - 3001 }).result).toBe('expired');
    expect(press('p', 'default', { at: clock.now - 2900 }).result).toBe('started');
    expect(runs.length).toBe(3);
  });

  test('over HTTP and WebSocket', async () => {
    const { host, api } = await hostWith(
      padConfig([
        { id: 'strict', x: 0, y: 0, maxLatenessMs: 300, action: shell('true') },
        { id: 'patient', x: 1, y: 0, maxLatenessMs: 9000, action: shell('true') },
      ]),
    );
    const late = Date.now() - 1000;
    expect((await (await api(`/api/press/p/strict?at=${late}`, { method: 'POST' })).json()).result).toBe('expired');
    expect((await (await api('/api/press/p/patient', { method: 'POST', body: { at: Date.now() - 6000 } })).json()).result).toBe('started');
    const c = await TestClient.connect(`ws://127.0.0.1:${host.port}/ws?token=${host.secrets.pressToken}`);
    clients.push(c);
    c.send({ t: 'press', id: 'w1', pad: 'p', button: 'strict', at: Date.now() - 400 });
    expect(await c.next('ack', (m) => m.id === 'w1')).toMatchObject({ result: 'expired' });
    c.send({ t: 'press', id: 'w2', pad: 'p', button: 'strict', at: Date.now() - 100 });
    expect(await c.next('ack', (m) => m.id === 'w2')).toMatchObject({ result: 'started' });
  });
});

describe('group: starting one stops the running buttons of its group', () => {
  const grouped = (): ConfigInput => ({
    version: 1,
    pads: [
      {
        id: 'show',
        name: 'Show',
        cols: 4,
        rows: 2,
        buttons: [
          { id: 'warm', label: 'Warm wash', x: 0, y: 0, group: 'wash', whileRunning: 'queue', action: shell('warm') },
          { id: 'cold', label: 'Cold wash', x: 1, y: 0, group: 'wash', action: shell('cold') },
          { id: 'bgm', label: 'BGM', x: 2, y: 0, group: 'audio', action: shell('bgm') },
          { id: 'free', label: 'Free', x: 3, y: 0, action: shell('free') },
          { id: 'blue', label: 'Blue wash', x: 0, y: 1, group: 'wash', stops: ['show/free'], action: shell('blue') },
          { id: 'wash-off', label: 'Wash off', x: 1, y: 1, group: 'wash', action: { type: 'none' } },
          { id: 'again', label: 'Again', x: 2, y: 1, group: 'wash', whileRunning: 'cancel', action: shell('again') },
        ],
      },
      { id: 'backup', name: 'Backup', cols: 1, rows: 1, buttons: [{ id: 'warm2', label: 'Warm (backup)', x: 0, y: 0, group: 'wash', action: shell('warm') }] },
    ],
  });

  test('exactly like stops: never itself, any pad, "Stopped by <label>", queues dropped, other groups untouched', () => {
    const { store, runOf, press } = fakeStore(grouped());
    press('show', 'warm');
    expect(press('show', 'warm').result).toBe('queued');
    press('show', 'bgm');
    press('show', 'free');
    // Another pad's member of the group.
    expect(press('backup', 'warm2')).toMatchObject({ result: 'started', runId: 1 });
    expect(runOf('show/warm')!.kills).toBe(1);
    expect(store.get('show/warm')).toMatchObject({ phase: 'running', cancelling: true });
    expect(store.get('show/warm')).not.toHaveProperty('queued');
    expect(runOf('show/bgm')!.kills).toBe(0);
    expect(runOf('show/free')!.kills).toBe(0);
    runOf('show/warm')!.exit({ exitCode: null, signal: 'SIGTERM' });
    expect(store.get('show/warm')).toMatchObject({ phase: 'failure', reason: 'cancelled', text: 'Stopped by Warm (backup)' });
    expect(store.runs({ pad: 'show', button: 'warm' })[0]).toMatchObject({ reason: 'cancelled', error: 'stopped by Warm (backup)' });
    // Back the other way.
    press('show', 'cold');
    expect(runOf('backup/warm2')!.kills).toBe(1);
  });

  test('combines with stops; a none member is the group off switch; a cancel press is a cancel', async () => {
    const { store, runOf, runs, press } = fakeStore(grouped());
    press('show', 'cold');
    press('show', 'free');
    press('show', 'bgm');
    press('show', 'blue'); // its group, and its stops
    expect(runOf('show/cold')!.kills).toBe(1);
    expect(runOf('show/free')!.kills).toBe(1);
    expect(runOf('show/bgm')!.kills).toBe(0);
    runOf('show/cold')!.exit({ exitCode: null });
    runOf('show/free')!.exit({ exitCode: null });
    expect(store.get('show/free')).toMatchObject({ text: 'Stopped by Blue wash' });
    expect(press('show', 'wash-off').result).toBe('started');
    expect(runOf('show/blue')!.kills).toBe(1);
    await waitFor(() => store.get('show/wash-off')?.phase === 'success', 1000, 'wash off');
    expect(store.get('show/wash-off')).toMatchObject({ text: 'Stopped 1' });
    // A member pressed again while it runs follows its own whileRunning (here: cancel), it doesn't "stop itself" first.
    press('show', 'again');
    const again = runOf('show/again')!;
    expect(press('show', 'again').result).toBe('cancelling');
    expect(again.kills).toBe(1);
    expect(runs.filter((r) => r.spec.env!.BUTTPAD_BUTTON === 'again').length).toBe(1);
  });

  test('a queued re-run that starts stops the group too (here: one the config put in the group meanwhile)', async () => {
    const { store, runOf, press } = fakeStore(grouped());
    press('show', 'warm');
    expect(press('show', 'warm').result).toBe('queued');
    press('show', 'free');
    press('show', 'bgm');
    const cfg = grouped();
    cfg.pads[0]!.buttons!.find((b) => b.id === 'free')!.group = 'wash';
    store.setConfig(Config.parse(cfg));
    expect(runOf('show/free')!.kills).toBe(0); // a config change stops nothing by itself
    runOf('show/warm')!.exit({ exitCode: 0 });
    await waitFor(() => store.get('show/warm')?.phase === 'running', 2000, 'the re-run');
    expect(runOf('show/free')!.kills).toBe(1);
    expect(runOf('show/bgm')!.kills).toBe(0);
  });

  test('the round-3 emergency exemption: a none group member with something to stop is never rate limited', () => {
    const { store, press } = fakeStore(grouped(), { limits: { burst: 1, perSec: 0, sourceBurst: 1, sourcePerSec: 0, maxRunning: 1e9 } });
    const src = store.newSource('ws 10.0.0.9', '10.0.0.9');
    expect(press('show', 'warm', { source: src }).result).toBe('started');
    expect(press('show', 'bgm', { source: src })).toMatchObject({ result: 'ignored', refused: 'rate' });
    expect(press('show', 'wash-off', { source: src }).result).toBe('started'); // warm is running: it gets through
  });

  test('stopsBeforeStart', () => {
    const cfg = Config.parse(grouped());
    const b = (pad: string, id: string) => ({ pad, button: cfg.pads.find((p) => p.id === pad)!.buttons.find((x) => x.id === id)! });
    expect(stopsBeforeStart(b('show', 'warm'), b('show', 'cold'))).toBe(true);
    expect(stopsBeforeStart(b('show', 'warm'), b('backup', 'warm2'))).toBe(true);
    expect(stopsBeforeStart(b('show', 'warm'), b('show', 'warm'))).toBe(false);
    expect(stopsBeforeStart(b('show', 'warm'), b('show', 'bgm'))).toBe(false);
    expect(stopsBeforeStart(b('show', 'free'), b('show', 'warm'))).toBe(false);
    expect(stopsBeforeStart(b('show', 'blue'), b('show', 'free'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

/** Detached `sleep`s (own process group), killed after each test. */
const sleepers: number[] = [];
afterEach(() => {
  for (const pid of sleepers.splice(0))
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
});

/** A store with a state file in `dir`; its fake runs end when killed; `pids` names their processes (so they're listed in flight). */
function storeAt(dir: string, buttons: Buttons, opts: Partial<StateStoreOptions> & { pids?: () => number | undefined } = {}) {
  const runs: FakeRun[] = [];
  const logs: string[] = [];
  const latched: [string, string | null][] = [];
  const store = new StateStore(Config.parse(padConfig(buttons)), {
    baseDir: dir,
    statePath: join(dir, STATE_FILE),
    spawn: (spec, hooks) => {
      const r = new FakeRun(spec, hooks);
      r.exitOnKill = true;
      r.pid = opts.pids?.();
      runs.push(r);
      return r;
    },
    log: (m) => logs.push(m),
    onLatched: (k, t) => latched.push([k, t]),
    cancelGraceMs: 0,
    ...opts,
  });
  store.recover();
  const runsLog = () => logs.filter((l) => l.startsWith('runs:'));
  return { store, runs, logs, runsLog, latched, statePath: join(dir, STATE_FILE), runsPath: join(dir, 'buttpad.runs.json') };
}

/** Not a process of anyone's (pids are below 2^22 on Linux): listed in flight, never alive. */
const NO_SUCH_PID = 2 ** 22 + 7;

describe('after a crash, a latched state is marked uncertain until the next run replaces it', () => {
  test.skipIf(!posix)('"REC ●" comes back as "? REC ●" (once), and the next @state replaces it', async () => {
    const dir = tmpDir('buttpad-r4-');
    const statePath = join(dir, STATE_FILE);
    const p = Bun.spawn(['sleep', '60'], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    sleepers.push(p.pid);
    // What a host that crashed mid-run leaves: the run in flight, its latched state.
    writeJson(statePath, {
      version: 1,
      savedAt: Date.now(),
      buttons: { 'p/rec': { lastRunId: 3, latched: 'REC ●' }, 'p/other': { lastRunId: 1, latched: 'ON' } },
      live: [{ key: 'p/rec', runId: 3, pid: p.pid, pgid: p.pid, startedAt: Date.now() - 5000, fingerprint: processFingerprint(p.pid) }],
    });
    chmodSync(statePath, 0o600);
    const buttons: Buttons = [
      { id: 'rec', x: 0, y: 0, resultHoldMs: 0, action: shell('x') },
      { id: 'other', x: 1, y: 0, action: shell('x') },
    ];
    const one = storeAt(dir, buttons);
    expect(one.store.latched()).toEqual({ 'p/rec': `${UNCERTAIN_PREFIX}REC ●`, 'p/other': 'ON' });
    expect(one.latched).toEqual([['p/rec', '? REC ●']]);
    await waitFor(() => !isAlive(p.pid), 3000, 'the leftover stopped');
    await one.store.shutdown(20);
    // Still uncertain after another restart (nothing ran meanwhile), and not "? ? REC ●".
    const two = storeAt(dir, buttons);
    expect(two.store.latched()).toEqual({ 'p/rec': '? REC ●', 'p/other': 'ON' });
    await waitFor(() => two.store.get('p/rec')?.phase === 'ready', 2000, 'ready');
    two.store.press('p', 'rec');
    two.runs[0]!.update({ latched: 'REC ●' });
    expect(two.store.latched()).toEqual({ 'p/rec': 'REC ●', 'p/other': 'ON' });
    expect(two.latched.at(-1)).toEqual(['p/rec', 'REC ●']);
    two.runs[0]!.exit();
    await two.store.shutdown(20);
  });

  test('a run a graceful shutdown stopped keeps its state as is (the host saw it end, as with a cancel)', async () => {
    const dir = tmpDir('buttpad-r4-');
    writeJson(join(dir, STATE_FILE), {
      version: 1,
      savedAt: Date.now(),
      buttons: { 'p/rec': { lastRunId: 2, latched: 'REC ●' } },
      live: [{ key: 'p/rec', runId: 2, pid: 999_999, pgid: 999_999, startedAt: Date.now() - 5000, stopped: 'shutdown', endedAt: Date.now() - 1000 }],
    });
    chmodSync(join(dir, STATE_FILE), 0o600);
    const { store } = storeAt(dir, [{ id: 'rec', x: 0, y: 0, action: shell('x') }]);
    expect(store.latched()).toEqual({ 'p/rec': 'REC ●' });
    await store.shutdown(20);
  });

  test('an interrupted run older than what the memo knows leaves the state alone', async () => {
    const dir = tmpDir('buttpad-r4-');
    writeJson(join(dir, STATE_FILE), {
      version: 1,
      savedAt: Date.now(),
      buttons: { 'p/rec': { lastRunId: 5, latched: 'IDLE' } },
      live: [{ key: 'p/rec', runId: 4, pid: 999_999, pgid: 999_999, startedAt: Date.now() - 5000 }],
    });
    chmodSync(join(dir, STATE_FILE), 0o600);
    const { store } = storeAt(dir, [{ id: 'rec', x: 0, y: 0, action: shell('x') }]);
    expect(store.latched()).toEqual({ 'p/rec': 'IDLE' });
    await store.shutdown(20);
  });
});

describe('the run log across restarts (buttpad.runs.json)', () => {
  const big = (c: string) => `${c.repeat(5000)}\nthe end ✓\n`;

  test('the last 20 finished runs per button come back, tails cut to 2 KB; 0600; removed buttons drop out', async () => {
    const dir = tmpDir('buttpad-r4-');
    const buttons: Buttons = [
      { id: 'a', x: 0, y: 0, resultHoldMs: 0, action: shell('x') },
      { id: 'b', x: 1, y: 0, resultHoldMs: 0, action: shell('x') },
    ];
    let pid: number | undefined;
    const one = storeAt(dir, buttons, { pids: () => pid });
    for (let i = 0; i < HISTORY_SIZE + 3; i++) {
      one.store.press('p', 'a');
      const r = one.runs.at(-1)!;
      r.out = i === HISTORY_SIZE + 2 ? big('o') : `out ${i}\n`;
      r.err = i === HISTORY_SIZE + 2 ? big('e') : '';
      r.exit({ exitCode: i % 2, text: `take ${i}` });
      await waitFor(() => one.store.get('p/a')?.phase === 'ready', 2000, 'ready');
    }
    one.store.press('p', 'b');
    one.runs.at(-1)!.exit({ exitCode: 3 });
    pid = NO_SUCH_PID;
    one.store.press('p', 'b'); // still running at the shutdown: listed in flight, and saved as the shutdown ended it
    pid = undefined;
    const before = one.store.runs();
    await one.store.shutdown(20);
    expect(statSync(one.runsPath).mode & 0o777).toBe(0o600);

    const two = storeAt(dir, buttons);
    expect(two.logs).toEqual(['■ p/b #2 was interrupted when the previous host stopped (stopped by the shutdown)']);
    const after = two.store.runs();
    expect(after.filter((r) => r.button === 'a').map((r) => r.runId)).toEqual(before.filter((r) => r.button === 'a').map((r) => r.runId));
    expect(after.filter((r) => r.button === 'a').length).toBe(HISTORY_SIZE);
    const newest = after.find((r) => r.button === 'a')!;
    expect(newest).toMatchObject({ runId: HISTORY_SIZE + 3, pad: 'p', button: 'a', exitCode: 0 });
    expect(Buffer.byteLength(newest.stdout)).toBeLessThanOrEqual(SAVED_TAIL_BYTES);
    expect(newest.stdout).toStartWith('…');
    expect(newest.stdout).toEndWith('the end ✓\n');
    expect(Buffer.byteLength(newest.stderr)).toBeLessThanOrEqual(SAVED_TAIL_BYTES);
    expect(after.find((r) => r.button === 'a' && r.runId === HISTORY_SIZE + 2)).toMatchObject({ stdout: `out ${HISTORY_SIZE + 1}\n`, exitCode: 1 });
    // b: the finished run, and the one the shutdown stopped — once (the record it saved), as interrupted.
    expect(after.filter((r) => r.button === 'b').map((r) => [r.runId, r.reason, r.error])).toEqual([
      [2, 'interrupted', 'stopped: host shutdown'],
      [1, 'exit', undefined],
    ]);
    // Run ids continue where the state file says they were.
    expect(two.store.press('p', 'a')).toMatchObject({ result: 'started', runId: HISTORY_SIZE + 4 });
    two.runs.at(-1)!.exit();
    await two.store.shutdown(20);

    // A button removed meanwhile: its runs are gone, from the file too.
    const three = storeAt(dir, [buttons[0]!]);
    expect(three.store.runs().every((r) => r.button === 'a')).toBe(true);
    await three.store.shutdown(20);
    const saved = readJson<{ runs: Record<string, RunRecord[]> }>(three.runsPath);
    expect(Object.keys(saved.runs)).toEqual(['p/a']);
  });

  test('run ids come from the state file only (the run log is display data); an absurd id in either file is dropped as malformed', async () => {
    const dir = tmpDir('buttpad-r4-');
    const statePath = join(dir, STATE_FILE);
    const runsPath = join(dir, 'buttpad.runs.json');
    const rec = (runId: number, startedAt: number) => ({ runId, pad: 'p', button: 'a', startedAt, endedAt: startedAt + 1, exitCode: 0, stdout: `#${runId}`, stderr: '' });
    const buttons: Buttons = [
      { id: 'a', x: 0, y: 0, resultHoldMs: 0, action: shell('x') },
      { id: 'b', x: 1, y: 0, resultHoldMs: 0, action: shell('x') },
    ];
    // QA: a run log holding runId 2^53 − 1 seeded the counter, and +1 no longer changed it: every run was #9007199254740992.
    writeJson(statePath, { version: 1, savedAt: Date.now(), buttons: { 'p/a': { lastRunId: 3 } }, live: [] });
    chmodSync(statePath, 0o600);
    writeJson(runsPath, { version: 1, runs: { 'p/a': [rec(Number.MAX_SAFE_INTEGER, 3000), rec(MAX_RUN_ID + 1, 2500), rec(MAX_RUN_ID, 2000), rec(3, 1000)] } });
    const one = storeAt(dir, buttons);
    // Shown (display data), the absurd ones dropped like any malformed record…
    expect(one.store.runs().map((r) => r.runId)).toEqual([MAX_RUN_ID, 3]);
    // …and the ids go on from the state file's, one by one.
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = one.store.press('p', 'a');
      ids.push(r.runId!);
      one.runs.at(-1)!.exit();
      await waitFor(() => one.store.get('p/a')?.phase === 'ready', 2000, 'ready');
    }
    expect(ids).toEqual([4, 5, 6]);
    await one.store.shutdown(20);

    // buttpad.state.json deleted, the run log kept: the ids start over (the log's #6 doesn't move them).
    rmSync(statePath);
    const two = storeAt(dir, buttons);
    expect(two.store.runs().filter((r) => r.button === 'a')[0]).toMatchObject({ runId: 6 });
    expect(two.store.press('p', 'a')).toMatchObject({ result: 'started', runId: 1 });
    two.runs.at(-1)!.exit();
    await two.store.shutdown(20);

    // In the state file: an absurd lastRunId (and an absurd run in flight) is dropped like any bad value; `last` is a run the ids passed.
    writeJson(statePath, {
      version: 1,
      savedAt: Date.now(),
      buttons: { 'p/a': { lastRunId: Number.MAX_SAFE_INTEGER, latched: 'X' }, 'p/b': { lastRunId: 2, last: { runId: 7, ok: true, endedAt: 1 } } },
      live: [{ key: 'p/a', runId: MAX_RUN_ID + 1, pid: NO_SUCH_PID, pgid: NO_SUCH_PID, startedAt: 1 }],
    });
    chmodSync(statePath, 0o600);
    const three = storeAt(dir, buttons);
    expect(three.logs.filter((l) => l.includes('interrupted'))).toEqual([]);
    expect(three.store.latched()).toEqual({});
    expect(three.store.press('p', 'a')).toMatchObject({ runId: 1 });
    expect(three.store.press('p', 'b')).toMatchObject({ runId: 8 });
    for (const r of three.runs) r.exit();
    await three.store.shutdown(20);

    // At the bound itself the ids still count up (2^53 − 1 couldn't: + 1 changed nothing there).
    writeJson(statePath, { version: 1, savedAt: Date.now(), buttons: { 'p/a': { lastRunId: MAX_RUN_ID } }, live: [] });
    chmodSync(statePath, 0o600);
    const four = storeAt(dir, buttons);
    expect(four.store.press('p', 'a')).toMatchObject({ runId: MAX_RUN_ID + 1 });
    four.runs.at(-1)!.exit();
    await waitFor(() => four.store.get('p/a')?.phase === 'ready', 2000, 'ready');
    expect(four.store.press('p', 'a')).toMatchObject({ runId: MAX_RUN_ID + 2 });
    four.runs.at(-1)!.exit();
    await four.store.shutdown(20);
  });

  test('a crash: the runs that ended are there, the one cut off is added once as interrupted', async () => {
    const dir = tmpDir('buttpad-r4-');
    const buttons: Buttons = [{ id: 'a', x: 0, y: 0, resultHoldMs: 0, action: shell('x') }];
    let pid: number | undefined;
    const one = storeAt(dir, buttons, { pids: () => pid });
    one.store.press('p', 'a');
    one.runs[0]!.out = 'first\n';
    one.runs[0]!.exit();
    await waitFor(() => one.store.get('p/a')?.phase === 'ready', 2000, 'ready');
    pid = NO_SUCH_PID;
    one.store.press('p', 'a'); // listed in flight
    // The host dies without a word (the exit handler's last save, no shutdown): what was saved by then is all there is.
    one.store.forceKillAll();
    const two = storeAt(dir, buttons);
    expect(two.store.runs().map((r) => [r.runId, r.reason, r.stdout])).toEqual([
      [2, 'interrupted', ''],
      [1, 'exit', 'first\n'],
    ]);
    await two.store.shutdown(20);
  });

  test('saves are throttled to one a second, never hold up a run, and a failing save is logged once', async () => {
    const dir = tmpDir('buttpad-r4-');
    const writes: number[] = [];
    let fail = true;
    const t0 = performance.now();
    const { store, runs, logs } = storeAt(dir, [{ id: 'a', x: 0, y: 0, resultHoldMs: 0, action: shell('x') }], {
      runsWrite: () => {
        if (fail) throw new Error('could not write: no space left on device (ENOSPC)');
        writes.push(performance.now() - t0);
      },
    });
    for (let i = 0; i < 10; i++) {
      store.press('p', 'a');
      runs.at(-1)!.exit();
      await waitFor(() => store.get('p/a')?.phase === 'ready', 2000, 'ready');
    }
    await Bun.sleep(1200);
    expect(logs.filter((l) => l.startsWith('runs: cannot save')).length).toBe(1);
    expect(logs.find((l) => l.startsWith('runs: cannot save'))).toEndWith("the run log won't survive a restart until this is fixed");
    fail = false;
    store.press('p', 'a');
    runs.at(-1)!.exit();
    await waitFor(() => writes.length > 0, 2000, 'a save that works');
    expect(logs.at(-1)).toMatch(/^runs: saving .*buttpad\.runs\.json works again$/);
    await store.shutdown(20);
    expect(writes.length).toBeLessThanOrEqual(3);
  });

  test("junk in the file is dropped; a corrupt file is said once and starts the log empty; a FIFO doesn't hang", async () => {
    const dir = tmpDir('buttpad-r4-');
    const runsPath = join(dir, 'buttpad.runs.json');
    const ok = { runId: 2, pad: 'p', button: 'a', startedAt: 1000, endedAt: 2000, exitCode: 0, stdout: 'x'.repeat(10_000), stderr: '' };
    writeJson(runsPath, {
      version: 1,
      runs: {
        'p/a': [ok, { ...ok, runId: 3, pad: 'q' }, { ...ok, runId: 4, endedAt: undefined }, { ...ok, runId: 'x' }, { ...ok, runId: 5, error: 'boom\u001b[31m‮', reason: 'nope', exitCode: 'x' }, ok],
        'p/\u001b[31ma': [ok],
      },
    });
    const one = storeAt(dir, [{ id: 'a', x: 0, y: 0, action: shell('x') }]);
    expect(one.runsLog()).toEqual([]);
    const runs = one.store.runs();
    expect(runs.map((r) => r.runId)).toEqual([5, 2]);
    expect(runs[0]).toEqual({ runId: 5, pad: 'p', button: 'a', startedAt: 1000, endedAt: 2000, error: 'boom', stdout: expect.any(String), stderr: '' });
    expect(Buffer.byteLength(runs[1]!.stdout)).toBeLessThanOrEqual(SAVED_TAIL_BYTES);
    await one.store.shutdown(20);

    writeFileSync(runsPath, '{"version": 1, "runs": ');
    const two = storeAt(dir, [{ id: 'a', x: 0, y: 0, action: shell('x') }]);
    expect(two.runsLog()).toEqual([expect.stringMatching(/^runs: can't use .*buttpad\.runs\.json \(invalid JSON .*\); the run log starts empty$/)]);
    expect(two.store.runs()).toEqual([]);
    await two.store.shutdown(20);

    if (posix && Bun.which('mkfifo')) {
      const fifoDir = tmpDir('buttpad-r4-');
      expect(Bun.spawnSync(['mkfifo', join(fifoDir, 'buttpad.runs.json')]).success).toBe(true);
      const three = storeAt(fifoDir, [{ id: 'a', x: 0, y: 0, action: shell('x') }]);
      expect(three.runsLog()).toEqual([expect.stringContaining('not a regular file: it is a named pipe (FIFO)')]);
      await three.store.shutdown(20);
    }
  });

  test.skipIf(!posix)('a file someone else could have written: shown (display data), written back 0600 at once', async () => {
    const dir = tmpDir('buttpad-r4-');
    const runsPath = join(dir, 'buttpad.runs.json');
    writeJson(runsPath, { version: 1, runs: { 'p/a': [{ runId: 1, pad: 'p', button: 'a', startedAt: 1, endedAt: 2, stdout: 'hi', stderr: '' }] } });
    chmodSync(runsPath, 0o644);
    const { store } = storeAt(dir, [{ id: 'a', x: 0, y: 0, action: shell('x') }]);
    expect(store.runs().map((r) => r.stdout)).toEqual(['hi']);
    await waitFor(() => (statSync(runsPath).mode & 0o777) === 0o600, 3000, 'rewritten 0600');
    await store.shutdown(20);
  });

  test('the file is capped: past RUNS_FILE_MAX the oldest runs (over all buttons) are left out', () => {
    const rec = (key: string, runId: number, endedAt: number): RunRecord => {
      const [pad, button] = key.split('/') as [string, string];
      return { runId, pad, button, startedAt: endedAt - 10, endedAt, stdout: 'o'.repeat(3000), stderr: 'e'.repeat(3000) };
    };
    const history = new Map<string, RunRecord[]>();
    // 30 buttons × 20 runs, newest first, interleaved in time.
    for (let b = 0; b < 30; b++) history.set(`p/b${b}`, Array.from({ length: 20 }, (_, i) => rec(`p/b${b}`, 20 - i, 1_000_000 - i * 100 - b)));
    const running: RunRecord = { runId: 99, pad: 'p', button: 'b0', startedAt: 1, stdout: '', stderr: '' };
    history.get('p/b0')!.unshift(running);
    const max = 200_000;
    const text = runsFileText(history, 5, max);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(max);
    const parsed = parseRuns(JSON.parse(text), (s) => s);
    if (typeof parsed === 'string') throw new Error(parsed);
    const kept = Object.values(parsed.runs).flat();
    expect(kept.length).toBeGreaterThan(30);
    expect(kept.some((r) => r.runId === 99)).toBe(false); // running: not saved
    // The newest ones are the ones kept.
    const minKept = Math.min(...kept.map((r) => r.endedAt!));
    const all = [...history.values()].flat().filter((r) => r.endedAt !== undefined);
    expect(all.filter((r) => r.endedAt! >= minKept).length).toBe(kept.length);
  });

  test('helpers: the path next to the state file; tails cut between characters', () => {
    expect(runsPathFor('/a/buttpad.state.json')).toBe('/a/buttpad.runs.json');
    expect(runsPathFor('/a/my.json')).toBe('/a/my.runs.json');
    expect(runsPathFor('/a/state')).toBe('/a/state.runs.json');
    expect(tailBytes('short', 2048)).toBe('short');
    const cut = tailBytes('é'.repeat(3000), 2048);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(2048);
    expect(cut).toMatch(/^…é+$/);
    expect(tailBytes(cut, 2048)).toBe(cut); // cutting again changes nothing
  });

  test('over the wire: GET /api/runs after a restart', async () => {
    const dir = tmpDir('buttpad-r4-');
    const configPath = join(dir, 'buttpad.config.json');
    writeJson(configPath, padConfig([{ id: 'hi', x: 0, y: 0, action: shell('echo "hello from run $BUTTPAD_RUN_ID"; echo oops >&2') }]));
    const one = await startHost({ configPath, host: '127.0.0.1', port: 0, log: () => {} });
    await fetch(`http://127.0.0.1:${one.port}/api/press/p/hi`, { method: 'POST', headers: { authorization: `Bearer ${one.secrets.pressToken}` } });
    await waitFor(() => one.state.get('p/hi')?.phase === 'success', 3000, 'done');
    await one.stop();
    expect(existsSync(join(dir, 'buttpad.runs.json'))).toBe(true);
    expect(readFileSync(join(dir, 'buttpad.runs.json'), 'utf8')).toContain('hello from run 1');
    const two = await startHost({ configPath, host: '127.0.0.1', port: 0, log: () => {} });
    hosts.push(two);
    const runs = (await (await fetch(`http://127.0.0.1:${two.port}/api/runs`, { headers: { authorization: `Bearer ${two.secrets.adminToken}` } })).json()) as RunRecord[];
    expect(runs).toEqual([
      expect.objectContaining({ runId: 1, pad: 'p', button: 'hi', exitCode: 0, reason: 'exit', stdout: 'hello from run 1\n', stderr: 'oops\n', command: expect.stringContaining('/bin/sh -c'), cwd: dir }),
    ]);
  });
});

test('sanitize keeps what the run log error needs (sanity for the junk test)', () => {
  expect(sanitize('boom\u001b[31m‮')).toBe('boom');
});
