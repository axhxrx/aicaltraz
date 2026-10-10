import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { ConfigInput } from '../src/core/config.ts';
import type { RunRecord } from '../src/core/protocol.ts';
import { revOf } from '../src/server/config-store.ts';
import { MAX_CLIENTS, startHost, type Host, type HostOptions } from '../src/server/host.ts';
import { CANCEL_GRACE_MS } from '../src/server/state-store.ts';
import { cleanupTmp, eventually, isAlive, readJson, TestClient, tmpDir, waitFor, writeExecutable, writeJson } from './helpers.ts';

const baseConfig = (): ConfigInput => ({
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 3,
      rows: 3,
      buttons: [
        { id: 'quick', label: 'Quick', x: 0, y: 0, resultHoldMs: 300, action: { type: 'exec', command: './scripts/quick.sh' } },
        { id: 'long', label: 'Long', x: 1, y: 0, whileRunning: 'cancel', action: { type: 'shell', script: 'sleep 30 & echo "@status child $!"; wait' } },
        { id: 'secret', x: 2, y: 0, action: { type: 'shell', script: 'echo SECRET-COMMAND' } },
      ],
    },
  ],
});

interface Ctx {
  host: Host;
  dir: string;
  configPath: string;
  base: string;
  press: string;
  admin: string;
  ws(token: string): Promise<TestClient>;
  api(path: string, opts?: { method?: string; token?: string | null; body?: unknown; raw?: string }): Promise<Response>;
}

const hosts: Host[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  cleanupTmp();
});

async function setup(cfg: ConfigInput = baseConfig(), opts: Partial<HostOptions> = {}): Promise<Ctx> {
  const dir = tmpDir('buttpad-host-');
  writeExecutable(join(dir, 'scripts', 'quick.sh'), '#!/bin/sh\necho "@status working"\nsleep 0.1\necho "@result quick done"\n');
  const configPath = join(dir, 'buttpad.config.json');
  writeJson(configPath, cfg);
  const host = await startHost({ configPath, host: '127.0.0.1', port: 0, log: () => {}, debounceMs: 50, ...opts });
  hosts.push(host);
  const base = `http://127.0.0.1:${host.port}`;
  return {
    host,
    dir,
    configPath,
    base,
    press: host.secrets.pressToken,
    admin: host.secrets.adminToken,
    ws: async (token) => {
      const c = await TestClient.connect(`ws://127.0.0.1:${host.port}/ws?token=${encodeURIComponent(token)}`);
      clients.push(c);
      return c;
    },
    api: (path, o = {}) => {
      const headers: Record<string, string> = {};
      if (o.token !== null) headers.authorization = `Bearer ${o.token ?? host.secrets.pressToken}`;
      if (o.body !== undefined || o.raw !== undefined) headers['content-type'] = 'application/json';
      return fetch(base + path, { method: o.method ?? 'GET', headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
    },
  };
}

/** Sends a real WebSocket upgrade request and returns the response status line. */
function rawUpgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () =>
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
      ),
    );
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n')) {
        s.destroy();
        resolve(buf.slice(0, buf.indexOf('\r\n')));
      }
    });
    s.on('error', reject);
  });
}

