/**
 * One-time pairing codes (QA round 2, hobbyist: no phone-only way to become an admin; typing the
 * 43-character token failed) and the origins a reverse proxy serves the app from (--allow-origin).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { ConfigInput } from '../src/core/config.ts';
import { originAllowed, parseOrigin, startHost, type Host, type HostOptions } from '../src/server/host.ts';
import { formatCode, MAX_PAIR_CODES, PAIR_CODE_TTL_MS, Pairing } from '../src/server/pairing.ts';
import { cleanupTmp, eventually, padConfig, TestClient, tmpDir, writeJson } from './helpers.ts';

afterAll(cleanupTmp);

const MAIN = join(import.meta.dir, '..', 'src', 'server', 'main.ts');
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
});

function fakePairing(o: ConstructorParameters<typeof Pairing>[0] = {}) {
  const clock = { now: 1_800_000_000_000, mono: 0 };
  const logs: string[] = [];
  const p = new Pairing({ now: () => clock.now, clock: () => clock.mono, log: (m) => logs.push(m), ...o });
  return { p, clock, logs };
}

describe('codes', () => {
  test('6 random digits, valid 10 minutes, used once; "123 456" and "123-456" are typed forms of it', () => {
    const { p, clock, logs } = fakePairing();
    const c = p.mint();
    expect(c).toEqual({ code: expect.stringMatching(/^\d{6}$/), role: 'admin', expiresAt: clock.now + PAIR_CODE_TTL_MS });
    expect(formatCode('012345')).toBe('012 345');
    const typed = `${c.code.slice(0, 3)} ${c.code.slice(3)}`;
    expect(p.redeem(typed, '10.0.0.5')).toEqual({ ok: true, role: 'admin' });
    expect(logs.at(-1)).toBe('paired a device as admin with a pairing code (from 10.0.0.5)');
    // Used: gone.
    expect(p.redeem(c.code, '10.0.0.5')).toEqual({ ok: false, why: 'wrong' });
    const d = p.mint('press');
    expect(p.redeem(`${d.code.slice(0, 3)}-${d.code.slice(3)}`, '10.0.0.6')).toEqual({ ok: true, role: 'press' });
    // Expired: gone, and it says nothing different from a wrong one.
    const e = p.mint();
    clock.mono += PAIR_CODE_TTL_MS;
    expect(p.size).toBe(0);
    expect(p.redeem(e.code, '10.0.0.7')).toEqual({ ok: false, why: 'wrong' });
    const f = p.mint();
    clock.mono += PAIR_CODE_TTL_MS - 1;
    expect(p.redeem(f.code, '10.0.0.8')).toEqual({ ok: true, role: 'admin' });
  });

  test(`at most ${MAX_PAIR_CODES} valid at once: making another drops the oldest`, () => {
    const { p } = fakePairing();
    const codes = Array.from({ length: MAX_PAIR_CODES + 1 }, () => p.mint());
    expect(new Set(codes.map((c) => c.code)).size).toBe(codes.length);
    expect(p.size).toBe(MAX_PAIR_CODES);
    expect(p.redeem(codes[0]!.code, 'a')).toEqual({ ok: false, why: 'wrong' });
    for (const c of codes.slice(1)) expect(p.redeem(c.code, 'a').ok).toBe(true);
  });

  test('attempts are limited per device (5 a minute) and over all devices (burst 10, then 20 a minute); wrong ones are logged', () => {
    const { p, clock, logs } = fakePairing();
    const c = p.mint();
    const wrong = c.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(p.redeem(wrong, '10.0.0.9')).toEqual({ ok: false, why: 'wrong' });
    // The 6th from that device is refused before anything is compared — even the right code.
    expect(p.redeem(c.code, '10.0.0.9')).toEqual({ ok: false, why: 'limited', retryAfterSec: 12 });
    expect(logs).toEqual(['wrong pairing code from 10.0.0.9', expect.stringMatching(/^refusing pairing attempts from 10\.0\.0\.9: too many \(at most 5 a minute per device, 20 a minute from all\)$/)]);
    // Others still get through, until all of them together used up the burst.
    for (let i = 0; i < 5; i++) expect(p.redeem(wrong, `10.0.1.${i}`)).toEqual({ ok: false, why: 'wrong' });
    expect(p.redeem(c.code, '10.0.2.1')).toEqual({ ok: false, why: 'limited', retryAfterSec: 3 });
    // A token comes back every 3 s over all, every 12 s per device.
    clock.mono += 3000;
    expect(p.redeem(c.code, '10.0.2.1')).toEqual({ ok: true, role: 'admin' });
  });

  test('the bound DESIGN.md gives: at most 210 guesses over all devices while a code is valid', () => {
    const { p, clock } = fakePairing();
    p.mint();
    let tries = 0;
    for (let t = 0; t < PAIR_CODE_TTL_MS; t += 1000) {
      clock.mono = t;
      // Many devices (addresses), as many tries as they're let.
      for (let a = 0; a < 50; a++) {
        const r = p.redeem('not-it', `10.1.${t}.${a}`);
        if (r.ok || r.why !== 'limited') tries++;
      }
    }
    expect(tries).toBeLessThanOrEqual(10 + 20 * 10);
    expect(tries).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------------------------

async function setup(opts: Partial<HostOptions> = {}, cfg: ConfigInput = padConfig([{ id: 'a', x: 0, y: 0, action: { type: 'none' } }])) {
  const dir = tmpDir('buttpad-pair-');
  const configPath = join(dir, 'buttpad.config.json');
  writeJson(configPath, cfg);
  const logs: string[] = [];
  const host = await startHost({ configPath, host: '127.0.0.1', port: 0, log: (m) => logs.push(m), ...opts });
  hosts.push(host);
  const base = `http://127.0.0.1:${host.port}`;
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const admin = { authorization: `Bearer ${host.secrets.adminToken}` };
  return { host, base, post, admin, logs };
}

describe('POST /api/pair-code (admin) and POST /api/pair (no token)', () => {
  test('the shapes the web app uses', async () => {
    const { host, post, admin, logs } = await setup();
    // Make one: {} (or no body) for admin; {"role": "press"} for a press device.
    const r = await post('/api/pair-code', {}, admin);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const made = (await r.json()) as { code: string; expiresAt: number; role: string };
    expect(made).toEqual({ code: expect.stringMatching(/^\d{6}$/), expiresAt: expect.any(Number), role: 'admin' });
    expect(made.expiresAt - Date.now()).toBeGreaterThan(PAIR_CODE_TTL_MS - 5000);
    expect(logs.at(-1)).toMatch(/^a pairing code for admin was made \(by 127\.0\.0\.1\), valid until \d\d:\d\d:\d\d$/);
    expect(JSON.stringify(logs)).not.toContain(made.code);
    const pressCode = (await (await post('/api/pair-code', { role: 'press' }, admin)).json()) as { code: string; role: string };
    expect(pressCode.role).toBe('press');
    expect((await post('/api/pair-code', undefined, admin)).status).toBe(200);

    // Trade it: {code} → {token, role}; typed with a space works too.
    const a = await post('/api/pair', { code: `${made.code.slice(0, 3)} ${made.code.slice(3)}` });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ token: host.secrets.adminToken, role: 'admin' });
    expect(await (await post('/api/pair', { code: pressCode.code })).json()).toEqual({ token: host.secrets.pressToken, role: 'press' });
    // Used, wrong, expired: one generic 401.
    const again = await post('/api/pair', { code: made.code });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'wrong or expired code' });
    expect((await post('/api/pair', { code: 123 })).status).toBe(401);
    // Not a code at all: 400.
    for (const bad of ['{"code": null}', '[1]', 'nope', '{}']) expect((await post('/api/pair', bad)).status).toBe(400);
  });

  test('making codes takes the admin token', async () => {
    const { host, post } = await setup();
    expect((await post('/api/pair-code', {})).status).toBe(401);
    expect((await post('/api/pair-code', {}, { authorization: `Bearer ${host.secrets.pressToken}` })).status).toBe(403);
    expect((await post('/api/pair-code', { role: 'root' }, { authorization: `Bearer ${host.secrets.adminToken}` })).status).toBe(400);
    const m = await fetch(`http://127.0.0.1:${host.port}/api/pair`);
    expect(m.status).toBe(405);
    expect(m.headers.get('allow')).toBe('POST');
    // No token needed there, so no big bodies either.
    const big = await post('/api/pair', { code: '1'.repeat(5000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'body too large (max 4 KB)' });
  });

  test('too many attempts: 429 with Retry-After (per device, and from everyone)', async () => {
    const { post, admin } = await setup({ limits: { pairing: { addressBurst: 2, addressPerMin: 6 } } });
    const made = (await (await post('/api/pair-code', {}, admin)).json()) as { code: string };
    const wrong = made.code === '000000' ? '111111' : '000000';
    expect((await post('/api/pair', { code: wrong })).status).toBe(401);
    expect((await post('/api/pair', { code: wrong })).status).toBe(401);
    const r = await post('/api/pair', { code: made.code });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('10');
    // The words say what Retry-After says (not "wait a minute" next to Retry-After: 7).
    expect(await r.json()).toEqual({ error: 'too many attempts: try again in 10 s' });
    await Bun.sleep(1100);
    const later = await post('/api/pair', { code: made.code });
    expect(later.status).toBe(429);
    const wait = Number(later.headers.get('retry-after'));
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThan(10);
    expect(await later.json()).toEqual({ error: `too many attempts: try again in ${wait} s` });
  });

  test("a page of another origin can't pair (a hidden form on some web page burning the code)", async () => {
    const { base, post, admin, logs } = await setup();
    const made = (await (await post('/api/pair-code', {}, admin)).json()) as { code: string };
    const r = await post('/api/pair', { code: made.code }, { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(logs.at(-1)).toStartWith('refused a pairing request from a page at http://evil.example (the request');
    // Its own pages can.
    expect((await post('/api/pair', { code: made.code }, { origin: base })).status).toBe(200);
  });
});

/** A real WebSocket upgrade request; the response status line. */
function rawUpgrade(port: number, headers: Record<string, string>): Promise<string> {
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () =>
      s.write(`GET /ws?token=${headers['x-token']} HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`),
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

describe('behind a reverse proxy: --allow-origin', () => {
  test('parseOrigin and originAllowed', () => {
    expect(parseOrigin('https://x.example')).toBe('https://x.example');
    expect(parseOrigin('https://X.example:443/')).toBe('https://x.example');
    expect(parseOrigin('http://192.168.1.20:8080')).toBe('http://192.168.1.20:8080');
    for (const bad of ['*', 'https://*.x.example', 'https://x.example/app', 'x.example', 'ws://x.example', 'null', 'https://x.example#a']) expect(parseOrigin(bad)).toBeUndefined();
    const req = (origin: string | null, host: string) => new Request('http://h/ws', { headers: { ...(origin === null ? {} : { origin }), host } });
    const allowed = new Set(['https://preview.example']);
    expect(originAllowed(req(null, '127.0.0.1:8787'))).toBe(true);
    expect(originAllowed(req('http://127.0.0.1:8787', '127.0.0.1:8787'))).toBe(true);
    expect(originAllowed(req('https://preview.example', '127.0.0.1:8787'))).toBe(false);
    expect(originAllowed(req('https://preview.example', '127.0.0.1:8787'), allowed)).toBe(true);
    expect(originAllowed(req('https://preview.example:443', '127.0.0.1:8787'), allowed)).toBe(true);
    expect(originAllowed(req('http://preview.example', '127.0.0.1:8787'), allowed)).toBe(false);
    expect(originAllowed(req('https://evil.preview.example', '127.0.0.1:8787'), allowed)).toBe(false);
    // A proxy that passes the Host on (its own name): same-origin, no flag needed.
    expect(originAllowed(req('https://preview.example', 'preview.example'))).toBe(true);
  });

  test('a WebSocket from an allowed origin is let in; a refused one says, once per 10 s, which flag would allow it', async () => {
    const { host, logs } = await setup({ allowOrigins: ['https://preview.example.com/'] });
    expect(host.allowOrigins).toEqual(['https://preview.example.com']);
    const token = host.secrets.pressToken;
    // The proxy's upstream Host is this machine's address, the page's Origin is the proxy's.
    expect(await rawUpgrade(host.port, { 'x-token': token, host: `127.0.0.1:${host.port}`, origin: 'https://preview.example.com' })).toStartWith('HTTP/1.1 101');
    expect(await rawUpgrade(host.port, { 'x-token': token, host: `127.0.0.1:${host.port}`, origin: 'https://other.example.com' })).toStartWith('HTTP/1.1 403');
    expect(await rawUpgrade(host.port, { 'x-token': token, host: `127.0.0.1:${host.port}`, origin: 'https://other.example.com' })).toStartWith('HTTP/1.1 403');
    const refused = logs.filter((l) => l.startsWith('refused a WebSocket'));
    expect(refused).toEqual([
      `refused a WebSocket from a page at https://other.example.com (the request's Host is 127.0.0.1:${host.port}): not this host's own address. If that is ButtPad through your reverse proxy (or a preview pane), start ButtPad with --allow-origin https://other.example.com`,
    ]);
    expect(await rawUpgrade(host.port, { 'x-token': token, host: `127.0.0.1:${host.port}`, origin: 'null' })).toStartWith('HTTP/1.1 403');
  });

  test('an origin that is not exact is refused at startup', async () => {
    const dir = tmpDir('buttpad-pair-');
    writeJson(join(dir, 'c.json'), padConfig([{ id: 'a', x: 0, y: 0, action: { type: 'none' } }]));
    await expect(startHost({ configPath: join(dir, 'c.json'), host: '127.0.0.1', port: 0, log: () => {}, allowOrigins: ['https://*.example.com'] })).rejects.toThrow(
      /not an origin: "https:\/\/\*\.example\.com"/,
    );
  });
});

describe('the startup code (CLI)', () => {
  async function run(args: string[]) {
    const dir = tmpDir('buttpad-pair-');
    const configPath = join(dir, 'buttpad.config.json');
    writeJson(configPath, padConfig([{ id: 'rand', x: 0, y: 0, action: { type: 'shell', script: '[ $((RANDOM % 3)) -ne 0 ] || exit 1' } }]));
    const proc = Bun.spawn([process.execPath, MAIN, '--config', configPath, '--host', '127.0.0.1', '--port', '0', '--ready-json', '--no-qr', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    procs.push(proc);
    const io = { out: '', err: '' };
    void (async () => {
      for await (const c of proc.stdout) io.out += new TextDecoder().decode(c);
    })();
    void (async () => {
      for await (const c of proc.stderr) io.err += new TextDecoder().decode(c);
    })();
    const ready = await eventually(async () => io.out.includes('\n') && (JSON.parse(io.out.split('\n')[0]!) as { port: number; adminToken: string }), 15_000, 'ready line');
    // The banner (stderr) ends with the plain-HTTP warning; the two pipes are read separately.
    await eventually(async () => io.err.includes('Plain HTTP'), 5000, 'the banner');
    return { ready, err: io.err };
  }

  test('printed next to the admin URL, and it works once; startup warnings come along (bash syntax under /bin/sh)', async () => {
    const { ready, err } = await run([]);
    const line = err.split('\n').find((l) => l.startsWith('Pair a phone as admin:'))!;
    expect(line).toMatch(/^Pair a phone as admin: open http:\/\/localhost:\d+\/#pair and enter \d{3} \d{3} \(valid 10 min\)$/);
    const adminAt = err.indexOf('Admin URL');
    expect(adminAt).toBeGreaterThan(-1);
    expect(err.indexOf(line)).toBeGreaterThan(adminAt);
    const code = /enter (\d{3} \d{3})/.exec(line)![1]!;
    const pair = () => fetch(`http://127.0.0.1:${ready.port}/api/pair`, { method: 'POST', body: JSON.stringify({ code }) });
    const r = await pair();
    expect(await r.json()).toEqual({ token: ready.adminToken, role: 'admin' });
    expect((await pair()).status).toBe(401);
    if (process.platform !== 'win32') expect(err).toContain('⚠  pad "p" › button "rand": the script uses bash syntax ($RANDOM), but runs with /bin/sh');
  }, 20_000);

  test('--no-pair-code: none; --allow-origin: the proxy origin gets its URLs too', async () => {
    const { err } = await run(['--no-pair-code']);
    expect(err).not.toContain('Pair a phone');
    const proxied = await run(['--allow-origin', 'https://preview.example.com']);
    expect(proxied.err).toMatch(/Pair a phone as admin: open http:\/\/localhost:\d+\/#pair \(or https:\/\/preview\.example\.com\/#pair\) and enter \d{3} \d{3} \(valid 10 min\)/);
    expect(proxied.err).toContain('  https://preview.example.com/#token=');
  }, 30_000);
});

/**
 * A reverse proxy at the root path, as a tunnel or an app's preview pane puts one in front: it
 * forwards with its upstream's Host (this machine's address), while the page's Origin is the
 * proxy's own. HTTP passes through as is (compressed bodies too); WebSockets are bridged.
 */
/** Bun's WebSocket client takes headers (a browser sends Origin on its own); the DOM typing doesn't know that. */
const HeaderedWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;

function reverseProxy() {
  const target = { port: 0 };
  /** Every request line it forwarded, as a proxy's access log has them (QA found the admin token in one). */
  const logged: string[] = [];
  type Data = { path: string; origin: string | null; up?: WebSocket; queue: (string | Buffer)[] };
  const proxy = Bun.serve<Data>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      const upstream = `127.0.0.1:${target.port}`;
      logged.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket')
        return srv.upgrade(req, { data: { path: url.pathname + url.search, origin: req.headers.get('origin'), queue: [] } }) ? undefined : new Response('no upgrade', { status: 400 });
      const headers = new Headers(req.headers);
      headers.set('host', upstream);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
      return fetch(`http://${upstream}${url.pathname}${url.search}`, { method: req.method, headers, body, decompress: false });
    },
    websocket: {
      open(ws) {
        const up = new HeaderedWebSocket(`ws://127.0.0.1:${target.port}${ws.data.path}`, { headers: ws.data.origin ? { origin: ws.data.origin } : {} });
        ws.data.up = up;
        up.onopen = () => {
          for (const m of ws.data.queue.splice(0)) up.send(typeof m === 'string' ? m : new Uint8Array(m));
        };
        up.onmessage = (e) => ws.send(e.data as string);
        up.onclose = () => ws.close();
        up.onerror = () => ws.close();
      },
      message(ws, m) {
        if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(typeof m === 'string' ? m : new Uint8Array(m));
        else ws.data.queue.push(m);
      },
      close(ws) {
        ws.data.up?.close();
      },
    },
  });
  return { proxy, target, logged, origin: `http://127.0.0.1:${proxy.port}` };
}

/** A browser-like socket (it sends its page's Origin): the first message, or how it closed. */
function wsFrom(url: string, origin: string) {
  return new Promise<{ hello?: { t: string; role: string }; closed?: number }>((resolve) => {
    const ws = new HeaderedWebSocket(url, { headers: { origin } });
    ws.onmessage = (e) => {
      resolve({ hello: JSON.parse(String(e.data)) });
      ws.close();
    };
    ws.onclose = (e) => resolve({ closed: e.code });
    ws.onerror = () => {};
  });
}

describe('through a reverse proxy at the root path', () => {
  test('page, compressed chunks, /api, pairing and /ws all work once its origin is allowed; refused, the log names the flag', async () => {
    const { proxy, target, origin } = reverseProxy();
    try {
      const { host, logs } = await setup({ allowOrigins: [origin] });
      target.port = host.port;
      const page = await fetch(`${origin}/`, { headers: { 'accept-encoding': 'gzip', origin } });
      expect(page.status).toBe(200);
      const html = await page.text();
      const js = /src="(\/[^"]+\.js)"/.exec(html)![1]!;
      const chunk = await fetch(`${origin}${js}`, { headers: { 'accept-encoding': 'gzip' } });
      expect(chunk.status).toBe(200);
      expect(chunk.headers.get('vary')).toBe('Accept-Encoding');
      expect((await chunk.text()).length).toBeGreaterThan(10_000);
      expect((await fetch(`${origin}/api/state`, { headers: { authorization: `Bearer ${host.secrets.pressToken}` } })).status).toBe(200);
      const made = (await (await fetch(`${origin}/api/pair-code`, { method: 'POST', headers: { authorization: `Bearer ${host.secrets.adminToken}` } })).json()) as { code: string };
      const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: made.code }) });
      expect(await paired.json()).toEqual({ token: host.secrets.adminToken, role: 'admin' });
      const ok = await wsFrom(`ws://127.0.0.1:${proxy.port}/ws?token=${host.secrets.pressToken}`, origin);
      expect(ok.hello).toMatchObject({ t: 'hello', role: 'press' });
      expect(logs.filter((l) => l.startsWith('refused'))).toEqual([]);

      // The same proxy in front of a host that wasn't told about it.
      const plain = await setup();
      target.port = plain.host.port;
      const refused = await wsFrom(`ws://127.0.0.1:${proxy.port}/ws?token=${plain.host.secrets.pressToken}`, origin);
      expect(refused.hello).toBeUndefined();
      expect(plain.logs.filter((l) => l.startsWith('refused'))).toEqual([
        `refused a WebSocket from a page at ${origin} (the request's Host is 127.0.0.1:${plain.host.port}): not this host's own address. If that is ButtPad through your reverse proxy (or a preview pane), start ButtPad with --allow-origin ${origin}`,
      ]);
    } finally {
      proxy.stop(true);
    }
  });

  test("a browser's way onto /ws leaves no token in the proxy's log: a ticket (POST, Bearer), /ws?ticket=, the probe (POST)", async () => {
    const { proxy, target, origin, logged } = reverseProxy();
    try {
      const { host, logs } = await setup({ allowOrigins: [origin] });
      target.port = host.port;
      const auth = { authorization: `Bearer ${host.secrets.adminToken}`, origin };
      expect((await fetch(`${origin}/api/ws-check`, { method: 'POST', headers: auth })).status).toBe(204);
      const t = (await (await fetch(`${origin}/api/ws-ticket`, { method: 'POST', headers: auth })).json()) as { ticket: string };
      const ok = await wsFrom(`ws://127.0.0.1:${proxy.port}/ws?ticket=${t.ticket}`, origin);
      expect(ok.hello).toMatchObject({ t: 'hello', role: 'admin' });
      expect(logged).toEqual(['POST /api/ws-check', 'POST /api/ws-ticket', `GET /ws?ticket=${t.ticket}`]);
      // Replayed from that log: worthless.
      expect((await wsFrom(`ws://127.0.0.1:${proxy.port}/ws?ticket=${t.ticket}`, origin)).hello).toBeUndefined();
      expect(logs.filter((l) => l.startsWith('refused'))).toEqual([]);

      // The same proxy in front of a host that wasn't told about it: the ticket (and the probe) say so, and which flag would allow it.
      const plain = await setup();
      target.port = plain.host.port;
      const h = { authorization: `Bearer ${plain.host.secrets.pressToken}`, origin };
      for (const path of ['/api/ws-ticket', '/api/ws-check']) {
        const r = await fetch(`${origin}${path}`, { method: 'POST', headers: h });
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'cross-origin WebSocket refused', origin, allowOrigin: origin });
      }
      expect(plain.logs.filter((l) => l.startsWith('refused'))).toEqual([
        `refused a WebSocket ticket request from a page at ${origin} (the request's Host is 127.0.0.1:${plain.host.port}): not this host's own address. If that is ButtPad through your reverse proxy (or a preview pane), start ButtPad with --allow-origin ${origin}`,
      ]);
      for (const token of [host.secrets.adminToken, host.secrets.pressToken, plain.host.secrets.adminToken, plain.host.secrets.pressToken])
        expect(logged.join('\n')).not.toContain(token);
    } finally {
      proxy.stop(true);
    }
  });
});
