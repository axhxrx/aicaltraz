/**
 * Round-2 host runtime: `stops` + action `none`, kill reasons, `@state` latched device state,
 * deterministic shell, rate limits and connection caps, closing pipes after a run, sanitized
 * text, RunRecord error/command/cwd, no host paths in what press clients see.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { Config, type ConfigInput } from '../src/core/config.ts';
import type { RunState } from '../src/core/machine.ts';
import type { RunRecord } from '../src/core/protocol.ts';
import { HOST_FULL, MAX_CLIENTS_PER_ADDRESS, startHost, type Host, type HostOptions } from '../src/server/host.ts';
import { BucketMap, ThrottledLog, TokenBucket } from '../src/server/limits.ts';
import { clip, LATCHED_MAX, parseDirective, sanitize, sanitizeLog, startRun, type RunHandle, type RunHooks, type RunOutcome, type RunSpec, type RunUpdate } from '../src/server/runner.ts';
import { matchesStop, runEndLine, START_LIMITS, StateStore, STOP_REASONS, type PressOptions, type StateStoreOptions } from '../src/server/state-store.ts';
import { cleanupTmp, eventually, padConfig, TestClient, tmpDir, waitFor, writeExecutable, writeJson } from './helpers.ts';

afterAll(cleanupTmp);

const shell = (script: string) => ({ type: 'shell' as const, script });
const sh = (script: string) => ({ type: 'shell' as const, shell: '/bin/sh', script });

class FakeRun implements RunHandle {
  readonly pid = undefined;
  kills = 0;
  finished = false;
  /** The action exited, its output is still draining: a kill no longer reaches anything. */
  draining = false;
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
    return !this.finished && !this.draining;
  }
  forceKill() {}
  alive() {
    return !this.finished && !this.draining;
  }
  dying() {
    return false;
  }
  stdout() {
    return '';
  }
  stderr() {
    return '';
  }
  update(u: RunUpdate) {
    this.hooks.onUpdate?.(u);
  }
  exit(o: Partial<RunOutcome> = {}) {
    const out: RunOutcome = { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, ...o };
    this.finished = true;
    this.hooks.onExit?.(out);
    this.resolve(out);
  }
}

function fakeStore(config: ConfigInput, opts: Partial<StateStoreOptions> = {}) {
  const runs: FakeRun[] = [];
  const logs: string[] = [];
  const states: [string, RunState][] = [];
  const latched: [string, string | null][] = [];
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
    onLatched: (k, t) => latched.push([k, t]),
    now: () => (clock.now += 1),
    clock: () => clock.mono,
    cancelGraceMs: 0,
    limits: { burst: 1e9, perSec: 0, maxRunning: 1e9, sourceBurst: 1e9, sourcePerSec: 0 },
    ...opts,
  });
  const runOf = (key: string) => runs.find((r) => `${r.spec.env!.BUTTPAD_PAD}/${r.spec.env!.BUTTPAD_BUTTON}` === key && !r.finished);
  return { store, runs, logs, states, latched, clock, runOf, press: (pad: string, b: string, o: PressOptions = {}) => store.press(pad, b, o) };
}

const twoPads = (): ConfigInput => ({
  version: 1,
  pads: [
    {
      id: 'lights',
      name: 'Lights',
      cols: 4,
      rows: 2,
      buttons: [
        { id: 'key', label: 'Key', x: 0, y: 0, action: shell('key') },
        { id: 'fill', label: 'Fill', x: 1, y: 0, whileRunning: 'queue', action: shell('fill') },
        { id: 'idle', label: 'Idle', x: 2, y: 0, action: shell('idle') },
        { id: 'off', label: 'All off', x: 3, y: 0, stops: ['lights/*'], action: { type: 'none' } },
        { id: 'off2', label: 'Lights off', x: 0, y: 1, stops: ['lights/key', 'cam/rec'], action: shell('lights-off') },
      ],
    },
    {
      id: 'cam',
      name: 'Camera',
      cols: 2,
      rows: 1,
      buttons: [
        { id: 'rec', label: 'Record', x: 0, y: 0, action: shell('rec') },
        { id: 'panic', label: 'Panic', x: 1, y: 0, whileRunning: 'cancel', stops: ['*'], action: { type: 'none' } },
      ],
    },
  ],
});

