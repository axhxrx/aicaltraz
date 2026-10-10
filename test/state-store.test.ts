import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Config, type ConfigInput } from '../src/core/config.ts';
import type { RunState } from '../src/core/machine.ts';
import { startRun, type RunHandle, type RunHooks, type RunOutcome, type RunSpec } from '../src/server/runner.ts';
import { CANCEL_GRACE_MS, HISTORY_SIZE, START_LIMITS, StateStore, type PressOptions, type StateStoreOptions } from '../src/server/state-store.ts';
import { cleanupTmp, isAlive, padConfig, tmpDir, waitFor, writeExecutable } from './helpers.ts';

afterAll(cleanupTmp);

class FakeRun implements RunHandle {
  readonly pid = 4242;
  kills = 0;
  forceKills = 0;
  finished = false;
  /** What kill() reports: whether there was anything left to signal. */
  killable = true;
  /** Killed, and its process group outlives the exit (grandchildren in their SIGKILL grace period). */
  lingering = false;
  readonly done: Promise<RunOutcome>;
  private resolve!: (o: RunOutcome) => void;

  constructor(
    readonly spec: RunSpec,
    readonly hooks: RunHooks,
  ) {
    this.done = new Promise((r) => (this.resolve = r));
  }
  kill() {
    this.kills++;
    return this.killable;
  }
  forceKill() {
    this.forceKills++;
    this.lingering = false;
  }
  alive() {
    return !this.finished || this.lingering;
  }
  dying() {
    return this.lingering;
  }
  stdout() {
    return 'live stdout';
  }
  stderr() {
    return 'live stderr';
  }
  update(u: { progress?: number; status?: string }) {
    this.hooks.onUpdate?.(u);
  }
  exit(o: Partial<RunOutcome> = {}) {
    const out: RunOutcome = { exitCode: 0, signal: null, stdout: 'final stdout', stderr: '', durationMs: 5, ...o };
    this.finished = true;
    this.hooks.onExit?.(out);
    this.resolve(out);
  }
}

type Buttons = NonNullable<ConfigInput['pads'][number]['buttons']>;

/** Fake runs and clocks. No cancel grace and practically no rate limits unless `opts` asks for them. */
function setup(buttons: Buttons, opts: Partial<StateStoreOptions> = {}, pad: Partial<ConfigInput['pads'][number]> = {}) {
  const runs: FakeRun[] = [];
  const events: string[] = [];
  const states: [string, RunState][] = [];
  const logs: string[] = [];
  let clock = 1000;
  let mono = 0;
  const store = new StateStore(Config.parse(padConfig(buttons, pad)), {
    baseDir: '/cfg',
    spawn: (spec, hooks) => {
      const r = new FakeRun(spec, hooks);
      runs.push(r);
      return r;
    },
    onState: (key, s) => {
      states.push([key, s]);
      events.push(`state:${s.phase}`);
    },
    log: (m) => logs.push(m),
    now: () => (clock += 10),
    clock: () => mono,
    cancelGraceMs: 0,
    limits: { burst: 1e9, perSec: 0, maxRunning: 1e9 },
    ...opts,
  });
  const press = (button: string, o: PressOptions = {}) => store.press('p', button, { onResult: (r) => events.push(`ack:${r.result}`), ...o }).result;
  const advance = (ms: number) => (mono += ms);
  return { store, runs, events, states, logs, press, advance, last: () => states.at(-1)?.[1] };
}

const shell = (script: string) => ({ type: 'shell' as const, script });