describe('auth', () => {
  test('health needs no token, and tells nothing about the machine', async () => {
    const { api } = await setup();
    const r = await api('/api/health', { token: null });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, protocol: 1, version: expect.any(String) });
  });

  test('401 for missing, malformed or wrong tokens on every protected route', async () => {
    const { api } = await setup();
    const routes: [string, string][] = [
      ['GET', '/api/config'],
      ['PUT', '/api/config'],
      ['GET', '/api/state'],
      ['POST', '/api/press/main/quick'],
      ['GET', '/api/runs'],
    ];
    for (const [method, path] of routes)
      for (const token of [null, 'wrong', '', 'x'.repeat(43)]) {
        const r = await api(path, { method, token });
        expect(r.status).toBe(401);
        expect(r.headers.get('www-authenticate')).toBe('Bearer');
        expect(await r.json()).toEqual({ error: 'unauthorized' });
      }
    const basic = await fetch(`${(await setup()).base}/api/state`, { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    expect(basic.status).toBe(401);
  });

  test('WebSocket upgrade is rejected with 401 without a valid token', async () => {
    const { host, press, admin } = await setup();
    expect(await rawUpgrade(host.port, '/ws')).toStartWith('HTTP/1.1 401');
    expect(await rawUpgrade(host.port, '/ws?token=wrong')).toStartWith('HTTP/1.1 401');
    expect(await rawUpgrade(host.port, `/ws?token=${press}`)).toStartWith('HTTP/1.1 101');
    expect(await rawUpgrade(host.port, `/ws?token=${admin}`)).toStartWith('HTTP/1.1 101');
    await expect(TestClient.connect(`ws://127.0.0.1:${host.port}/ws?token=nope`)).rejects.toThrow();
    // A valid token without an upgrade is not a WebSocket.
    const plain = await fetch(`http://127.0.0.1:${host.port}/ws?token=${press}`);
    expect(plain.status).toBe(426);
  });

  test('WebSocket upgrades from a page of another origin are refused with 403', async () => {
    const { host, press } = await setup();
    const path = `/ws?token=${press}`;
    expect(await rawUpgrade(host.port, path, { Origin: `http://127.0.0.1:${host.port}` })).toStartWith('HTTP/1.1 101');
    expect(await rawUpgrade(host.port, path, { Origin: 'http://evil.example' })).toStartWith('HTTP/1.1 403');
    expect(await rawUpgrade(host.port, path, { Origin: `http://127.0.0.1:${host.port + 1}` })).toStartWith('HTTP/1.1 403');
    expect(await rawUpgrade(host.port, path, { Origin: 'null' })).toStartWith('HTTP/1.1 403');
    expect(await rawUpgrade(host.port, '/ws?token=wrong', { Origin: 'http://evil.example' })).toStartWith('HTTP/1.1 403');
  });

  test(`at most ${MAX_CLIENTS} WebSocket connections; more are refused with 503`, async () => {
    const { host, ws, press, admin } = await setup();
    const open = await Promise.all(Array.from({ length: MAX_CLIENTS }, (_, i) => ws(i % 2 ? press : admin)));
    expect(await rawUpgrade(host.port, `/ws?token=${admin}`)).toStartWith('HTTP/1.1 503');
    await expect(TestClient.connect(`ws://127.0.0.1:${host.port}/ws?token=${press}`)).rejects.toThrow();
    open[0]!.close();
    await eventually(async () => (await rawUpgrade(host.port, `/ws?token=${press}`)).startsWith('HTTP/1.1 101'), 3000, 'a free slot');
  });

  test('Bun dev mode (HMR socket, source maps) is off unless asked for', async () => {
    const { host } = await setup();
    expect(await rawUpgrade(host.port, '/_bun/hmr')).toStartWith('HTTP/1.1 404');
    // The same request reaches the HMR socket in dev mode, so the check above means something.
    const dev = await setup(baseConfig(), { development: true });
    expect(await rawUpgrade(dev.host.port, '/_bun/hmr')).toStartWith('HTTP/1.1 101');
  });

  test('press role: redacted config, 403 on admin routes; admin: full config', async () => {
    const { api, admin, host } = await setup();
    const pr = await api('/api/config');
    expect(pr.status).toBe(200);
    const pressBody = await pr.json();
    expect(pressBody.rev).toBe(host.config.rev);
    expect(JSON.stringify(pressBody)).not.toContain('"action"');
    expect(JSON.stringify(pressBody)).not.toContain('SECRET-COMMAND');
    expect(pressBody.config.pads[0].buttons[0]).toMatchObject({ id: 'quick', label: 'Quick', x: 0, y: 0, holdMs: 500, trigger: 'hold' });

    const ar = await api('/api/config', { token: admin });
    const adminBody = await ar.json();
    expect(adminBody.config.pads[0].buttons[2].action).toEqual({ type: 'shell', script: 'echo SECRET-COMMAND' });
    expect(adminBody.rev).toBe(pressBody.rev);

    expect((await api('/api/config', { method: 'PUT', body: { config: adminBody.config, baseRev: adminBody.rev } })).status).toBe(403);
    expect((await api('/api/runs')).status).toBe(403);
    expect((await api('/api/runs', { token: admin })).status).toBe(200);
  });
});