describe('stops + action none', () => {
  test('patterns: pad/button, pad/*, *', () => {
    expect(matchesStop(['*'], 'a', 'b')).toBe(true);
    expect(matchesStop(['a/*'], 'a', 'b')).toBe(true);
    expect(matchesStop(['a/*'], 'x', 'b')).toBe(false);
    expect(matchesStop(['a/b'], 'a', 'b')).toBe(true);
    expect(matchesStop(['a/c', 'x/*'], 'a', 'b')).toBe(false);
  });

  test('a stop button cancels the running buttons it names (never itself) and drops their queues; none ends at once', async () => {
    const { store, runs, runOf, press, states } = fakeStore(twoPads());
    press('lights', 'key');
    press('lights', 'fill');
    expect(press('lights', 'fill').result).toBe('queued');
    press('cam', 'rec');
    expect(runs.length).toBe(3);
    const r = press('lights', 'off');
    expect(r).toMatchObject({ result: 'started', runId: 1 });
    // Killed now, in the order of the config; the queue of `fill` is gone; cam/rec untouched.
    expect(runOf('lights/key')!.kills).toBe(1);
    expect(runOf('lights/fill')!.kills).toBe(1);
    expect(runOf('cam/rec')!.kills).toBe(0);
    expect(store.get('lights/fill')).toMatchObject({ phase: 'running', cancelling: true });
    expect(store.get('lights/fill')).not.toHaveProperty('queued');
    // Action none: no spawn; success right after the running state.
    expect(runs.length).toBe(3);
    await waitFor(() => store.get('lights/off')?.phase === 'success', 1000, 'none to finish');
    expect(store.get('lights/off')).toMatchObject({ phase: 'success', runId: 1, exitCode: 0, text: 'Stopped 2' });
    expect(states.filter(([k]) => k === 'lights/off').map(([, s]) => s.phase)).toEqual(['running', 'success']);
    runOf('lights/key')!.exit({ exitCode: null, signal: 'SIGTERM', text: 'last line of key' });
    runOf('lights/fill')!.exit({ exitCode: null, signal: 'SIGTERM' });
    expect(store.get('lights/key')).toMatchObject({ phase: 'failure', reason: 'cancelled', text: 'Stopped by All off' });
    expect(store.get('lights/fill')).toMatchObject({ phase: 'failure', reason: 'cancelled', text: 'Stopped by All off' });
    expect(store.get('lights/fill')).not.toHaveProperty('queued');
    expect(store.runs({ pad: 'lights', button: 'key' })[0]).toMatchObject({ reason: 'cancelled', error: 'stopped by All off' });
    await Bun.sleep(1000); // no re-run of fill comes
    expect(runs.length).toBe(3);
    // Nothing left to stop: "Done".
    await waitFor(() => store.get('lights/off')?.phase === 'ready', 5000, 'off ready');
    press('lights', 'off');
    await waitFor(() => store.get('lights/off')?.phase === 'success', 1000, 'none again');
    expect(store.get('lights/off')).toMatchObject({ text: 'Done', runId: 2 });
  });

  test('`*` stops every other running button; a stop button with an action runs it after stopping', async () => {
    const { store, runs, runOf, press } = fakeStore(twoPads());
    press('lights', 'key');
    press('cam', 'rec');
    press('lights', 'off2'); // stops lights/key and cam/rec, then runs its own action
    expect(runOf('lights/key')!.kills).toBe(1);
    expect(runOf('cam/rec')!.kills).toBe(1);
    const own = runs.at(-1)!;
    expect(own.spec.action).toEqual(shell('lights-off'));
    expect(own.kills).toBe(0);
    runOf('lights/key')!.exit({ exitCode: null });
    runOf('cam/rec')!.exit({ exitCode: null });
    expect(store.get('cam/rec')).toMatchObject({ text: 'Stopped by Lights off' });
    // Panic (`*`) never stops itself, and stops the one still running.
    expect(press('cam', 'panic').result).toBe('started');
    expect(own.kills).toBe(1);
    await waitFor(() => store.get('cam/panic')?.phase === 'success', 1000, 'panic done');
    expect(store.get('cam/panic')).toMatchObject({ text: 'Stopped 1' });
  });

  test('a re-run waiting out its result (queued, between runs) is dropped too', async () => {
    const { store, runs, runOf, press } = fakeStore(twoPads());
    press('lights', 'fill');
    press('lights', 'fill');
    runOf('lights/fill')!.exit({ exitCode: 0 });
    expect(store.get('lights/fill')).toMatchObject({ phase: 'success', queued: true });
    press('lights', 'off');
    expect(store.get('lights/fill')).toMatchObject({ phase: 'success' });
    expect(store.get('lights/fill')).not.toHaveProperty('queued');
    await Bun.sleep(1200);
    expect(runs.length).toBe(1);
    await waitFor(() => store.get('lights/off')?.phase === 'success', 1000, 'off done');
    expect(store.get('lights/off')).toMatchObject({ text: 'Done' });
  });
});