describe('StateStore', () => {
  test('press starts a run with the button action and BUTTPAD_* env; ack precedes the state report', () => {
    const { store, runs, events, last, press } = setup([{ id: 'a', label: 'Alpha', x: 0, y: 0, timeoutMs: 1234, action: shell('echo a') }]);
    expect(store.states()).toEqual({ 'p/a': { phase: 'ready', runId: 0 } });
    expect(press('a')).toBe('started');
    expect(events).toEqual(['ack:started', 'state:running']);
    expect(last()).toMatchObject({ phase: 'running', runId: 1 });
    expect(runs[0]!.spec).toEqual({
      action: { type: 'shell', script: 'echo a' },
      baseDir: '/cfg',
      timeoutMs: 1234,
      env: { BUTTPAD_PAD: 'p', BUTTPAD_BUTTON: 'a', BUTTPAD_RUN_ID: '1', BUTTPAD_LABEL: 'Alpha' },
    });
    expect(store.running).toBe(1);
  });

  test('progress → exit → success → reset after resultHoldMs', async () => {
    const { store, runs, last, press } = setup([{ id: 'a', x: 0, y: 0, resultHoldMs: 30, action: shell('x') }]);
    press('a');
    runs[0]!.update({ progress: 50, status: 'half' });
    expect(last()).toMatchObject({ phase: 'running', progress: 50, status: 'half' });
    runs[0]!.exit({ exitCode: 0, text: 'done' });
    expect(last()).toMatchObject({ phase: 'success', runId: 1, exitCode: 0, text: 'done' });
    expect(store.running).toBe(0);
    const [rec] = store.runs();
    expect(rec).toMatchObject({ runId: 1, pad: 'p', button: 'a', exitCode: 0, reason: 'exit', stdout: 'final stdout' });
    expect(rec!.endedAt).toBeGreaterThan(rec!.startedAt);
    await waitFor(() => store.get('p/a')?.phase === 'ready', 1000, 'reset');
    expect(store.get('p/a')).toEqual({ phase: 'ready', runId: 1, last: { runId: 1, ok: true, text: 'done', endedAt: rec!.endedAt! } });
  });

  test('the longest resultHoldMs keeps the result up (no timer overflow to an instant reset)', async () => {
    const { store, runs, press } = setup([{ id: 'a', x: 0, y: 0, resultHoldMs: 60_000, action: shell('x') }]);
    press('a');
    runs[0]!.exit({ exitCode: 0 });
    await Bun.sleep(50);
    expect(store.get('p/a')?.phase).toBe('success');
  });

  test('a stale reset timer never resets a newer run', async () => {
    const { store, runs, press } = setup([{ id: 'a', x: 0, y: 0, resultHoldMs: 40, action: shell('x') }]);
    press('a');
    runs[0]!.exit({ exitCode: 1 });
    expect(store.get('p/a')?.phase).toBe('failure');
    press('a');
    await Bun.sleep(100);
    expect(store.get('p/a')).toMatchObject({ phase: 'running', runId: 2 });
  });

  test('whileRunning ignore', () => {
    const { runs, press } = setup([{ id: 'a', x: 0, y: 0, action: shell('x') }]);
    press('a');
    expect(press('a')).toBe('ignored');
    expect(runs.length).toBe(1);
  });

  test('whileRunning cancel kills once and fails as cancelled', () => {
    const { store, runs, last, press, events } = setup([{ id: 'a', x: 0, y: 0, whileRunning: 'cancel', action: shell('x') }]);
    press('a');
    expect(press('a')).toBe('cancelling');
    expect(press('a')).toBe('cancelling');
    expect(runs[0]!.kills).toBe(1);
    expect(last()).toMatchObject({ phase: 'running', cancelling: true });
    runs[0]!.exit({ exitCode: null, signal: 'SIGTERM' });
    expect(last()).toMatchObject({ phase: 'failure', reason: 'cancelled', exitCode: null });
    expect(store.runs()[0]).toMatchObject({ reason: 'cancelled', exitCode: null });
    expect(events.filter((e) => e.startsWith('ack'))).toEqual(['ack:started', 'ack:cancelling', 'ack:cancelling']);
  });

  test('timeout and spawn failures are recorded with their reason', () => {
    const { store, runs, last, press } = setup([
      { id: 't', x: 0, y: 0, action: shell('x') },
      { id: 's', x: 1, y: 0, action: shell('x') },
    ]);
    press('t');
    runs[0]!.exit({ exitCode: null, signal: 'SIGTERM', reason: 'timeout' });
    expect(last()).toMatchObject({ phase: 'failure', reason: 'timeout' });
    press('s');
    runs[1]!.exit({ exitCode: null, reason: 'spawn', text: 'command not found: x' });
    expect(last()).toMatchObject({ phase: 'failure', reason: 'spawn', text: 'command not found: x' });
    expect(store.runs().map((r) => r.reason)).toEqual(['spawn', 'timeout']);
  });

  test('whileRunning queue runs once more after the current run, once its result has shown', async () => {
    const { store, runs, last, press } = setup([{ id: 'q', x: 0, y: 0, whileRunning: 'queue', action: shell('x') }]);
    press('q');
    expect(press('q')).toBe('queued');
    expect(press('q')).toBe('ignored'); // already queued
    expect(last()).toMatchObject({ phase: 'running', runId: 1, queued: true });
    runs[0]!.exit({ exitCode: 3, text: 'boom' });
    // The failure shows first (REQUEUE_GAP_MS), then the re-run starts.
    expect(last()).toMatchObject({ phase: 'failure', runId: 1, text: 'boom', queued: true });
    expect(runs.length).toBe(1);
    expect(press('q')).toBe('ignored'); // the re-run is coming
    await waitFor(() => runs.length === 2, 3000, 'the queued re-run');
    expect(runs[1]!.spec.env!.BUTTPAD_RUN_ID).toBe('2');
    expect(last()).toMatchObject({ phase: 'running', runId: 2 });
    expect(last()).not.toHaveProperty('queued');
    runs[1]!.exit({ exitCode: 0 });
    expect(last()).toMatchObject({ phase: 'success', runId: 2 });
    expect(store.runs().map((r) => r.runId)).toEqual([2, 1]);
  });

  test('unknown buttons', () => {
    const { store, events } = setup([{ id: 'a', x: 0, y: 0, action: shell('x') }]);
    expect(store.press('p', 'nope', { onResult: (r) => events.push(`${r.result}:${r.key}`) })).toEqual({ result: 'unknown-button', key: 'p/nope', state: undefined });
    expect(store.press('zz', 'a').result).toBe('unknown-button');
    expect(events).toEqual(['unknown-button:p/nope']);
  });

  test('runs(): live output, newest first, filters, capped per button', () => {
    const { store, runs, press } = setup([
      { id: 'a', x: 0, y: 0, action: shell('x') },
      { id: 'b', x: 1, y: 0, action: shell('x') },
    ]);
    for (let i = 0; i < HISTORY_SIZE + 5; i++) {
      press('a');
      runs.at(-1)!.exit();
    }
    press('b');
    const all = store.runs();
    expect(all.length).toBe(HISTORY_SIZE + 1);
    expect(all[0]).toMatchObject({ button: 'b', stdout: 'live stdout', stderr: 'live stderr' });
    expect(all[0]).not.toHaveProperty('endedAt');
    expect(store.runs({ button: 'a' }).map((r) => r.runId)).toEqual(Array.from({ length: HISTORY_SIZE }, (_, i) => HISTORY_SIZE + 5 - i));
    expect(store.runs({ pad: 'p', button: 'b' }).length).toBe(1);
    expect(store.runs({ pad: 'other' })).toEqual([]);
    // Returned records are copies.
    store.runs()[0]!.stdout = 'tampered';
    expect(store.runs()[0]!.stdout).toBe('live stdout');
  });

  test('setConfig: removing a running button kills it and drops its state; re-adding continues runIds', () => {
    const { store, runs, states, press } = setup([
      { id: 'a', x: 0, y: 0, action: shell('x') },
      { id: 'b', x: 1, y: 0, action: shell('x') },
    ]);
    press('a');
    press('a'); // ignored
    const added = store.setConfig(Config.parse(padConfig([{ id: 'b', x: 1, y: 0, action: shell('x') }])));
    expect(added).toEqual([]);
    expect(runs[0]!.kills).toBe(1);
    expect(Object.keys(store.states())).toEqual(['p/b']);
    const reported = states.length;
    runs[0]!.exit({ exitCode: null, signal: 'SIGTERM' });
    expect(states.length).toBe(reported); // nothing reported for a removed button
    expect(store.runs({ button: 'a' })[0]).toMatchObject({ reason: 'cancelled' });
    expect(store.running).toBe(0);

    const readded = store.setConfig(Config.parse(padConfig([{ id: 'a', x: 0, y: 0, action: shell('x') }, { id: 'b', x: 1, y: 0, action: shell('x') }])));
    expect(readded).toEqual(['p/a']);
    expect(store.get('p/a')).toEqual({ phase: 'ready', runId: 1 });
    press('a');
    expect(store.get('p/a')).toMatchObject({ phase: 'running', runId: 2 });
  });

  test('setConfig: changing a running button keeps the current run, new settings apply next time', () => {
    const { store, runs, press, last } = setup([{ id: 'a', x: 0, y: 0, resultHoldMs: 10_000, action: shell('old') }]);
    press('a');
    store.setConfig(Config.parse(padConfig([{ id: 'a', x: 1, y: 1, whileRunning: 'cancel', action: shell('new') }])));
    expect(runs[0]!.kills).toBe(0);
    expect(press('a')).toBe('cancelling');
    runs[0]!.exit({ exitCode: null });
    expect(last()).toMatchObject({ phase: 'failure', reason: 'cancelled' });
    press('a');
    expect((runs[1]!.spec.action as { script: string }).script).toBe('new');
  });

  test('shutdown kills every run, force-kills stragglers and refuses new presses', async () => {
    const { store, runs, press } = setup([
      { id: 'a', x: 0, y: 0, action: shell('x') },
      { id: 'b', x: 1, y: 0, action: shell('x') },
    ]);
    press('a');
    press('b');
    runs[0]!.kill = () => (runs[0]!.exit({ exitCode: null }), true); // a polite one
    const t0 = Date.now();
    await store.shutdown(150);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(runs[1]!.kills).toBe(1);
    expect(runs[1]!.forceKills).toBe(1);
    expect(runs[0]!.forceKills).toBe(0);
    expect(press('a')).toBe('ignored');
    expect(runs.length).toBe(2);
  });

  test(`a cancel press within ${CANCEL_GRACE_MS} ms of the start is a double press: ignored`, () => {
    const { runs, press, advance, last } = setup([{ id: 'a', x: 0, y: 0, whileRunning: 'cancel', action: shell('x') }], { cancelGraceMs: undefined });
    expect(press('a')).toBe('started');
    advance(CANCEL_GRACE_MS - 1);
    expect(press('a')).toBe('ignored');
    expect(runs[0]!.kills).toBe(0);
    expect(last()).not.toHaveProperty('cancelling');
    advance(1);
    expect(press('a')).toBe('cancelling');
    expect(runs[0]!.kills).toBe(1);
  });

  test('a cancel that no longer reaches the process (it exited, output still draining) is ignored; the run ends as what it was', () => {
    const { store, runs, press, last, events } = setup([{ id: 'a', x: 0, y: 0, whileRunning: 'cancel', action: shell('x') }]);
    press('a');
    runs[0]!.killable = false;
    expect(press('a')).toBe('ignored');
    expect(last()).toMatchObject({ phase: 'running' });
    expect(last()).not.toHaveProperty('cancelling');
    runs[0]!.exit({ exitCode: 0, text: 'photo taken' });
    expect(last()).toMatchObject({ phase: 'success', text: 'photo taken' });
    expect(store.runs()[0]).toMatchObject({ reason: 'exit', exitCode: 0 });
    expect(events.filter((e) => e.startsWith('ack'))).toEqual(['ack:started', 'ack:ignored']);
  });

  test('cancelling also drops a queued re-run (whileRunning switched from queue to cancel)', () => {
    const { store, runs, press, last } = setup([{ id: 'a', x: 0, y: 0, whileRunning: 'queue', action: shell('x') }]);
    press('a');
    expect(press('a')).toBe('queued');
    store.setConfig(Config.parse(padConfig([{ id: 'a', x: 0, y: 0, whileRunning: 'cancel', action: shell('x') }])));
    expect(press('a')).toBe('cancelling');
    expect(last()).not.toHaveProperty('queued');
    runs[0]!.exit({ exitCode: null, signal: 'SIGTERM' });
    expect(runs.length).toBe(1);
    expect(last()).toMatchObject({ phase: 'failure', reason: 'cancelled' });
  });

  test('a removed and re-added button never runs twice at once: presses are ignored until the old run is gone', () => {
    const { store, runs, press } = setup([{ id: 'a', x: 0, y: 0, action: shell('x') }]);
    press('a');
    store.setConfig(Config.parse(padConfig([])));
    expect(runs[0]!.kills).toBe(1);
    store.setConfig(Config.parse(padConfig([{ id: 'a', x: 0, y: 0, action: shell('x') }])));
    expect(press('a')).toBe('ignored'); // the old action is still running
    runs[0]!.lingering = true;
    runs[0]!.exit({ exitCode: null, signal: 'SIGTERM' });
    expect(press('a')).toBe('ignored'); // its process group is still dying
    runs[0]!.lingering = false;
    expect(press('a')).toBe('started');
    expect(runs.filter((r) => r.alive()).length).toBe(1);
    expect(store.runs({ button: 'a' }).map((r) => [r.runId, r.reason])).toEqual([[2, undefined], [1, 'cancelled']]);
  });

  test("a killed run's lingering process group blocks a re-run and is SIGKILLed by shutdown and forceKillAll", async () => {
    const { store, runs, press, last } = setup([
      { id: 'a', x: 0, y: 0, whileRunning: 'cancel', resultHoldMs: 0, action: shell('x') },
      { id: 'b', x: 1, y: 0, whileRunning: 'cancel', resultHoldMs: 0, action: shell('x') },
    ]);
    for (const b of ['a', 'b']) {
      press(b);
      expect(press(b)).toBe('cancelling');
    }
    for (const r of runs) {
      r.lingering = true; // the shell died of the SIGTERM, a grandchild ignores it
      r.exit({ exitCode: null, signal: 'SIGTERM' });
    }
    expect(last()).toMatchObject({ phase: 'failure', reason: 'cancelled' });
    await waitFor(() => store.get('p/a')?.phase === 'ready', 1000, 'reset');
    expect(press('a')).toBe('ignored');
    expect(store.running).toBe(0);
    store.forceKillAll(); // the process 'exit' handler
    expect(runs[0]!.forceKills).toBe(1);
    runs[1]!.forceKills = 0;
    runs[1]!.lingering = true;
    await store.shutdown(50);
    expect(runs[1]!.forceKills).toBe(1);
    expect(runs.length).toBe(2);
  });

  test(`rate limit: ${START_LIMITS.burst} starts at once over all devices, then ${START_LIMITS.perSec}/s; refusals are "ignored" and logged at most once per 10 s`, () => {
    const { store, runs, press, advance, logs } = setup([{ id: 'a', x: 0, y: 0, whileRunning: 'queue', action: shell('x') }], { limits: undefined });
    for (let i = 0; i < START_LIMITS.burst; i++) {
      expect(press('a')).toBe('started');
      runs.at(-1)!.exit();
    }
    const refused = store.press('p', 'a');
    expect(refused).toMatchObject({ result: 'ignored', refused: 'rate' });
    expect(press('a')).toBe('ignored');
    const why = `refusing presses: too many from all devices together (max ${START_LIMITS.burst} at once, then ${START_LIMITS.perSec}/s)`;
    expect(logs).toEqual([why]);
    advance(1000 / START_LIMITS.perSec);
    expect(press('a')).toBe('started');
    expect(press('a')).toBe('ignored'); // queueing a re-run takes a token too
    expect(runs.length).toBe(START_LIMITS.burst + 1);
    expect(logs.length).toBe(1); // within 10 s of the first report: counted, not logged
    advance(1000 / START_LIMITS.perSec);
    expect(press('a')).toBe('queued');
    advance(10_000);
    runs.at(-1)!.exit({ exitCode: 0 });
    store.press('p', 'a'); // queued already: ignored, but not refused by a limit
    expect(logs.length).toBe(1);
  });

  test(`at most ${START_LIMITS.maxRunning} runs at once over all buttons`, () => {
    const n = START_LIMITS.maxRunning + 1;
    const buttons = Array.from({ length: n }, (_, i) => ({ id: `b${i}`, x: i % 12, y: Math.floor(i / 12), action: shell('x') }));
    const { runs, press, logs } = setup(buttons, { limits: { burst: 1e9, perSec: 0, maxRunning: START_LIMITS.maxRunning } }, { cols: 12, rows: 12 });
    for (let i = 0; i < n - 1; i++) expect(press(`b${i}`)).toBe('started');
    expect(press(`b${n - 1}`)).toBe('ignored');
    expect(logs).toEqual([`refusing presses: ${START_LIMITS.maxRunning} actions are running (max ${START_LIMITS.maxRunning})`]);
    runs[0]!.exit();
    expect(press(`b${n - 1}`)).toBe('started');
    expect(runs.length).toBe(n);
  });
});