describe('WebSocket', () => {
  test('hello carries role, (redacted) config, rev, states, clock and host info', async () => {
    const { ws, press, admin, host } = await setup();
    const p = await ws(press);
    const a = await ws(admin);
    const ph = await p.next('hello');
    const ah = await a.next('hello');
    expect(ph).toMatchObject({ protocol: 1, role: 'press', rev: host.config.rev, host: { name: expect.any(String), version: expect.any(String), platform: process.platform } });
    expect(Math.abs(ph.serverNow - Date.now())).toBeLessThan(5000);
    expect(ph.states).toEqual({ 'main/quick': { phase: 'ready', runId: 0 }, 'main/long': { phase: 'ready', runId: 0 }, 'main/secret': { phase: 'ready', runId: 0 } });
    expect(JSON.stringify(ph.config)).not.toContain('SECRET-COMMAND');
    expect(ah.role).toBe('admin');
    expect(ah.config.pads[0]!.buttons[2]!.action).toBeDefined();
  });

  test('press → ack to the presser first, then state broadcasts to every client', async () => {
    const { ws, press, admin } = await setup();
    const p = await ws(press);
    const a = await ws(admin);
    await p.next('hello');
    await a.next('hello');
    p.send({ t: 'press', id: 'c1', pad: 'main', button: 'quick' });
    const ack = await p.next('ack');
    expect(ack).toEqual({ t: 'ack', id: 'c1', key: 'main/quick', result: 'started' });
    const running = await p.next('state', (m) => m.state.phase === 'running');
    expect(p.indexOf(ack)).toBeLessThan(p.indexOf(running));
    for (const c of [p, a]) {
      await c.next('state', (m) => m.key === 'main/quick' && m.state.phase === 'running');
      await c.next('state', (m) => m.key === 'main/quick' && m.state.phase === 'running' && m.state.status === 'working');
      const done = await c.next('state', (m) => m.key === 'main/quick' && m.state.phase === 'success');
      expect(done.state).toMatchObject({ runId: 1, exitCode: 0, text: 'quick done' });
      await c.next('state', (m) => m.key === 'main/quick' && m.state.phase === 'ready');
    }
    expect(a.msgs.some((m) => m.t === 'ack')).toBe(false);
  });

  test('cancel from a second client (after the double-press grace)', async () => {
    const { ws, press } = await setup();
    const p1 = await ws(press);
    const p2 = await ws(press);
    p1.send({ t: 'press', id: '1', pad: 'main', button: 'long' });
    await p1.next('ack');
    p2.send({ t: 'press', id: 'early', pad: 'main', button: 'long' });
    expect(await p2.next('ack')).toMatchObject({ id: 'early', result: 'ignored' });
    await p2.next('state', (m) => m.key === 'main/long' && m.state.phase === 'running' && !!m.state.status);
    await Bun.sleep(CANCEL_GRACE_MS);
    p2.send({ t: 'press', id: '2', pad: 'main', button: 'long' });
    expect(await p2.next('ack', (m) => m.id === '2')).toMatchObject({ id: '2', result: 'cancelling' });
    const failed = await p1.next('state', (m) => m.key === 'main/long' && m.state.phase === 'failure');
    expect(failed.state).toMatchObject({ reason: 'cancelled', runId: 1 });
  });

  test('malformed messages get an error and the socket stays usable', async () => {
    const { ws, press } = await setup();
    const p = await ws(press);
    await p.next('hello');
    const bad: unknown[] = ['not json', '[]', { t: 'nope' }, { t: 'press', id: 'x', pad: 'main' }, { t: 'press', id: 1, pad: 'main', button: 'quick' }];
    for (const [i, m] of bad.entries()) {
      p.send(m);
      await waitFor(() => p.msgs.filter((x) => x.t === 'error').length === i + 1, 2000, `error #${i + 1}`);
    }
    p.ws.send(new Uint8Array([1, 2, 3]));
    await waitFor(() => p.msgs.filter((x) => x.t === 'error').length === bad.length + 1, 2000, 'binary error');
    expect(p.msgs.filter((x) => x.t === 'error').map((x) => (x as { message: string }).message)).toEqual([
      'invalid JSON',
      'expected a JSON object',
      'unknown message type "nope"',
      'press: "button" must be a non-empty string',
      'press: "id" must be a non-empty string',
      'expected a JSON text frame',
    ]);
    p.send({ t: 'press', id: 'ok', pad: 'main', button: 'missing' });
    expect(await p.next('ack')).toEqual({ t: 'ack', id: 'ok', key: 'main/missing', result: 'unknown-button' });
    expect(p.closed).toBeUndefined();
  });
});