describe('emergency stops: a `none` button with `stops` is never refused', () => {
  const stopPad = (n: number) =>
    padConfig(
      [
        ...Array.from({ length: n }, (_, i) => ({ id: `b${i}`, x: i % 6, y: Math.floor(i / 6), action: shell('x') })),
        { id: 'done', x: 4, y: 3, action: { type: 'none' as const } }, // runs nothing, stops nothing
        { id: 'off', label: 'All off', x: 5, y: 3, stops: ['*'], action: { type: 'none' as const } },
      ],
      { cols: 6, rows: 4 },
    );

  test('at maxRunning "All off" still starts and stops everything; `none` never counts toward maxRunning nor is refused by it', async () => {
    const { store, runOf, press } = fakeStore(stopPad(3), { limits: { burst: 1e9, perSec: 0, maxRunning: 2, sourceBurst: 1e9, sourcePerSec: 0 } });
    press('p', 'b0');
    press('p', 'b1');
    expect(press('p', 'b2')).toMatchObject({ result: 'ignored', refused: 'busy' });
    expect(press('p', 'done').result).toBe('started');
    expect(store.running).toBe(2); // the `none` run isn't one
    expect(press('p', 'off').result).toBe('started');
    for (const k of ['p/b0', 'p/b1']) {
      expect(runOf(k)!.kills).toBe(1);
      expect(store.get(k)).toMatchObject({ phase: 'running', cancelling: true });
    }
    await waitFor(() => store.get('p/off')?.phase === 'success', 1000, 'All off to finish');
    expect(store.get('p/off')).toMatchObject({ text: 'Stopped 2' });
  });

  test('after a device used up its presses, and all devices theirs, "All off" still gets through; with nothing (new) to stop it is an ordinary press', async () => {
    const { store, runOf, press } = fakeStore(stopPad(10), { limits: { burst: 1e9, perSec: 0, maxRunning: 1e9, sourceBurst: 10, sourcePerSec: 0 } });
    const device = store.newSource('ws 10.0.0.5', '10.0.0.5');
    for (let i = 0; i < 10; i++) expect(press('p', `b${i}`, { source: device }).result).toBe('started');
    expect(press('p', 'done', { source: device })).toMatchObject({ result: 'ignored', refused: 'rate' }); // no `stops`: limited like any press
    expect(press('p', 'off', { source: device }).result).toBe('started');
    for (let i = 0; i < 10; i++) expect(runOf(`p/b${i}`)!.kills).toBe(1);
    await waitFor(() => store.get('p/off')?.phase === 'success', 1000, 'All off to finish');
    expect(store.get('p/off')).toMatchObject({ text: 'Stopped 10' });
    // They're all on their way down: pressing it again stops nothing new, so a flood of it is still limited.
    expect(press('p', 'off', { source: device })).toMatchObject({ result: 'ignored', refused: 'rate' });

    // The limit over all devices together.
    const all = fakeStore(stopPad(4), { limits: { burst: 3, perSec: 0, maxRunning: 1e9, sourceBurst: 1e9, sourcePerSec: 0 } });
    for (let i = 0; i < 3; i++) all.press('p', `b${i}`, { source: all.store.newSource(`ws 10.0.1.${i}`) });
    expect(all.press('p', 'b3')).toMatchObject({ result: 'ignored', refused: 'rate' });
    expect(all.press('p', 'off').result).toBe('started');
    for (let i = 0; i < 3; i++) expect(all.runOf(`p/b${i}`)!.kills).toBe(1);
  });

  test("a stop that lands while a run's output is still draining (its process exited) still drops the run's queued re-run", async () => {
    const { store, runs, runOf, press } = fakeStore(twoPads());
    press('lights', 'fill');
    expect(press('lights', 'fill').result).toBe('queued');
    const fill = runOf('lights/fill')!;
    fill.draining = true;
    expect(press('lights', 'off').result).toBe('started');
    // Too late to cancel (it ends as what it was), not too late to drop what was queued behind it.
    expect(store.get('lights/fill')).toMatchObject({ phase: 'running' });
    expect(store.get('lights/fill')).not.toHaveProperty('queued');
    expect(store.get('lights/fill')).not.toHaveProperty('cancelling');
    fill.exit({ exitCode: 0, text: 'filled' });
    expect(store.get('lights/fill')).toMatchObject({ phase: 'success', text: 'filled' });
    expect(store.get('lights/fill')).not.toHaveProperty('queued');
    await Bun.sleep(1200); // past REQUEUE_GAP_MS
    expect(runs.length).toBe(1);
    expect(store.get('lights/fill')?.phase).toBe('success');
  });
});

