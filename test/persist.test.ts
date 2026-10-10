/**
 * buttpad.state.json: run ids, last results and latched state survive a restart; runs a crashed
 * host left running are stopped by the next one (only when provably the same process) and shown
 * as interrupted; a graceful shutdown records what it stopped.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Config, type ConfigInput } from '../src/core/config.ts';
import type { RunState } from '../src/core/machine.ts';
import type { RunRecord, ServerMsg } from '../src/core/protocol.ts';
import { startHost, type Host } from '../src/server/host.ts';
import { SAVE_INTERVAL_MS, STATE_FILE, type PersistedState } from '../src/server/persist.ts';
import { processFingerprint } from '../src/server/proc.ts';
import type { RunHandle, RunHooks, RunOutcome, RunSpec, RunUpdate } from '../src/server/runner.ts';
import { INTERRUPTED_TEXT, StateStore, type StateStoreOptions } from '../src/server/state-store.ts';
import { cleanupTmp, eventually, isAlive, padConfig, readJson, TestClient, tmpDir, waitFor, writeJson } from './helpers.ts';

const MAIN = join(import.meta.dir, '..', 'src', 'server', 'main.ts');
const posix = process.platform !== 'win32';
const linux = process.platform === 'linux';
const shell = (script: string) => ({ type: 'shell' as const, script });
type Buttons = NonNullable<ConfigInput['pads'][number]['buttons']>;

/** Detached `sleep`s (own process group), killed after each test. */
const sleepers: number[] = [];
function sleeper(): number {
  const p = Bun.spawn(['sleep', '60'], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  sleepers.push(p.pid);
  return p.pid;
}
const hosts: Host[] = [];
const clients: TestClient[] = [];
const procs: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  for (const p of procs.splice(0)) {
    p.kill('SIGKILL');
    await p.exited;
  }
  for (const pid of sleepers.splice(0))
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
});
afterAll(cleanupTmp);

