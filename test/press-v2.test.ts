/**
 * Round-2 press gate: stale presses (`at` → expired), host-enforced confirm, ack.runId, queue
 * honesty (already queued → ignored; a queued re-run starts REQUEUE_GAP_MS after the result).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Config, type ConfigInput } from '../src/core/config.ts';
import { REQUEUE_GAP_MS, type RunState } from '../src/core/machine.ts';
import { PRESS_MAX_AGE_MS, type ServerMsg } from '../src/core/protocol.ts';
import { startHost, type Host } from '../src/server/host.ts';
import type { RunHandle, RunHooks, RunOutcome, RunSpec } from '../src/server/runner.ts';
import { StateStore, type PressOptions, type StateStoreOptions } from '../src/server/state-store.ts';
import { cleanupTmp, eventually, padConfig, TestClient, tmpDir, waitFor, writeJson } from './helpers.ts';

const MAIN = join(import.meta.dir, '..', 'src', 'server', 'main.ts');
const shell = (script: string) => ({ type: 'shell' as const, script });
type Buttons = NonNullable<ConfigInput['pads'][number]['buttons']>;

class FakeRun implements RunHandle {
  readonly pid = undefined;
  kills = 0;
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
    return !this.finished;
  }
  forceKill() {}
  alive() {
    return !this.finished;
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
  exit(o: Partial<RunOutcome> = {}) {
    const out: RunOutcome = { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, ...o };
    this.finished = true;
    this.hooks.onExit?.(out);
    this.resolve(out);
  }
}

/** A store with fake runs and fake clocks (`now` epoch ms, `mono` monotonic). */
function fakeStore(buttons: Buttons, opts: Partial<StateStoreOptions> = {}) {
  const runs: FakeRun[] = [];
  const logs: string[] = [];
  const clock = { now: 1_800_000_000_000, mono: 0 };
  const store = new StateStore(Config.parse(padConfig(buttons)), {
    baseDir: '/cfg',
    spawn: (spec, hooks) => {
      const r = new FakeRun(spec, hooks);
      runs.push(r);
      return r;
    },
    log: (m) => logs.push(m),
    now: () => clock.now,
    clock: () => clock.mono,
    cancelGraceMs: 0,
    limits: { burst: 1e9, perSec: 0, maxRunning: 1e9 },
    ...opts,
  });
  const press = (button: string, o: PressOptions = {}) => store.press('p', button, o);
  return { store, runs, logs, clock, press };
}

describe('stale presses (host clock)', () => {
  test(`a press older than ${PRESS_MAX_AGE_MS} ms is expired: nothing runs, it is logged`, () => {
    const { store, runs, logs, clock, press } = fakeStore([{ id: 'a', label: 'Lights', x: 0, y: 0, action: shell('x') }]);
    const acks: string[] = [];
    const r = press('a', { at: clock.now - PRESS_MAX_AGE_MS - 1, source: store.newSource('ws 10.0.0.7'), onResult: (x) => acks.push(x.result) });
    expect(r).toMatchObject({ result: 'expired', key: 'p/a' });
    expect(r.runId).toBeUndefined();
    expect(acks).toEqual(['expired']);
    expect(runs.length).toBe(0);
    expect(store.get('p/a')).toEqual({ phase: 'ready', runId: 0 });
    expect(logs).toEqual([expect.stringMatching(/^dropped a stale press of p\/a from ws 10\.0\.0\.7: made 3\.0 s ago/)]);
    // Exactly at the limit still counts; `at` in the future (clock skew) counts as now; no `at` (curl) is accepted.
    expect(press('a', { at: clock.now - PRESS_MAX_AGE_MS }).result).toBe('started');
    runs[0]!.exit();
    clock.now += 5000;
    expect(press('a', { at: clock.now + 60_000 }).result).toBe('started');
    runs[1]!.exit();
    clock.now += 5000;
    expect(press('a').result).toBe('started');
  });

  test('a frozen host (SIGSTOP, a stalled event loop) expires the presses that queued up meanwhile', () => {
    const { runs, clock, press } = fakeStore([
      { id: 'a', x: 0, y: 0, action: shell('x') },
      { id: 'b', x: 1, y: 0, action: shell('x') },
    ]);
    // Pressed just before the host froze; handled when it thawed 14 s later.
    const pressedAt = clock.now;
    clock.now += 14_000;
    expect(press('a', { at: pressedAt }).result).toBe('expired');
    expect(press('b', { at: pressedAt + 500 }).result).toBe('expired');
    expect(press('b', { at: clock.now - 10 }).result).toBe('started'); // a fresh one is fine
    expect(runs.length).toBe(1);
  });

  test('expired is checked before anything else that could act: a stale cancel cancels nothing', () => {
    const { runs, clock, press } = fakeStore([{ id: 'c', x: 0, y: 0, whileRunning: 'cancel', action: shell('x') }]);
    press('c');
    expect(press('c', { at: clock.now - 10_000 }).result).toBe('expired');
    expect(runs[0]!.kills).toBe(0);
    expect(press('c', { at: clock.now }).result).toBe('cancelling');
    expect(runs[0]!.kills).toBe(1);
  });
});