test('with the real runner: env, cwd and result text end to end', async () => {
  const dir = tmpDir();
  writeExecutable(join(dir, 'scripts', 'hi.sh'), '#!/bin/sh\necho "@status working"\necho "@result $BUTTPAD_LABEL from $(basename "$(pwd)")"\n');
  const states: RunState[] = [];
  const store = new StateStore(
    Config.parse(padConfig([{ id: 'hi', label: 'Hello', x: 0, y: 0, action: { type: 'exec', command: './scripts/hi.sh' } }])),
    { baseDir: dir, onState: (_k, s) => states.push(s) },
  );
  store.press('p', 'hi');
  await waitFor(() => states.at(-1)?.phase === 'success', 3000, 'success');
  expect(states.at(-1)).toMatchObject({ phase: 'success', text: `Hello from ${dir.split('/').at(-1)}`, exitCode: 0 });
  expect(store.runs()[0]!.stdout).toContain('@status working');
  await store.shutdown();
});

describe('with the real runner', () => {
  const sh = (script: string) => ({ type: 'shell' as const, shell: '/bin/sh', script });

  test('shutdown SIGKILLs what a cancelled run left behind in its grace period', async () => {
    // The shell dies of the SIGTERM; the grandchild ignores it and would get its SIGKILL only after 2 s.
    const script = `sh -c 'trap "" TERM; echo "@status child $$"; exec sleep 30 >/dev/null 2>&1' & wait`;
    const store = new StateStore(Config.parse(padConfig([{ id: 'b', x: 0, y: 0, whileRunning: 'cancel', action: sh(script) }])), { baseDir: tmpDir(), cancelGraceMs: 0 });
    store.press('p', 'b');
    const status = await waitFor(() => {
      const s = store.get('p/b');
      return s?.phase === 'running' && s.status;
    }, 3000, 'child pid');
    const child = Number(/child (\d+)/.exec(status)![1]);
    expect(store.press('p', 'b').result).toBe('cancelling');
    await waitFor(() => store.get('p/b')?.phase === 'failure', 3000, 'cancelled');
    expect(isAlive(child)).toBe(true);
    expect(store.press('p', 'b').result).toBe('ignored'); // never two instances at once
    const t0 = performance.now();
    await store.shutdown(200);
    await waitFor(() => !isAlive(child), 1000, 'grandchild to be SIGKILLed');
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  test.skipIf(!Bun.which('setsid'))('a cancel press after the action exited 0 (a helper still holds its stdout) is ignored; the run succeeds', async () => {
    const handles: RunHandle[] = [];
    const store = new StateStore(
      Config.parse(padConfig([{ id: 'cam', x: 0, y: 0, whileRunning: 'cancel', action: sh('setsid sleep 1 & echo "@result photo taken"; exit 0') }])),
      { baseDir: tmpDir(), cancelGraceMs: 0, spawn: (spec, hooks) => (handles[handles.length] = startRun(spec, hooks)) },
    );
    store.press('p', 'cam');
    await waitFor(() => handles[0] && !handles[0].alive(), 3000, 'the shell to exit');
    expect(store.get('p/cam')?.phase).toBe('running'); // the runner waits a moment for the pipes to drain
    expect(store.press('p', 'cam').result).toBe('ignored');
    await waitFor(() => store.get('p/cam')?.phase !== 'running', 3000, 'the run to end');
    expect(store.get('p/cam')).toMatchObject({ phase: 'success', exitCode: 0, text: 'photo taken' });
    await store.shutdown(100);
  });
});