describe('kill reasons', () => {
  test('RunRecord.error says who stopped a run: a device, another button, a config change, the shutdown, the timeout', async () => {
    const { store, runOf, press } = fakeStore({
      version: 1,
      pads: [
        {
          id: 'p',
          name: 'P',
          cols: 4,
          rows: 2,
          buttons: [
            { id: 'c', x: 0, y: 0, whileRunning: 'cancel', action: shell('x') },
            { id: 's', x: 1, y: 0, action: shell('x') },
            { id: 'stop', label: 'Stop s', x: 2, y: 0, stops: ['p/s'], action: { type: 'none' } },
            { id: 'gone', x: 3, y: 0, action: shell('x') },
            { id: 't', x: 0, y: 1, timeoutMs: 300, action: shell('x') },
            { id: 'z', x: 1, y: 1, action: shell('x') },
          ],
        },
      ],
    });
    for (const b of ['c', 's', 'gone', 't', 'z']) press('p', b);
    press('p', 'c', { source: store.newSource('ws 10.1.2.3') });
    runOf('p/c')!.exit({ exitCode: null });
    press('p', 'stop');
    runOf('p/s')!.exit({ exitCode: null });
    const removed = runOf('p/gone')!;
    store.setConfig(
      Config.parse(
        padConfig([
          { id: 'c', x: 0, y: 0, action: shell('x') },
          { id: 's', x: 1, y: 0, action: shell('x') },
          { id: 'stop', label: 'Stop s', x: 2, y: 0, stops: ['p/s'], action: { type: 'none' } },
          { id: 't', x: 0, y: 1, timeoutMs: 300, action: shell('x') },
          { id: 'z', x: 1, y: 1, action: shell('x') },
        ]),
      ),
    );
    removed.exit({ exitCode: null });
    runOf('p/t')!.exit({ exitCode: null, reason: 'timeout' });
    const z = runOf('p/z')!;
    z.kill = () => (z.exit({ exitCode: null, signal: 'SIGTERM' }), true);
    await store.shutdown(50);
    const err = (b: string) => store.runs({ button: b })[0];
    expect(err('c')).toMatchObject({ reason: 'cancelled', error: STOP_REASONS.device });
    expect(err('s')).toMatchObject({ reason: 'cancelled', error: 'stopped by Stop s' });
    expect(err('gone')).toMatchObject({ reason: 'cancelled', error: 'stopped: button removed by a config change' });
    expect(err('t')).toMatchObject({ reason: 'timeout', error: 'timed out after 300 ms' });
    expect(err('z')).toMatchObject({ reason: 'interrupted', error: 'stopped: host shutdown' });
  });

  test('host log lines', () => {
    const rec = (o: Partial<RunRecord>): RunRecord => ({ runId: 3, pad: 'p', button: 'a', startedAt: 0, stdout: '', stderr: '', ...o });
    const out = (o: Partial<RunOutcome> = {}): RunOutcome => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1234, ...o });
    expect(runEndLine('p/a', rec({ reason: 'exit' }), out({ text: 'ok' }))).toBe('✓ p/a #3 1.2s: ok');
    expect(runEndLine('p/a', rec({ reason: 'exit' }), out({ exitCode: 2 }))).toBe('✗ p/a #3 1.2s exit 2');
    expect(runEndLine('p/a', rec({ reason: 'cancelled', error: STOP_REASONS.device }), out({ exitCode: null }), 'ws 10.0.0.5')).toBe('■ p/a #3 1.2s cancelled from a device (ws 10.0.0.5)');
    expect(runEndLine('p/a', rec({ reason: 'cancelled', error: 'stopped by All off' }), out({ exitCode: null }))).toBe('■ p/a #3 1.2s stopped by All off');
    expect(runEndLine('p/a', rec({ reason: 'cancelled', error: STOP_REASONS.removed }), out({ exitCode: null }))).toBe('■ p/a #3 1.2s stopped: button removed by a config change');
    expect(runEndLine('p/a', rec({ reason: 'interrupted', error: STOP_REASONS.shutdown }), out({ exitCode: null }))).toBe('■ p/a #3 1.2s stopped: host shutdown');
    expect(runEndLine('p/a', rec({ reason: 'timeout', error: 'timed out after 2 min' }), out({ exitCode: null }))).toBe('✗ p/a #3 1.2s timed out after 2 min');
    expect(runEndLine('p/a', rec({ reason: 'spawn', error: 'command not found: /x/light.sh' }), out({ exitCode: null, text: 'command not found: light.sh' }))).toBe(
      '✗ p/a #3 1.2s could not start: command not found: /x/light.sh',
    );
  });

  test('a label is display text: its escape sequences and controls reach neither "Stopped by", RunRecord.error nor the log', async () => {
    const evil = '\u001b[41mEVIL\u001b[0m\u001b]0;pwned\u0007 ‮X‬\nOff\u009b2J';
    const { store, runOf, press, logs } = fakeStore(
      padConfig([
        { id: 'slow', x: 0, y: 0, action: shell('x') },
        { id: 'off', label: evil, x: 1, y: 0, stops: ['p/slow'], action: { type: 'none' } },
        { id: 'blank', label: '\u001b[0m\u0007', x: 2, y: 0, stops: ['p/slow'], action: { type: 'none' } },
      ]),
      { onRunEnd: (key, r, o, run) => logs.push(runEndLine(key, r, o, run.stopSource)) },
    );
    press('p', 'slow');
    press('p', 'off');
    runOf('p/slow')!.exit({ exitCode: null, signal: 'SIGTERM' });
    expect(store.get('p/slow')).toMatchObject({ phase: 'failure', reason: 'cancelled', text: 'Stopped by EVIL X Off' });
    expect(store.runs({ button: 'slow' })[0]).toMatchObject({ error: 'stopped by EVIL X Off' });
    // Nothing left of it but the words: the id when that's all there is.
    press('p', 'slow');
    press('p', 'blank');
    runOf('p/slow')!.exit({ exitCode: null, signal: 'SIGTERM' });
    expect(store.get('p/slow')).toMatchObject({ text: 'Stopped by blank' });
    expect(store.runs({ button: 'slow' })[0]).toMatchObject({ error: 'stopped by blank' });
    await Bun.sleep(10);
    expect(logs).toContainEqual(expect.stringMatching(/^■ p\/slow #1 [\d.]+s stopped by EVIL X Off$/));
    expect(logs).toContainEqual(expect.stringMatching(/^■ p\/slow #2 [\d.]+s stopped by blank$/));
    for (const l of logs) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  });

  test('host log lines carry no escape sequences or controls, whatever the run, the config or a file said', () => {
    const rec = (o: Partial<RunRecord>): RunRecord => ({ runId: 3, pad: 'p', button: 'a', startedAt: 0, stdout: '', stderr: '', ...o });
    const out = (o: Partial<RunOutcome> = {}): RunOutcome => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1234, ...o });
    expect(runEndLine('p/a', rec({ reason: 'spawn', error: 'command not found: /x/\u001b]0;t\u0007l\u009b31m.sh' }), out({ exitCode: null }))).toBe(
      '✗ p/a #3 1.2s could not start: command not found: /x/l.sh',
    );
    expect(runEndLine('p/a', rec({ reason: 'exit' }), out({ text: 'ok\u001b[2J\r\n12:00:00 ✓ fake' }))).toBe('✓ p/a #3 1.2s: ok  12:00:00 ✓ fake');
    expect(runEndLine('p/a', rec({ reason: 'cancelled', error: 'stopped by ‮All off' }), out({ exitCode: null }))).toBe('■ p/a #3 1.2s stopped by All off');
    expect(sanitizeLog('config file is invalid:\n  \u001b[31mpad\u001b[0m "x"\u0007\n  ok')).toBe('config file is invalid:\n  pad "x"\n  ok');
  });
});