describe('host-enforced confirm', () => {
  test('a confirm button runs only with confirm: true; cancels and ignored presses need none', () => {
    const { runs, press } = fakeStore([
      { id: 'fmt', x: 0, y: 0, confirm: true, whileRunning: 'cancel', action: shell('format') },
      { id: 'q', x: 1, y: 0, confirm: true, whileRunning: 'queue', action: shell('x') },
      { id: 'plain', x: 2, y: 0, action: shell('x') },
    ]);
    expect(press('fmt').result).toBe('needs-confirm');
    expect(press('fmt', { confirm: false }).result).toBe('needs-confirm');
    expect(runs.length).toBe(0);
    expect(press('fmt', { confirm: true })).toMatchObject({ result: 'started', runId: 1 });
    // Stopping it is never dangerous: no confirm needed.
    expect(press('fmt')).toMatchObject({ result: 'cancelling', runId: 1 });
    // Queueing a re-run starts it again: confirm needed.
    expect(press('q', { confirm: true }).result).toBe('started');
    expect(press('q').result).toBe('needs-confirm');
    expect(press('q', { confirm: true })).toMatchObject({ result: 'queued', runId: 1 });
    expect(press('plain').result).toBe('started');
  });
});

describe('ack.runId and queue honesty', () => {
  test('runId: started → the new run, queued → the run it waits behind, cancelling → the run being cancelled', () => {
    const { runs, press } = fakeStore([
      { id: 'q', x: 0, y: 0, whileRunning: 'queue', action: shell('x') },
      { id: 'c', x: 1, y: 0, whileRunning: 'cancel', action: shell('x') },
      { id: 'i', x: 2, y: 0, action: shell('x') },
    ]);
    expect(press('q')).toMatchObject({ result: 'started', runId: 1 });
    expect(press('q')).toMatchObject({ result: 'queued', runId: 1 });
    const again = press('q');
    expect(again.result).toBe('ignored');
    expect(again.runId).toBeUndefined();
    expect(press('c')).toMatchObject({ result: 'started', runId: 1 });
    expect(press('c')).toMatchObject({ result: 'cancelling', runId: 1 });
    expect(press('i')).toMatchObject({ result: 'started', runId: 1 });
    expect(press('i').runId).toBeUndefined();
    expect(runs.length).toBe(3);
  });

  test(`a queued re-run starts ${REQUEUE_GAP_MS} ms after the failure it follows is reported (never hidden behind it)`, async () => {
    const states: [number, RunState][] = [];
    const { runs, press } = fakeStore([{ id: 'q', x: 0, y: 0, whileRunning: 'queue', action: shell('x') }], {
      onState: (_k, s) => states.push([performance.now(), s]),
    });
    press('q');
    press('q');
    runs[0]!.exit({ exitCode: 1, text: 'lamp did not answer' });
    const failure = states.find(([, s]) => s.phase === 'failure')!;
    expect(failure[1]).toMatchObject({ runId: 1, reason: 'exit', text: 'lamp did not answer', queued: true });
    expect(press('q').result).toBe('ignored'); // the re-run is coming
    await waitFor(() => runs.length === 2, 5000, 'the re-run');
    const rerun = states.find(([, s]) => s.phase === 'running' && s.runId === 2)!;
    expect(rerun[0] - failure[0]).toBeGreaterThanOrEqual(REQUEUE_GAP_MS - 20);
    expect(states.map(([, s]) => `${s.phase}#${s.runId}`)).toEqual(['running#1', 'running#1', 'failure#1', 'running#2']);
  });
});

// ---------------------------------------------------------------------------------------------
// Against a real host: WebSocket and HTTP.

const hosts: Host[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});
afterAll(cleanupTmp);

