import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Config, type ConfigInput } from '../src/core/config.ts';
import type { RunState } from '../src/core/machine.ts';
import type { RunHandle, RunHooks, RunOutcome, RunSpec } from '../src/server/runner.ts';
import { HISTORY_SIZE, StateStore } from '../src/server/state-store.ts';
import { cleanupTmp, padConfig, tmpDir, waitFor, writeExecutable } from './helpers.ts';

afterAll(cleanupTmp);

class FakeRun implements RunHandle {
  readonly pid = 4242;
  kills = 0;
  forceKills = 0;
  finished = false;
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
  }
  forceKill() {
    this.forceKills++;
  }
  alive() {
    return !this.finished;
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

function setup(buttons: NonNullable<ConfigInput['pads'][number]['buttons']>) {
  const runs: FakeRun[] = [];
  const events: string[] = [];
  const states: [string, RunState][] = [];
  let clock = 1000;
  const store = new StateStore(Config.parse(padConfig(buttons)), {
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
    now: () => (clock += 10),
  });
  const press = (button: string) => store.press('p', button, (r) => events.push(`ack:${r}`)).result;
  return { store, runs, events, states, press, last: () => states.at(-1)?.[1] };
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
    expect(store.get('p/a')).toEqual({ phase: 'ready', runId: 1 });
  });

  test('a huge resultHoldMs keeps the result up instead of overflowing to an instant reset', async () => {
    const { store, runs, press } = setup([{ id: 'a', x: 0, y: 0, resultHoldMs: 1e12, action: shell('x') }]);
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

  test('whileRunning queue runs once more after the current run', () => {
    const { store, runs, last, press } = setup([{ id: 'q', x: 0, y: 0, whileRunning: 'queue', action: shell('x') }]);
    press('q');
    expect(press('q')).toBe('queued');
    expect(press('q')).toBe('queued');
    expect(last()).toMatchObject({ phase: 'running', runId: 1, queued: true });
    runs[0]!.exit({ exitCode: 0 });
    expect(runs.length).toBe(2);
    expect(runs[1]!.spec.env!.BUTTPAD_RUN_ID).toBe('2');
    expect(last()).toMatchObject({ phase: 'running', runId: 2 });
    expect(last()).not.toHaveProperty('queued');
    runs[1]!.exit({ exitCode: 0 });
    expect(last()).toMatchObject({ phase: 'success', runId: 2 });
    expect(store.runs().map((r) => r.runId)).toEqual([2, 1]);
  });

  test('unknown buttons', () => {
    const { store, events } = setup([{ id: 'a', x: 0, y: 0, action: shell('x') }]);
    expect(store.press('p', 'nope', (r, key) => events.push(`${r}:${key}`))).toEqual({ result: 'unknown-button', key: 'p/nope', state: undefined });
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
    runs[0]!.kill = () => runs[0]!.exit({ exitCode: null }); // a polite one
    const t0 = Date.now();
    await store.shutdown(150);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(runs[1]!.kills).toBe(1);
    expect(runs[1]!.forceKills).toBe(1);
    expect(runs[0]!.forceKills).toBe(0);
    expect(press('a')).toBe('ignored');
    expect(runs.length).toBe(2);
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