describe('HTTP press and state', () => {
  test('POST /api/press, GET /api/state, GET /api/runs', async () => {
    const { api, admin } = await setup();
    const r = await api('/api/press/main/quick', { method: 'POST' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ result: 'started', state: { phase: 'running', runId: 1 } });
    expect((await (await api('/api/press/main/quick', { method: 'POST' })).json()).result).toBe('ignored');

    const unknown = await api('/api/press/main/nope', { method: 'POST' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ result: 'unknown-button' });
    expect((await api('/api/press/nopad/quick', { method: 'POST' })).status).toBe(404);

    const st = await (await api('/api/state')).json();
    expect(st.states['main/quick'].phase).toBe('running');
    expect(Math.abs(st.serverNow - Date.now())).toBeLessThan(5000);

    const runs = await eventually(async () => {
      const list = (await (await api('/api/runs?pad=main&button=quick', { token: admin })).json()) as RunRecord[];
      return list[0]?.endedAt !== undefined && list;
    }, 3000, 'finished run record');
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ runId: 1, pad: 'main', button: 'quick', exitCode: 0, reason: 'exit' });
    expect(runs[0]!.stdout).toContain('@result quick done');
    expect(await (await api('/api/runs?button=long', { token: admin })).json()).toEqual([]);
  });

  test('routing: unknown paths 404, wrong methods 405', async () => {
    const { api } = await setup();
    const nf = await api('/api/nope');
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: 'not found' });
    expect((await api('/nope.js', { token: null })).status).toBe(404);
    const m = await api('/api/config', { method: 'DELETE' });
    expect(m.status).toBe(405);
    expect(m.headers.get('allow')).toBe('GET, PUT');
    expect((await api('/api/press/main/quick')).status).toBe(405);
  });

  test('serves the web app (Bun HTML import of src/web/index.html) at /', async () => {
    const { base } = await setup();
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('<script');
    const src = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    expect(src).toBeDefined();
    const js = await fetch(new URL(src!, base));
    expect(js.status).toBe(200);
    // Production bundle: no source maps (they carry absolute paths, i.e. the OS user name).
    expect(await js.text()).not.toContain('sourceMappingURL');
    expect((await fetch(new URL(`${src}.map`, base))).status).toBe(404);
  });

  test('JSON bodies are capped at 1 MB', async () => {
    const { api, admin, host } = await setup();
    const r = await api('/api/config', { method: 'PUT', token: admin, raw: JSON.stringify({ baseRev: host.config.rev, config: { pad: 'x'.repeat(1024 * 1024) } }) });
    expect(r.status).toBe(413);
  });
});