/** A run handle for a real process we spawned ourselves (so a "crash" can leave it behind). */
class ProcRun implements RunHandle {
  finished = false;
  readonly done: Promise<RunOutcome>;
  private resolve!: (o: RunOutcome) => void;
  constructor(
    readonly pid: number | undefined,
    readonly hooks: RunHooks,
  ) {
    this.done = new Promise((r) => (this.resolve = r));
  }
  kill() {
    if (this.finished || this.pid === undefined) return false;
    try {
      process.kill(-this.pid, 'SIGTERM');
    } catch {}
    return true;
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

function storeAt(dir: string, buttons: Buttons, opts: Partial<StateStoreOptions> & { pids?: () => number | undefined } = {}) {
  const runs: ProcRun[] = [];
  const logs: string[] = [];
  const states: [string, RunState][] = [];
  const store = new StateStore(Config.parse(padConfig(buttons)), {
    baseDir: dir,
    statePath: join(dir, STATE_FILE),
    spawn: (_spec: RunSpec, hooks) => {
      const r = new ProcRun(opts.pids?.(), hooks);
      runs.push(r);
      return r;
    },
    log: (m) => logs.push(m),
    onState: (k, s) => states.push([k, s]),
    cancelGraceMs: 0,
    ...opts,
  });
  store.recover();
  return { store, runs, logs, states, path: join(dir, STATE_FILE) };
}

const readState = (path: string) => readJson<PersistedState>(path);

describe('across restarts (in-process)', () => {
  test('run ids continue; the last result (READY.last) and latched state come back', async () => {
    const dir = tmpDir('buttpad-persist-');
    const buttons: Buttons = [{ id: 'a', x: 0, y: 0, resultHoldMs: 0, action: shell('x') }];
    const one = storeAt(dir, buttons);
    expect(one.logs).toEqual([`state: no ${one.path} yet; starting fresh`]);
    for (let i = 0; i < 3; i++) {
      one.store.press('p', 'a');
      one.runs.at(-1)!.update({ latched: i === 2 ? 'REC ●' : 'STANDBY' });
      one.runs.at(-1)!.exit({ exitCode: i === 2 ? 4 : 0, text: `take ${i + 1}` });
      await waitFor(() => one.store.get('p/a')?.phase === 'ready', 2000, 'ready');
    }
    const last = (one.store.get('p/a') as Extract<RunState, { phase: 'ready' }>).last!;
    expect(last).toMatchObject({ runId: 3, ok: false, reason: 'exit', text: 'take 3' });
    await one.store.shutdown(50);
    expect(statSync(one.path).mode & 0o777).toBe(0o600);
    expect(readState(one.path)).toMatchObject({ version: 1, buttons: { 'p/a': { lastRunId: 3, last, latched: 'REC ●' } }, live: [] });

    const two = storeAt(dir, buttons);
    expect(two.logs).toEqual([]);
    expect(two.store.get('p/a')).toEqual({ phase: 'ready', runId: 3, last });
    expect(two.store.latched()).toEqual({ 'p/a': 'REC ●' });
    expect(two.store.press('p', 'a')).toMatchObject({ result: 'started', runId: 4 });
    await two.store.shutdown(50);
  });

  test.skipIf(!posix)('a crash mid-run: the next host stops the leftover process group and shows the run as interrupted', async () => {
    const dir = tmpDir('buttpad-persist-');
    const buttons: Buttons = [{ id: 'rec', label: 'Record', x: 0, y: 0, resultHoldMs: 300, action: shell('x') }];
    const pid = sleeper();
    const crashed = storeAt(dir, buttons, { pids: () => pid });
    crashed.store.press('p', 'rec');
    crashed.store.press('p', 'rec'); // ignored: running
    // The start is saved right away (well, within a few ms), with the process's fingerprint.
    await waitFor(() => {
      try {
        return readState(crashed.path).live.length === 1;
      } catch {
        return false;
      }
    }, 2000, 'live run saved');
    const saved = readState(crashed.path).live[0]!;
    expect(saved).toMatchObject({ key: 'p/rec', runId: 1, pid, pgid: pid });
    if (linux) expect(saved.fingerprint).toBe(processFingerprint(pid)!);
    else await waitFor(() => readState(crashed.path).live[0]?.fingerprint, 3000, 'fingerprint');
    // …and the host dies without a word (nothing else of `crashed` runs from here on).

    const next = storeAt(dir, buttons);
    await waitFor(() => !isAlive(pid), 3000, 'the leftover to be stopped');
    expect(next.logs).toEqual([`■ p/rec #1 was interrupted when the previous host stopped (still running as pid ${pid}: stopping it)`]);
    expect(next.states[0]).toEqual(['p/rec', { phase: 'failure', runId: 1, startedAt: saved.startedAt, endedAt: expect.any(Number), exitCode: null, reason: 'interrupted', text: INTERRUPTED_TEXT }]);
    expect(next.store.runs()[0]).toMatchObject({ runId: 1, reason: 'interrupted', error: expect.stringContaining('interrupted: the host stopped while it ran') });
    await waitFor(() => next.store.get('p/rec')?.phase === 'ready', 3000, 'ready');
    expect(next.store.get('p/rec')).toMatchObject({ phase: 'ready', runId: 1, last: { runId: 1, ok: false, reason: 'interrupted', text: INTERRUPTED_TEXT } });
    expect(next.store.press('p', 'rec')).toMatchObject({ result: 'started', runId: 2 });
    expect(readState(next.path).live.map((e) => e.runId)).toEqual([]); // ProcRun has no pid here
    await next.store.shutdown(50);
  });

  test.skipIf(!posix)('PID reuse: a live process with another fingerprint is left alone (the button still shows interrupted)', async () => {
    const dir = tmpDir('buttpad-persist-');
    const pid = sleeper();
    const state: PersistedState = {
      version: 1,
      savedAt: Date.now() - 60_000,
      buttons: { 'p/a': { lastRunId: 4 } },
      live: [
        { key: 'p/a', runId: 5, pid, pgid: pid, startedAt: Date.now() - 120_000, fingerprint: 'linux:not-this-boot:12345' },
        { key: 'p/b', runId: 2, pid, pgid: pid, startedAt: Date.now() - 120_000 }, // no fingerprint: never signalled
      ],
    };
    writeJson(join(dir, STATE_FILE), state);
    const { store, logs } = storeAt(dir, [
      { id: 'a', x: 0, y: 0, action: shell('x') },
      { id: 'b', x: 1, y: 0, action: shell('x') },
    ]);
    await Bun.sleep(300);
    expect(isAlive(pid)).toBe(true);
    expect(logs).toEqual([
      `■ p/a #5 was interrupted when the previous host stopped (pid ${pid} is another process now: left alone)`,
      `■ p/b #2 was interrupted when the previous host stopped (pid ${pid} is another process now: left alone)`,
    ]);
    expect(store.get('p/a')).toMatchObject({ phase: 'failure', runId: 5, reason: 'interrupted' });
    expect(store.press('p', 'a')).toMatchObject({ result: 'started', runId: 6 });
    await store.shutdown(50);
  });

  test('a missing, corrupt or foreign state file means starting fresh (and saying so); the next save replaces it', async () => {
    const dir = tmpDir('buttpad-persist-');
    const path = join(dir, STATE_FILE);
    const buttons: Buttons = [{ id: 'a', x: 0, y: 0, action: shell('x') }];
    for (const [content, why] of [
      ['{"version": 1, "buttons": ', /^state: can't use .+ \(invalid JSON/],
      ['[1, 2, 3]', /\(not a JSON object\); starting fresh$/],
      ['{"version": 99}', /\(unknown version 99\); starting fresh$/],
    ] as const) {
      writeFileSync(path, content);
      const { store, logs } = storeAt(dir, buttons);
      expect(logs).toEqual([expect.stringMatching(why)]);
      expect(store.get('p/a')).toEqual({ phase: 'ready', runId: 0 });
      store.press('p', 'a');
      await store.shutdown(20);
      expect(readState(path).buttons['p/a']!.lastRunId).toBe(1);
    }
    // Junk inside a valid file is dropped, the rest kept.
    writeJson(path, { version: 1, buttons: { 'p/a': { lastRunId: 7, last: { runId: 'x' }, latched: '‮REC\x1b[31m' }, bogus: 3 }, live: [{ key: 'p/a' }] });
    const { store } = storeAt(dir, buttons);
    expect(store.get('p/a')).toEqual({ phase: 'ready', runId: 7 });
    expect(store.latched()).toEqual({ 'p/a': 'REC' });
    await store.shutdown(20);
  });

  test.skipIf(!posix || !Bun.which('mkfifo'))('a FIFO where the state file should be: no hang, start fresh, saves fail loudly once, presses still work', async () => {
    const dir = tmpDir('buttpad-persist-');
    const path = join(dir, STATE_FILE);
    expect(Bun.spawnSync(['mkfifo', path]).success).toBe(true);
    const { store, runs, logs } = storeAt(dir, [{ id: 'a', x: 0, y: 0, action: shell('x') }]); // would block forever on a plain read
    expect(logs).toEqual([`state: can't use ${path} (not a regular file: it is a named pipe (FIFO)); starting fresh`]);
    expect(store.press('p', 'a')).toMatchObject({ result: 'started', runId: 1 });
    runs[0]!.exit({ exitCode: 0 });
    await waitFor(() => logs.some((l) => l.startsWith(`state: cannot save ${path}`)), 2000, 'the save failure');
    expect(store.get('p/a')?.phase).toBe('success');
    await store.shutdown(20);
    expect(logs.filter((l) => l.includes('cannot save')).length).toBe(1);
  });

  test(`saves are throttled: routine ones at most every ${SAVE_INTERVAL_MS} ms; a run start or end soon after`, async () => {
    const dir = tmpDir('buttpad-persist-');
    const writes: number[] = [];
    const t0 = performance.now();
    const { store, runs } = storeAt(dir, [{ id: 'a', x: 0, y: 0, action: shell('x') }], { stateWrite: () => void writes.push(performance.now() - t0) });
    store.press('p', 'a');
    await waitFor(() => writes.length === 1, 1000, 'the start saved');
    expect(writes[0]!).toBeLessThan(1000);
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      runs[0]!.update({ latched: `level ${i}` });
      await Bun.sleep(20);
    }
    const secs = (performance.now() - start) / 1000;
    await Bun.sleep(SAVE_INTERVAL_MS + 50);
    const routine = writes.length - 1;
    expect(routine).toBeGreaterThanOrEqual(2);
    expect(routine).toBeLessThanOrEqual(Math.ceil(secs * (1000 / SAVE_INTERVAL_MS)) + 1);
    const before = writes.length;
    runs[0]!.exit({ exitCode: 0 });
    await waitFor(() => writes.length > before, 1000, 'the end saved');
    await store.shutdown(20);
  });

  test("a save that fails is logged once and doesn't stop the host; it recovers", async () => {
    const dir = tmpDir('buttpad-persist-');
    let fail = true;
    let ok = 0;
    const { store, runs, logs } = storeAt(dir, [{ id: 'a', x: 0, y: 0, action: shell('x') }], {
      stateWrite: () => {
        if (fail) throw new Error('could not write: no space left on device (ENOSPC)');
        ok++;
      },
    });
    store.press('p', 'a');
    await Bun.sleep(150);
    runs[0]!.update({ latched: 'x' });
    await Bun.sleep(400);
    expect(logs.filter((l) => l.includes('cannot save')).length).toBe(1);
    fail = false;
    runs[0]!.exit({ exitCode: 0 });
    await waitFor(() => ok > 0, 2000, 'a save that works');
    expect(logs.at(-1)).toMatch(/^state: saving .* works again$/);
    expect(store.get('p/a')?.phase).toBe('success');
    await store.shutdown(20);
  });

  test.skipIf(!posix)("a state file of another host that is still running: its runs aren't touched, nothing is saved", async () => {
    const dir = tmpDir('buttpad-persist-');
    const other = sleeper(); // stands in for the other host process
    const run = sleeper();
    writeJson(join(dir, STATE_FILE), {
      version: 1,
      savedAt: Date.now(),
      host: { pid: other, fingerprint: processFingerprint(other) },
      buttons: { 'p/a': { lastRunId: 3 } },
      live: [{ key: 'p/a', runId: 4, pid: run, pgid: run, startedAt: Date.now(), fingerprint: processFingerprint(run) }],
    });
    let writes = 0;
    const { store, logs } = storeAt(dir, [{ id: 'a', x: 0, y: 0, action: shell('x') }], { stateWrite: () => void writes++ });
    expect(logs).toEqual([expect.stringContaining(`belongs to another ButtPad host that is still running (pid ${other})`)]);
    await Bun.sleep(300);
    expect(isAlive(run)).toBe(true);
    expect(store.get('p/a')).toEqual({ phase: 'ready', runId: 4 });
    store.press('p', 'a');
    await store.shutdown(20);
    expect(writes).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Real hosts.

async function inProcessHost(dir: string) {
  const logs: string[] = [];
  const host = await startHost({ configPath: join(dir, 'buttpad.config.json'), host: '127.0.0.1', port: 0, log: (m) => logs.push(m), debounceMs: 50 });
  hosts.push(host);
  const ws = async (token = host.secrets.pressToken) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${host.port}/ws?token=${token}`);
    clients.push(c);
    return { c, hello: (await c.next('hello')) as Extract<ServerMsg, { t: 'hello' }> };
  };
  return { host, logs, ws };
}

describe('graceful shutdown', () => {
  test('stopping the host records the runs it stopped; the next host shows them interrupted, READY.last in hello', async () => {
    const dir = tmpDir('buttpad-persist-');
    writeJson(join(dir, 'buttpad.config.json'), padConfig([{ id: 'long', label: 'Long', x: 0, y: 0, resultHoldMs: 400, action: shell('echo "@state ON"; sleep 30') }]));
    const one = await inProcessHost(dir);
    const { c } = await one.ws();
    c.send({ t: 'press', id: '1', pad: 'p', button: 'long' });
    await c.next('latched');
    await one.host.stop();
    hosts.splice(hosts.indexOf(one.host), 1);
    const rec = one.host.state.runs()[0]!;
    expect(rec).toMatchObject({ runId: 1, reason: 'interrupted', error: 'stopped: host shutdown' });
    expect(one.logs).toContainEqual(expect.stringMatching(/^■ p\/long #1 [\d.]+s stopped: host shutdown$/));
    const saved = readState(join(dir, STATE_FILE));
    expect(saved.live).toEqual([expect.objectContaining({ key: 'p/long', runId: 1, stopped: 'shutdown', endedAt: rec.endedAt })]);

    const two = await inProcessHost(dir);
    expect(two.logs).toContainEqual('■ p/long #1 was interrupted when the previous host stopped (stopped by the shutdown)');
    const { c: c2, hello } = await two.ws();
    expect(hello.states['p/long']).toMatchObject({ phase: 'failure', runId: 1, reason: 'interrupted', text: INTERRUPTED_TEXT });
    expect(hello.latched).toEqual({ 'p/long': 'ON' });
    const ready = await c2.next('state', (m) => m.state.phase === 'ready', 5000);
    expect(ready.state).toMatchObject({ runId: 1, last: { runId: 1, ok: false, reason: 'interrupted', text: INTERRUPTED_TEXT } });
    const runs = (await (await fetch(`http://127.0.0.1:${two.host.port}/api/runs`, { headers: { authorization: `Bearer ${two.host.secrets.adminToken}` } })).json()) as RunRecord[];
    expect(runs[0]).toMatchObject({ runId: 1, reason: 'interrupted', error: 'stopped: host shutdown', command: `/bin/sh -c 'echo "@state ON"; sleep 30'` });
    // A late hello still has READY.last.
    const { hello: late } = await two.ws();
    expect(late.states['p/long']).toMatchObject({ phase: 'ready', last: { reason: 'interrupted' } });
    c2.send({ t: 'press', id: '2', pad: 'p', button: 'long' });
    expect(await c2.next('ack')).toMatchObject({ result: 'started', runId: 2 });
  });
});

describe('a second host on the same config', () => {
  test("one that can't listen (port taken) says nothing about the state file and never touches the running host's actions", async () => {
    const dir = tmpDir('buttpad-persist-');
    writeJson(join(dir, 'buttpad.config.json'), padConfig([{ id: 'long', x: 0, y: 0, action: shell('sleep 30') }]));
    const one = await inProcessHost(dir);
    const { c } = await one.ws();
    c.send({ t: 'press', id: '1', pad: 'p', button: 'long' });
    await c.next('ack');
    await waitFor(() => {
      try {
        return readState(join(dir, STATE_FILE)).live.length === 1;
      } catch {
        return false;
      }
    }, 2000, 'the run saved');
    const logs: string[] = [];
    await expect(startHost({ configPath: join(dir, 'buttpad.config.json'), host: '127.0.0.1', port: one.host.port, log: (m) => logs.push(m) })).rejects.toThrow();
    expect(logs.filter((l) => l.startsWith('state:') || l.includes('interrupted'))).toEqual([]);
    await Bun.sleep(300);
    expect(one.host.state.get('p/long')).toMatchObject({ phase: 'running', runId: 1 });
    expect(one.host.state.running).toBe(1);
  });
});

describe.skipIf(!posix)('a host killed with SIGKILL (a real crash)', () => {
  function spawnHost(configPath: string) {
    const proc = Bun.spawn([process.execPath, MAIN, '--config', configPath, '--host', '127.0.0.1', '--port', '0', '--ready-json', '--no-qr'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    procs.push(proc);
    const io = { out: '', err: '' };
    void (async () => {
      for await (const chunk of proc.stdout) io.out += new TextDecoder().decode(chunk);
    })();
    void (async () => {
      for await (const chunk of proc.stderr) io.err += new TextDecoder().decode(chunk);
    })();
    const ready = eventually(async () => {
      if (proc.exitCode !== null) throw new Error(`host exited: ${io.err}`);
      return io.out.includes('\n') && (JSON.parse(io.out.split('\n')[0]!) as { port: number; pressToken: string; adminToken: string });
    }, 20_000, 'ready line');
    return { proc, io, ready };
  }

  test('its actions are stopped by the next host (SIGKILL after 2 s for one that ignores SIGTERM), never run twice, ids continue', async () => {
    const dir = tmpDir('buttpad-crash-');
    const configPath = join(dir, 'buttpad.config.json');
    const marker = join(dir, 'renders');
    writeJson(
      configPath,
      padConfig([
        { id: 'render', label: 'Render', x: 0, y: 0, trigger: 'tap', resultHoldMs: 1500, action: shell(`echo started >> '${marker}'; sleep 30; echo done >> '${marker}'`) },
        { id: 'stubborn', x: 1, y: 0, trigger: 'tap', resultHoldMs: 1500, action: shell(`trap '' TERM; while :; do sleep 0.2; done`) },
      ]),
    );
    const a = spawnHost(configPath);
    const ra = await a.ready;
    const post = (port: number, token: string, b: string) => fetch(`http://127.0.0.1:${port}/api/press/p/${b}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect((await (await post(ra.port, ra.pressToken, 'render')).json()).result).toBe('started');
    expect((await (await post(ra.port, ra.pressToken, 'stubborn')).json()).result).toBe('started');
    const statePath = join(dir, STATE_FILE);
    const live = await eventually(async () => {
      try {
        const l = readState(statePath).live;
        return l.length === 2 && l.every((e) => e.fingerprint) && l;
      } catch {
        return false;
      }
    }, 5000, 'both runs saved');
    const pidOf = (k: string) => live.find((e) => e.key === k)!.pid;
    a.proc.kill('SIGKILL');
    await a.proc.exited;
    await Bun.sleep(200);
    expect(isAlive(pidOf('p/render'))).toBe(true); // the crash left them running
    expect(isAlive(pidOf('p/stubborn'))).toBe(true);

    const b = spawnHost(configPath);
    const rb = await b.ready;
    await waitFor(() => !isAlive(pidOf('p/render')), 3000, 'render to be stopped');
    const c = await TestClient.connect(`ws://127.0.0.1:${rb.port}/ws?token=${rb.pressToken}`);
    clients.push(c);
    const hello = (await c.next('hello')) as Extract<ServerMsg, { t: 'hello' }>;
    expect(hello.states['p/render']).toMatchObject({ phase: 'failure', runId: 1, reason: 'interrupted', text: INTERRUPTED_TEXT });
    expect(hello.states['p/stubborn']).toMatchObject({ phase: 'failure', runId: 1, reason: 'interrupted' });
    // The stubborn one is still going down (SIGTERM ignored): no second instance meanwhile.
    if (isAlive(pidOf('p/stubborn'))) {
      c.send({ t: 'press', id: 'too-soon', pad: 'p', button: 'stubborn' });
      expect(await c.next('ack', (m) => m.id === 'too-soon')).toMatchObject({ result: 'ignored' });
    }
    // It ignores SIGTERM: only the SIGKILL after the grace period ends it.
    await waitFor(() => !isAlive(pidOf('p/stubborn')), 5000, 'stubborn to be SIGKILLed');
    expect(b.io.err).toContain(`■ p/render #1 was interrupted when the previous host stopped (still running as pid ${pidOf('p/render')}: stopping it)`);
    // The render ran once, and never finished.
    expect(readFileSync(marker, 'utf8')).toBe('started\n');
    const ready = await c.next('state', (m) => m.key === 'p/render' && m.state.phase === 'ready', 5000);
    expect(ready.state).toMatchObject({ runId: 1, last: { ok: false, reason: 'interrupted', text: INTERRUPTED_TEXT } });
    c.send({ t: 'press', id: 'again', pad: 'p', button: 'render' });
    expect(await c.next('ack', (m) => m.id === 'again')).toMatchObject({ result: 'started', runId: 2 });
    await eventually(async () => readFileSync(marker, 'utf8') === 'started\nstarted\n', 5000, 'the second render');
    b.proc.kill('SIGTERM');
    await b.proc.exited;
    expect(readFileSync(marker, 'utf8')).toBe('started\nstarted\n');
    expect(readState(statePath).live).toEqual([expect.objectContaining({ key: 'p/render', runId: 2, stopped: 'shutdown' })]);
  }, 60_000);

  test('a state file left 0644 by hand is written back 0600', async () => {
    const dir = tmpDir('buttpad-persist-');
    const path = join(dir, STATE_FILE);
    writeJson(path, { version: 1, buttons: {}, live: [] });
    chmodSync(path, 0o644);
    const { store } = storeAt(dir, [{ id: 'a', x: 0, y: 0, action: shell('x') }]);
    store.press('p', 'a');
    await store.shutdown(20);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