describe('@state: latched device state', () => {
  test('parsed, sanitized and capped at LATCHED_MAX characters', () => {
    expect(parseDirective('@state REC ●')).toEqual({ kind: 'state', text: 'REC ●' });
    expect(parseDirective('@state')).toEqual({ kind: 'state', text: '' });
    expect(parseDirective('@stateful')).toBeUndefined();
    expect(clip('x'.repeat(100), LATCHED_MAX)).toHaveLength(LATCHED_MAX);
  });

  test('the runner reports it (null when cleared), sanitized', async () => {
    const updates: RunUpdate[] = [];
    const h = startRun(
      { action: sh(`printf '@state \\033[31mREC\\033[0m \\342\\200\\256on\\n'; sleep 0.1; printf '@state %s\\n' "$(printf 'y%.0s' $(seq 1 80))"; sleep 0.1; echo '@state'`), baseDir: tmpDir(), timeoutMs: 5000 },
      { onUpdate: (u) => updates.push(u) },
    );
    await h.done;
    const latched = updates.filter((u) => u.latched !== undefined).map((u) => u.latched);
    expect(latched[0]).toBe('REC on');
    expect(latched[1]).toHaveLength(LATCHED_MAX);
    expect(latched[1]).toEndWith('…');
    expect(latched.at(-1)).toBeNull();
  });

  test('kept per button across runs, broadcast, in hello, cleared by `@state` alone and by removing the button', async () => {
    const { store, runOf, press, latched } = fakeStore(twoPads());
    press('cam', 'rec');
    runOf('cam/rec')!.update({ latched: 'REC ●' });
    expect(latched).toEqual([['cam/rec', 'REC ●']]);
    expect(store.latched()).toEqual({ 'cam/rec': 'REC ●' });
    runOf('cam/rec')!.update({ latched: 'REC ●' }); // unchanged: no broadcast
    runOf('cam/rec')!.exit({ exitCode: 1 });
    expect(store.latched()).toEqual({ 'cam/rec': 'REC ●' }); // survives the run, even a failed one
    press('cam', 'rec');
    runOf('cam/rec')!.update({ latched: null });
    expect(latched.at(-1)).toEqual(['cam/rec', null]);
    expect(store.latched()).toEqual({});
    runOf('cam/rec')!.update({ latched: 'STANDBY' });
    store.setConfig(Config.parse({ version: 1, pads: [twoPads().pads[0]!] }));
    expect(latched.at(-1)).toEqual(['cam/rec', null]);
    expect(store.latched()).toEqual({});
  });
});

describe('sanitized text', () => {
  test('no ANSI CSI/OSC, C0/C1 controls or bidi overrides/isolates; tabs become spaces', () => {
    expect(sanitize('\x1b[31mred\x1b[0m \x1b]0;title\x07ok')).toBe('red ok');
    expect(sanitize('a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b')).toBe('alinkb');
    expect(sanitize('bell\x07 back\bspace nul\x00 del\x7f c1\x85\x9b31m')).toBe('bell backspace nul del c1');
    expect(sanitize('‮evil‬ ⁦iso⁩ ‪emb')).toBe('evil iso emb');
    expect(sanitize('a\tb\vc\fd')).toBe('a b c d');
    expect(sanitize('Grüße ● 日本 😀')).toBe('Grüße ● 日本 😀');
  });

  test('result and status text end to end (the chaos `ansi` button), and a bare \\r ends a line', async () => {
    const updates: RunUpdate[] = [];
    const h = startRun(
      {
        action: sh(`printf '@status \\033[2J\\033[Hwarming\\a up\\n'; sleep 0.1; printf '\\033[31mred\\033[0m \\033]0;title\\007 \\033[2J\\033[H bell\\a back\\bspace \\000nul \\342\\200\\256 RTL-override txet\\n'`),
        baseDir: tmpDir(),
        timeoutMs: 5000,
      },
      { onUpdate: (u) => updates.push(u) },
    );
    const o = await h.done;
    expect(updates.find((u) => u.status)?.status).toBe('warming up');
    expect(o.text).toBe('red   bell backspace nul  RTL-override txet');
    const cr = await startRun({ action: sh(`printf 'copying 10%%\\rcopying 60%%\\rcopied\\r'`), baseDir: tmpDir(), timeoutMs: 5000 }).done;
    expect(cr.text).toBe('copied');
  });
});

describe('closing the pipes after a run', () => {
  test.skipIf(process.platform === 'win32')('a background writer left behind (`(yes &); echo x`) does not keep the host busy; it is not killed, its writes fail', async () => {
    const h = startRun({ action: sh('(yes flood &); echo "@result started-yes"'), baseDir: tmpDir(), timeoutMs: 10_000 });
    try {
      const o = await h.done;
      expect(o).toMatchObject({ exitCode: 0, text: 'started-yes' });
      // Our ends are closed now: `yes` dies of SIGPIPE on its next write (nobody killed it).
      await waitFor(() => !h.alive(), 5000, 'yes to die of SIGPIPE');
      const before = process.cpuUsage();
      await Bun.sleep(500);
      const used = process.cpuUsage(before);
      // Reading `yes` takes a whole core (~500 ms of CPU in 500 ms).
      expect((used.user + used.system) / 1000).toBeLessThan(150);
    } finally {
      h.forceKill();
    }
  });
});