async function realHost(buttons: Buttons) {
  const dir = tmpDir('buttpad-press2-');
  const configPath = join(dir, 'buttpad.config.json');
  writeJson(configPath, padConfig(buttons));
  const logs: string[] = [];
  const host = await startHost({ configPath, host: '127.0.0.1', port: 0, log: (m) => logs.push(m), debounceMs: 50 });
  hosts.push(host);
  const base = `http://127.0.0.1:${host.port}`;
  const ws = async (token = host.secrets.pressToken) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${host.port}/ws?token=${token}`);
    clients.push(c);
    await c.next('hello');
    return c;
  };
  const post = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${host.secrets.pressToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { host, logs, ws, post };
}

describe('over the wire', () => {
  test('WebSocket: a stale `at` is acked expired and runs nothing; a fresh one runs; a malformed one is an error', async () => {
    const { host, ws, logs } = await realHost([{ id: 'a', x: 0, y: 0, action: shell('echo ran') }]);
    const c = await ws();
    c.send({ t: 'press', id: 'old', pad: 'p', button: 'a', at: Date.now() - 20_000 });
    expect(await c.next('ack', (m) => m.id === 'old')).toEqual({ t: 'ack', id: 'old', key: 'p/a', result: 'expired' });
    expect(host.state.get('p/a')).toEqual({ phase: 'ready', runId: 0 });
    expect(logs.some((l) => l.startsWith('dropped a stale press of p/a from ws 127.0.0.1'))).toBe(true);
    c.send({ t: 'press', id: 'new', pad: 'p', button: 'a', at: Date.now() });
    expect(await c.next('ack', (m) => m.id === 'new')).toEqual({ t: 'ack', id: 'new', key: 'p/a', result: 'started', runId: 1 });
    c.send({ t: 'press', id: 'bad', pad: 'p', button: 'a', at: 'yesterday' });
    expect((await c.next('error')).message).toContain('"at" must be a number');
    c.send({ t: 'press', id: 'bad2', pad: 'p', button: 'a', confirm: 'yes' });
    await waitFor(() => c.msgs.filter((m) => m.t === 'error').length === 2, 3000, 'second error');
  });

  test('HTTP: optional `at` (query or JSON body) and `confirm` (?confirm=1 or {"confirm": true}); 428 without confirm', async () => {
    const { host, post } = await realHost([
      { id: 'a', x: 0, y: 0, action: shell('sleep 0.2') },
      { id: 'fmt', label: 'Format card', x: 1, y: 0, confirm: true, action: shell('echo formatted') },
    ]);
    const old = Date.now() - 60_000;
    expect(await (await post(`/api/press/p/a?at=${old}`)).json()).toMatchObject({ result: 'expired' });
    expect(await (await post('/api/press/p/a', { at: old })).json()).toMatchObject({ result: 'expired' });
    expect((await post('/api/press/p/a?at=soon')).status).toBe(400);
    expect((await post('/api/press/p/a', '{nope')).status).toBe(400);
    expect((await post('/api/press/p/a', { confirm: 'yes' })).status).toBe(400);
    expect(host.state.get('p/a')?.runId).toBe(0);
    const ok = await post(`/api/press/p/a?at=${Date.now()}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ result: 'started', runId: 1, state: { phase: 'running', runId: 1 } });

    // A press token handed out by QR can't format the card with a bare curl.
    const bare = await post('/api/press/p/fmt');
    expect(bare.status).toBe(428);
    expect(await bare.json()).toMatchObject({ result: 'needs-confirm', error: expect.stringContaining('?confirm=1') });
    expect((await post('/api/press/p/fmt?confirm=0')).status).toBe(428);
    expect(host.state.get('p/fmt')?.runId).toBe(0);
    expect(await (await post('/api/press/p/fmt?confirm=1')).json()).toMatchObject({ result: 'started', runId: 1 });
    await waitFor(() => host.state.get('p/fmt')?.phase === 'success', 5000, 'format done');
    await waitFor(() => host.state.get('p/fmt')?.phase === 'ready', 5000, 'ready again');
    expect(await (await post('/api/press/p/fmt', { confirm: true })).json()).toMatchObject({ result: 'started', runId: 2 });
  });

  test('WebSocket: confirm buttons need "confirm": true; acks carry runId', async () => {
    const { host, ws } = await realHost([
      { id: 'fmt', x: 0, y: 0, confirm: true, whileRunning: 'cancel', action: shell('sleep 30') },
      { id: 'q', x: 1, y: 0, whileRunning: 'queue', action: shell('sleep 1') },
    ]);
    const c = await ws();
    c.send({ t: 'press', id: '1', pad: 'p', button: 'fmt' });
    expect(await c.next('ack', (m) => m.id === '1')).toEqual({ t: 'ack', id: '1', key: 'p/fmt', result: 'needs-confirm' });
    c.send({ t: 'press', id: '2', pad: 'p', button: 'fmt', confirm: true });
    expect(await c.next('ack', (m) => m.id === '2')).toEqual({ t: 'ack', id: '2', key: 'p/fmt', result: 'started', runId: 1 });
    await Bun.sleep(800); // past the double-press grace
    c.send({ t: 'press', id: '3', pad: 'p', button: 'fmt' });
    expect(await c.next('ack', (m) => m.id === '3')).toEqual({ t: 'ack', id: '3', key: 'p/fmt', result: 'cancelling', runId: 1 });
    c.send({ t: 'press', id: '4', pad: 'p', button: 'q' });
    c.send({ t: 'press', id: '5', pad: 'p', button: 'q' });
    c.send({ t: 'press', id: '6', pad: 'p', button: 'q' });
    expect(await c.next('ack', (m) => m.id === '5')).toMatchObject({ result: 'queued', runId: 1 });
    expect(await c.next('ack', (m) => m.id === '6')).toEqual({ t: 'ack', id: '6', key: 'p/q', result: 'ignored' });
    // The first run's result is broadcast (with queued), then the re-run starts.
    const first = await c.next('state', (m) => m.key === 'p/q' && m.state.phase === 'success' && m.state.runId === 1, 5000);
    expect(first.state).toMatchObject({ queued: true });
    const second = await c.next('state', (m) => m.key === 'p/q' && m.state.phase === 'running' && m.state.runId === 2, 5000);
    expect(c.indexOf(second)).toBeGreaterThan(c.indexOf(first));
    await waitFor(() => host.state.get('p/fmt')?.phase === 'failure', 5000, 'cancelled');
  });
});