describe('config over HTTP and hand edits', () => {
  test('PUT /api/config: 400 on invalid bodies and configs, 409 on stale rev, 200 + broadcast on success', async () => {
    const { api, admin, ws, press, configPath, host } = await setup();
    const p = await ws(press);
    const a = await ws(admin);
    await p.next('hello');
    await a.next('hello');
    const { config, rev } = await (await api('/api/config', { token: admin })).json();

    const put = (body: unknown) => api('/api/config', { method: 'PUT', token: admin, body });
    const invalidJson = await api('/api/config', { method: 'PUT', token: admin, raw: '{nope' });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ errors: ['invalid JSON body'] });
    expect((await put({ config })).status).toBe(400);
    expect((await put([config, rev])).status).toBe(400);

    const overlapping = structuredClone(config);
    overlapping.pads[0].buttons[1].x = 0;
    const r400 = await put({ config: overlapping, baseRev: rev });
    expect(r400.status).toBe(400);
    const { errors } = await r400.json();
    expect(errors).toEqual(['pads.0.buttons.1: button "long" overlaps "quick" at cell 0,0']);

    const r409 = await put({ config, baseRev: 'deadbeefdeadbeef' });
    expect(r409.status).toBe(409);
    expect(await r409.json()).toEqual({ rev });

    const next = structuredClone(config);
    next.pads[0].buttons[0].label = 'Quick!';
    next.pads[0].buttons.push({ id: 'new', x: 0, y: 1, action: { type: 'exec', command: 'true', args: [] } });
    const ok = await put({ config: next, baseRev: rev });
    expect(ok.status).toBe(200);
    const { rev: newRev } = await ok.json();
    expect(newRev).not.toBe(rev);
    expect(newRev).toBe(revOf(readFileSync(configPath)));
    expect(host.config.rev).toBe(newRev);

    const pc = await p.next('config', (m) => m.rev === newRev);
    const ac = await a.next('config', (m) => m.rev === newRev);
    expect(JSON.stringify(pc.config)).not.toContain('"action"');
    expect(pc.config.pads[0]!.buttons[0]!.label).toBe('Quick!');
    expect(ac.config.pads[0]!.buttons[3]!.action).toEqual({ type: 'exec', command: 'true', args: [] });
    const added = await p.next('state', (m) => m.key === 'main/new');
    expect(added.state).toEqual({ phase: 'ready', runId: 0 });
    expect(p.indexOf(pc)).toBeLessThan(p.indexOf(added));

    // Written compactly: defaults and empty args omitted.
    const onDisk = readJson<{ pads: { buttons: Record<string, unknown>[] }[] }>(configPath);
    expect(onDisk.pads[0]!.buttons[3]).toEqual({ id: 'new', x: 0, y: 1, action: { type: 'exec', command: 'true' } });
    expect(onDisk.pads[0]!.buttons[0]).not.toHaveProperty('holdMs');

    // The old rev is now stale.
    expect((await put({ config: next, baseRev: rev })).status).toBe(409);
    const fresh = await (await api('/api/config')).json();
    expect(fresh.rev).toBe(newRev);
  });

  test('hand edits are reloaded and broadcast', async () => {
    const { ws, press, admin, configPath } = await setup();
    const p = await ws(press);
    const a = await ws(admin);
    await p.next('hello');
    const cfg = baseConfig();
    cfg.pads[0]!.name = 'Edited by hand';
    writeJson(configPath, cfg);
    const rev = revOf(readFileSync(configPath));
    const pc = await p.next('config', (m) => m.rev === rev, 3000);
    expect(pc.config.pads[0]!.name).toBe('Edited by hand');
    expect(JSON.stringify(pc.config)).not.toContain('SECRET-COMMAND');
    await a.next('config', (m) => m.rev === rev, 3000);
  });

  test('an invalid hand edit keeps the old config and tells admins only', async () => {
    const { ws, press, admin, configPath, api, host } = await setup();
    const p = await ws(press);
    const a = await ws(admin);
    await p.next('hello');
    await a.next('hello');
    const oldRev = host.config.rev;
    const cfg = baseConfig();
    cfg.pads[0]!.buttons![1]!.x = 0; // overlap
    writeJson(configPath, cfg);
    const err = await a.next('configError', () => true, 3000);
    expect(err.errors).toEqual(['pads.0.buttons.1: button "long" overlaps "quick" at cell 0,0']);
    writeFileSync(configPath, '{ "version": 1, ');
    const err2 = await a.next('configError', (m) => m.errors[0]!.includes('invalid JSON'), 3000);
    expect(err2.errors.length).toBe(1);
    await Bun.sleep(150);
    expect(p.msgs.some((m) => m.t === 'configError' || m.t === 'config')).toBe(false);
    expect((await (await api('/api/config')).json()).rev).toBe(oldRev);
    // Presses still use the old config.
    expect((await (await api('/api/press/main/quick', { method: 'POST' })).json()).result).toBe('started');

    // Admins connecting meanwhile learn about the broken file right after hello.
    const late = await ws(admin);
    await late.next('hello');
    expect((await late.next('configError')).errors[0]).toContain('invalid JSON');

    // Fixing the file clears it with a config broadcast, even though the content equals the old one.
    writeJson(configPath, baseConfig());
    const fixed = await a.next('config', () => true, 3000);
    expect(fixed.rev).toBe(oldRev);
    await p.next('config', () => true, 3000);
  });

  test('removing a running button kills its action', async () => {
    const { api, admin, host } = await setup();
    await api('/api/press/main/long', { method: 'POST' });
    const status = await waitFor(() => {
      const s = host.state.get('main/long');
      return s?.phase === 'running' && s.status;
    }, 3000, 'child pid status');
    const child = Number(/child (\d+)/.exec(status)![1]);
    const leader = (await (await api('/api/runs?button=long', { token: admin })).json()) as RunRecord[];
    expect(leader[0]).not.toHaveProperty('endedAt');
    expect(isAlive(child)).toBe(true);

    const { config, rev } = await (await api('/api/config', { token: admin })).json();
    config.pads[0].buttons = config.pads[0].buttons.filter((b: { id: string }) => b.id !== 'long');
    expect((await api('/api/config', { method: 'PUT', token: admin, body: { config, baseRev: rev } })).status).toBe(200);
    await waitFor(() => !isAlive(child), 3000, 'removed button action to die');
    const st = await (await api('/api/state')).json();
    expect(Object.keys(st.states).sort()).toEqual(['main/quick', 'main/secret']);
    const runs = await eventually(async () => {
      const list = (await (await api('/api/runs?button=long', { token: admin })).json()) as RunRecord[];
      return list[0]?.endedAt !== undefined && list;
    }, 3000, 'finished run record');
    expect(runs[0]).toMatchObject({ reason: 'cancelled', button: 'long' });
  });

  test('changing a running button does not touch the current run', async () => {
    const { api, admin, host } = await setup();
    await api('/api/press/main/long', { method: 'POST' });
    await waitFor(() => host.state.get('main/long')?.phase === 'running', 2000, 'running');
    const { config, rev } = await (await api('/api/config', { token: admin })).json();
    config.pads[0].buttons[1].action = { type: 'shell', script: 'echo replaced' };
    config.pads[0].buttons[1].label = 'Renamed';
    expect((await api('/api/config', { method: 'PUT', token: admin, body: { config, baseRev: rev } })).status).toBe(200);
    await Bun.sleep(CANCEL_GRACE_MS);
    expect(host.state.get('main/long')).toMatchObject({ phase: 'running', runId: 1 });
    // Cancel it (whileRunning: cancel still applies) and check the next run uses the new action.
    await api('/api/press/main/long', { method: 'POST' });
    await waitFor(() => host.state.get('main/long')?.phase === 'failure', 3000, 'cancelled');
    await waitFor(() => host.state.get('main/long')?.phase === 'ready', 4000, 'reset');
    await api('/api/press/main/long', { method: 'POST' });
    await waitFor(() => host.state.get('main/long')?.phase === 'success', 3000, 'new action');
    expect(host.state.get('main/long')).toMatchObject({ text: 'replaced', runId: 2 });
  });
});