describe('limits', () => {
  test('TokenBucket, BucketMap', () => {
    let t = 0;
    const b = new TokenBucket(2, 1, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    t += 1000;
    expect(b.available()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.full()).toBe(false);
    t += 5000;
    expect(b.full()).toBe(true);
    const m = new BucketMap(() => new TokenBucket(1, 0, () => t), 2);
    const a = m.get('a');
    expect(m.get('a')).toBe(a);
    a.take();
    m.get('b');
    m.get('c'); // full: 'b' (refilled) is forgotten first, 'a' (in use) stays
    expect(m.get('a')).toBe(a);
    expect(m.size).toBeLessThanOrEqual(2);
  });

  test('ThrottledLog: at once, then at most once per window with a count', async () => {
    let t = 0;
    const lines: string[] = [];
    const l = new ThrottledLog((m) => lines.push(m), () => t, 10_000);
    l.note('refusing A');
    l.note('refusing B');
    l.note('refusing C');
    expect(lines).toEqual(['refusing A']);
    t += 10_000;
    l.note('refusing D');
    expect(lines).toEqual(['refusing A', 'refusing D (2 more since the last report)']);
    l.close();
    // The report at the end of a window, by the real clock.
    const real: string[] = [];
    const r = new ThrottledLog((m) => real.push(m), () => performance.now(), 200);
    r.note('x');
    r.note('y');
    r.note('z');
    await waitFor(() => real.length === 2, 3000, 'trailing report');
    expect(real).toEqual(['x', 'z (2 more in the last 0 s)']);
    r.close();
  });

  const manyButtons = () => padConfig(Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, x: i % 10, y: Math.floor(i / 10), action: shell('x') })), { cols: 10, rows: 10 });

  test(`per source: ${START_LIMITS.sourceBurst} starts at once, then ${START_LIMITS.sourcePerSec}/s; one source can't lock the others out`, () => {
    const { store, logs, clock } = fakeStore(manyButtons(), { limits: { maxRunning: 1e9 } });
    const flood = store.newSource('ws 10.0.0.66');
    const victim = store.newSource('ws 10.0.0.7');
    const results = Array.from({ length: 15 }, (_, i) => store.press('p', `b${i}`, { source: flood }));
    expect(results.filter((r) => r.result === 'started').length).toBe(START_LIMITS.sourceBurst);
    expect(results.at(-1)).toMatchObject({ result: 'ignored', refused: 'rate' });
    expect(store.press('p', 'b20', { source: victim }).result).toBe('started');
    expect(logs).toEqual([`refusing presses from ws 10.0.0.66: too many (max ${START_LIMITS.sourceBurst} at once, then ${START_LIMITS.sourcePerSec}/s per device)`]);
    clock.mono += 1000 / START_LIMITS.sourcePerSec;
    expect(store.press('p', 'b30', { source: flood }).result).toBe('started');
    expect(store.press('p', 'b31', { source: flood }).result).toBe('ignored');
    // HTTP clients: one bucket per address.
    const ip = store.addressSource('192.168.1.9');
    expect(store.addressSource('192.168.1.9').buckets).toEqual(ip.buckets);
    expect(store.addressSource('192.168.1.10').buckets[0]).not.toBe(ip.buckets[0]);
  });

  test("a device's connections and HTTP presses share its address's bucket: more sockets don't get more presses", () => {
    const { store } = fakeStore(manyButtons(), { limits: { maxRunning: 1e9 } });
    const tab1 = store.newSource('ws 10.0.0.66', '10.0.0.66');
    const tab2 = store.newSource('ws 10.0.0.66', '10.0.0.66');
    const results = Array.from({ length: 6 }, (_, i) => store.press('p', `b${i}`, { source: tab1 }).result);
    results.push(...Array.from({ length: 6 }, (_, i) => store.press('p', `b${10 + i}`, { source: tab2 }).result));
    expect(results.filter((r) => r === 'started').length).toBe(START_LIMITS.sourceBurst);
    expect(store.press('p', 'b30', { source: store.addressSource('10.0.0.66') })).toMatchObject({ result: 'ignored', refused: 'rate' });
    // Another device is unaffected.
    expect(store.press('p', 'b31', { source: store.newSource('ws 10.0.0.7', '10.0.0.7') }).result).toBe('started');
  });

  test(`over all sources together: ${START_LIMITS.burst} starts at once, then ${START_LIMITS.perSec}/s`, () => {
    const { store, logs } = fakeStore(manyButtons(), { limits: { maxRunning: 1e9 } });
    const results = [];
    for (let s = 0; s < 6; s++) {
      const src = store.newSource(`ws 10.0.1.${s}`);
      for (let i = 0; i < START_LIMITS.sourceBurst; i++) results.push(store.press('p', `b${s * 10 + i}`, { source: src }));
    }
    expect(results.filter((r) => r.result === 'started').length).toBe(START_LIMITS.burst);
    expect(results.at(-1)).toMatchObject({ result: 'ignored', refused: 'rate' });
    expect(logs).toEqual([`refusing presses: too many from all devices together (max ${START_LIMITS.burst} at once, then ${START_LIMITS.perSec}/s)`]);
  });
});

// ---------------------------------------------------------------------------------------------
// Against a real host.

const hosts: Host[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});

async function realHost(cfg: ConfigInput, opts: Partial<HostOptions> = {}) {
  const dir = tmpDir('buttpad-rt2-');
  const configPath = join(dir, 'buttpad.config.json');
  writeJson(configPath, cfg);
  const logs: string[] = [];
  const host = await startHost({ configPath, host: '127.0.0.1', port: 0, log: (m) => logs.push(m), debounceMs: 50, ...opts });
  hosts.push(host);
  const base = `http://127.0.0.1:${host.port}`;
  const ws = async (token = host.secrets.pressToken) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${host.port}/ws?token=${token}`);
    clients.push(c);
    await c.next('hello');
    return c;
  };
  const api = (path: string, method = 'GET', token = host.secrets.pressToken) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
  return { host, dir, logs, ws, api, base };
}

/** POST from another loopback address (Linux routes all of 127/8 to lo): another device, as the host sees it. */
function postFrom(localAddress: string, port: number, path: string, token: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', localAddress, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A raw WebSocket upgrade from `localAddress`; resolves with the status line and keeps the socket open. */
function rawUpgrade(port: number, path: string, localAddress?: string): Promise<{ status: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const s = connect({ port, host: '127.0.0.1', ...(localAddress ? { localAddress } : {}) }, () =>
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`),
    );
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n')) resolve({ status: buf.slice(0, buf.indexOf('\r\n')), close: () => s.destroy() });
    });
    s.on('error', reject);
  });
}