// ---------------------------------------------------------------------------------------------
// A real host process, frozen with SIGSTOP while a press is on its way.

describe.skipIf(process.platform === 'win32')('a frozen host process', () => {
  test('a press that reaches a SIGSTOPped host is expired when the host resumes, and nothing runs', async () => {
    const dir = tmpDir('buttpad-sigstop-');
    const configPath = join(dir, 'buttpad.config.json');
    const marker = join(dir, 'ran');
    writeJson(configPath, padConfig([{ id: 'off', label: 'ALL OFF', x: 0, y: 0, action: shell(`echo ran >> '${marker}'`) }]));
    const proc = Bun.spawn([process.execPath, MAIN, '--config', configPath, '--host', '127.0.0.1', '--port', '0', '--ready-json', '--no-qr'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    let out = '';
    let err = '';
    void (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk);
    })();
    void (async () => {
      for await (const chunk of proc.stderr) err += new TextDecoder().decode(chunk);
    })();
    try {
      const line = await eventually(async () => {
        if (proc.exitCode !== null) throw new Error(`host exited: ${err}`);
        return out.includes('\n') && out.split('\n')[0];
      }, 20_000, 'ready line');
      const ready = JSON.parse(line!) as { port: number; pressToken: string };
      const c = await TestClient.connect(`ws://127.0.0.1:${ready.port}/ws?token=${ready.pressToken}`);
      clients.push(c);
      const hello = (await c.next('hello', () => true, 10_000)) as Extract<ServerMsg, { t: 'hello' }>;
      const offset = hello.serverNow - Date.now();
      proc.kill('SIGSTOP');
      try {
        // Sent now, in the host's clock: on time. The host only reads it after it thaws.
        c.send({ t: 'press', id: 'late', pad: 'p', button: 'off', at: Date.now() + offset });
        await Bun.sleep(PRESS_MAX_AGE_MS + 1500);
      } finally {
        proc.kill('SIGCONT');
      }
      expect(await c.next('ack', (m) => m.id === 'late', 10_000)).toEqual({ t: 'ack', id: 'late', key: 'p/off', result: 'expired' });
      await eventually(async () => err.includes('dropped a stale press of p/off'), 5000, 'the log line');
      expect(await Bun.file(marker).exists()).toBe(false);
      // Once thawed, a fresh press works.
      c.send({ t: 'press', id: 'now', pad: 'p', button: 'off', at: Date.now() + offset });
      expect(await c.next('ack', (m) => m.id === 'now', 10_000)).toMatchObject({ result: 'started', runId: 1 });
      await eventually(async () => (await Bun.file(marker).exists()) && (await Bun.file(marker).text()) === 'ran\n', 10_000, 'the run');
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
    }
  }, 60_000);
});