describe('over the wire', () => {
  test('stops + none end to end: All off stops the running lights; latched state in hello and broadcasts; log lines', async () => {
    const cfg = twoPads();
    cfg.pads[0]!.buttons![0]!.action = sh('echo "@state ON 80%"; sleep 30');
    cfg.pads[0]!.buttons![1]!.action = sh('sleep 30');
    const { host, ws, logs } = await realHost(cfg);
    const c = await ws();
    c.send({ t: 'press', id: '1', pad: 'lights', button: 'key' });
    c.send({ t: 'press', id: '2', pad: 'lights', button: 'fill' });
    const lat = await c.next('latched', (m) => m.key === 'lights/key');
    expect(lat).toEqual({ t: 'latched', key: 'lights/key', text: 'ON 80%' });
    const late = await ws();
    expect((late.msgs[0] as { latched: Record<string, string> }).latched).toEqual({ 'lights/key': 'ON 80%' });
    c.send({ t: 'press', id: '3', pad: 'lights', button: 'off' });
    expect(await c.next('ack', (m) => m.id === '3')).toMatchObject({ result: 'started', runId: 1 });
    const done = await c.next('state', (m) => m.key === 'lights/off' && m.state.phase === 'success');
    expect(done.state).toMatchObject({ text: 'Stopped 2' });
    for (const k of ['lights/key', 'lights/fill']) {
      const f = await c.next('state', (m) => m.key === k && m.state.phase === 'failure', 5000);
      expect(f.state).toMatchObject({ reason: 'cancelled', text: 'Stopped by All off' });
    }
    expect(logs).toContain('✓ lights/off #1 0.0s: Stopped 2');
    await eventually(async () => logs.some((l) => /^■ lights\/key #1 [\d.]+s stopped by All off/.test(l)), 3000, 'stop log line');
    const runs = (await (await fetch(`http://127.0.0.1:${host.port}/api/runs?pad=lights&button=fill`, { headers: { authorization: `Bearer ${host.secrets.adminToken}` } })).json()) as RunRecord[];
    expect(runs[0]).toMatchObject({ reason: 'cancelled', error: 'stopped by All off', command: "/bin/sh -c 'sleep 30'", cwd: host.config.dir });
    expect(host.state.latched()).toEqual({ 'lights/key': 'ON 80%' }); // device state outlives the run
  });

  test("the host log passes on no escape sequences from labels, paths or files (a reload's warnings neither)", async () => {
    const evil = '\u001b[41mEVIL\u001b[0m\u001b]0;pwned\u0007';
    const cfg = padConfig([
      { id: 'slow', x: 0, y: 0, action: sh('sleep 30') },
      { id: 'lbl', label: evil, x: 1, y: 0, stops: ['p/slow'], action: { type: 'none' } },
      { id: 'missing', x: 2, y: 0, action: { type: 'exec', command: `/nonexistent/${evil}x.sh` } },
    ]);
    const { dir, ws, logs } = await realHost(cfg);
    const c = await ws();
    c.send({ t: 'press', id: '1', pad: 'p', button: 'slow' });
    await c.next('ack', (m) => m.id === '1');
    c.send({ t: 'press', id: '2', pad: 'p', button: 'lbl' });
    c.send({ t: 'press', id: '3', pad: 'p', button: 'missing' });
    await c.next('state', (m) => m.key === 'p/slow' && m.state.phase === 'failure', 5000);
    await c.next('state', (m) => m.key === 'p/missing' && m.state.phase === 'failure', 5000);
    // A hand edit: reloaded, and its warnings logged.
    cfg.pads[0]!.name = 'Pad 2';
    writeJson(join(dir, 'buttpad.config.json'), cfg);
    await eventually(async () => logs.some((l) => l.startsWith('⚠ ')), 5000, 'the reload warnings');
    await eventually(async () => logs.some((l) => l.startsWith('■ p/slow')), 5000, 'the stop line');
    expect(logs).toContainEqual(expect.stringMatching(/^■ p\/slow #1 [\d.]+s stopped by EVIL$/));
    expect(logs).toContainEqual(expect.stringMatching(/^✗ p\/missing #1 [\d.]+s could not start: command not found: \/nonexistent\/EVILx\.sh$/));
    expect(logs).toContainEqual('⚠ pad "p" › button "missing": command not found: /nonexistent/EVILx.sh');
    for (const l of logs) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  });

  test('a cancel from a device is logged with where it came from', async () => {
    const { ws, logs } = await realHost(padConfig([{ id: 'long', x: 0, y: 0, whileRunning: 'cancel', action: sh('sleep 30') }]));
    const c = await ws();
    c.send({ t: 'press', id: '1', pad: 'p', button: 'long' });
    await c.next('ack');
    await Bun.sleep(800);
    c.send({ t: 'press', id: '2', pad: 'p', button: 'long' });
    expect(await c.next('ack', (m) => m.id === '2')).toMatchObject({ result: 'cancelling' });
    await eventually(async () => logs.some((l) => /^■ p\/long #1 [\d.]+s cancelled from a device \(ws 127\.0\.0\.1\)$/.test(l)), 5000, 'cancel log line');
  });

  test('RunRecord command/cwd; a spawn error shows press clients the base name only, admins the full path', async () => {
    const { host, dir, ws, api } = await realHost(
      padConfig([
        { id: 'args', x: 0, y: 0, action: { type: 'exec', command: './scripts/echo.sh', args: ['a b', "it's"], cwd: 'scripts/..' } },
        { id: 'missing', x: 1, y: 0, action: { type: 'exec', command: './scripts/light.sh', args: ['on'] } },
      ]),
    );
    writeExecutable(join(dir, 'scripts', 'echo.sh'), '#!/bin/sh\necho "$@"\n');
    const c = await ws();
    c.send({ t: 'press', id: '1', pad: 'p', button: 'args' });
    c.send({ t: 'press', id: '2', pad: 'p', button: 'missing' });
    const fail = await c.next('state', (m) => m.key === 'p/missing' && m.state.phase === 'failure');
    expect(fail.state).toMatchObject({ reason: 'spawn', text: 'command not found: light.sh' });
    expect(JSON.stringify(c.msgs)).not.toContain(dir);
    await c.next('state', (m) => m.key === 'p/args' && m.state.phase === 'success');
    const runs = (await (await api('/api/runs', 'GET', host.secrets.adminToken)).json()) as RunRecord[];
    const byButton = Object.fromEntries(runs.map((r) => [r.button, r]));
    expect(byButton.args).toMatchObject({ command: `${join(dir, 'scripts', 'echo.sh')} 'a b' 'it'\\''s'`, cwd: dir, reason: 'exit', exitCode: 0 });
    expect(byButton.args).not.toHaveProperty('error');
    expect(byButton.missing).toMatchObject({ reason: 'spawn', error: `command not found: ${join(dir, 'scripts', 'light.sh')}`, cwd: dir });
  });

  test('the default shell is /bin/sh even when the host was started from bash ($SHELL)', async () => {
    const saved = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    try {
      const { host, ws } = await realHost(padConfig([{ id: 'b', x: 0, y: 0, action: shell('echo "$0"') }]));
      const c = await ws();
      c.send({ t: 'press', id: '1', pad: 'p', button: 'b' });
      const done = await c.next('state', (m) => m.state.phase === 'success');
      expect(done.state).toMatchObject({ text: '/bin/sh' });
      expect(host.state.runs()[0]!.command).toBe(`/bin/sh -c 'echo "$0"'`);
    } finally {
      if (saved === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved;
    }
  });

  test('rate limits over the wire: per connection and per client address (its sockets and HTTP together); HTTP gets 503 host full', async () => {
    const buttons = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, x: i % 6, y: Math.floor(i / 6), action: { type: 'none' as const } }));
    // The default bursts, refilled too slowly to matter even on a loaded machine (the rates themselves are tested above).
    const { host, ws, api, logs } = await realHost(padConfig(buttons, { cols: 6, rows: 5 }), { limits: { presses: { sourcePerSec: 0.001, perSec: 0.001 } } });
    const flood = await ws();
    for (let i = 0; i < 14; i++) flood.send({ t: 'press', id: `f${i}`, pad: 'p', button: `b${i}` });
    await waitFor(() => flood.msgs.filter((m) => m.t === 'ack').length === 14, 5000, 'flood acks');
    const acks = flood.msgs.filter((m) => m.t === 'ack').map((m) => (m as { result: string }).result);
    expect(acks.filter((r) => r === 'started').length).toBe(START_LIMITS.sourceBurst);
    expect(acks.slice(START_LIMITS.sourceBurst)).toEqual(['ignored', 'ignored', 'ignored', 'ignored']);
    // A second connection from the same device gets no more…
    const second = await ws();
    second.send({ t: 'press', id: 's', pad: 'p', button: 'b20' });
    expect(await second.next('ack')).toMatchObject({ result: 'ignored' });
    // …nor does HTTP from it: 503, host full.
    const refused = await api('/api/press/p/b21', 'POST');
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(await refused.json()).toEqual({ ...HOST_FULL.rate, result: 'ignored' });
    expect(logs.filter((l) => l.startsWith('refusing presses')).length).toBe(1); // at most once per 10 s
    if (process.platform === 'linux') {
      // Another device (address) is not locked out.
      const other = await postFrom('127.0.0.2', host.port, '/api/press/p/b22', host.secrets.pressToken);
      expect(other).toMatchObject({ status: 200, body: { result: 'started' } });
    }
  });

  test(`at most ${MAX_CLIENTS_PER_ADDRESS} WebSocket connections per client address; 503 says the host is full`, async () => {
    const { host, ws, base, logs } = await realHost(padConfig([{ id: 'a', x: 0, y: 0, action: shell('true') }]));
    await Promise.all(Array.from({ length: MAX_CLIENTS_PER_ADDRESS }, () => ws()));
    const r = await fetch(`${base}/ws?token=${host.secrets.pressToken}`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'host full', reason: 'too many connections' });
    expect((await rawUpgrade(host.port, `/ws?token=${host.secrets.adminToken}`)).status).toStartWith('HTTP/1.1 503');
    expect(logs.filter((l) => l.startsWith('refusing WebSocket connections')).length).toBe(1);
    if (process.platform === 'linux') {
      // Another device (address) still gets in.
      const other = await rawUpgrade(host.port, `/ws?token=${host.secrets.pressToken}`, '127.0.0.2');
      expect(other.status).toStartWith('HTTP/1.1 101');
      other.close();
    }
    clients.pop()!.close();
    await eventually(async () => (await fetch(`${base}/ws?token=${host.secrets.pressToken}`)).status === 426, 3000, 'a free slot');
  });

  test.skipIf(process.platform === 'win32')('a run that leaves a background writer behind ends normally, and the host stays idle', async () => {
    const marker = `rt2-flood-${process.pid}-${Date.now()}`;
    const { ws } = await realHost(padConfig([{ id: 'bg', x: 0, y: 0, action: sh(`(yes ${marker} &) ; echo "@result started-yes"`) }]));
    const c = await ws();
    c.send({ t: 'press', id: '1', pad: 'p', button: 'bg' });
    const done = await c.next('state', (m) => m.state.phase === 'success', 5000);
    expect(done.state).toMatchObject({ text: 'started-yes' });
    await Bun.sleep(300);
    const before = process.cpuUsage();
    await Bun.sleep(500);
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000).toBeLessThan(150);
    // `yes` died of SIGPIPE: nothing of the run is alive.
    await waitFor(() => !Bun.spawnSync(['ps', '-eo', 'stat=,args=']).stdout.toString().split('\n').some((l) => l.includes(marker) && !l.trim().startsWith('Z')), 5000, 'yes to be gone');
  });
});
