import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConfigInput } from '../src/core/config.ts';
import { pairingHosts, pairingUrl, parseCli, signalIgnored, UsageError } from '../src/server/cli.ts';
import { CANCEL_GRACE_MS } from '../src/server/state-store.ts';
import { cleanupTmp, eventually, isAlive, readJson, TestClient, tmpDir, writeJson } from './helpers.ts';

const MAIN = resolve(import.meta.dir, '..', 'src', 'server', 'main.ts');

describe('parseCli', () => {
  test('defaults and env', () => {
    expect(parseCli([], {})).toEqual({
      config: './buttpad.config.json',
      secrets: undefined,
      host: undefined,
      port: undefined,
      rotateTokens: false,
      qr: true,
      readyJson: false,
      tls: undefined,
      dev: false,
      help: false,
      version: false,
    });
    expect(parseCli([], { BUTTPAD_CONFIG: '/etc/bp.json' }).config).toBe('/etc/bp.json');
    expect(parseCli(['--config', 'a.json'], { BUTTPAD_CONFIG: '/etc/bp.json' }).config).toBe('a.json');
  });

  test('all flags', () => {
    const o = parseCli(['--config', 'c.json', '--secrets', 's.json', '--host', '127.0.0.1', '--port', '0', '--rotate-tokens', '--no-qr', '--ready-json', '--tls-cert', 'c.pem', '--tls-key', 'k.pem', '--dev'], {});
    expect(o).toMatchObject({ config: 'c.json', secrets: 's.json', host: '127.0.0.1', port: 0, rotateTokens: true, qr: false, readyJson: true, tls: { cert: 'c.pem', key: 'k.pem' }, dev: true });
    expect(parseCli(['--port=18001'], {}).port).toBe(18001);
    expect(parseCli(['-h'], {}).help).toBe(true);
  });

  test('rejects bad input', () => {
    for (const argv of [['--port', 'abc'], ['--port', '70000'], ['--port', '-1'], ['--tls-cert', 'c.pem'], ['--bogus'], ['extra'], ['--host', '']])
      expect(() => parseCli(argv, {})).toThrow(UsageError);
  });
});

test('signalIgnored reads the SigIgn mask of /proc/self/status', () => {
  const status = (mask: string) => `Name:\tbun\nSigBlk:\t0000000000000000\nSigIgn:\t${mask}\nSigCgt:\t00000001200004f8\n`;
  expect(signalIgnored(1, status('0000000001001001'))).toBe(true); // SIGHUP under nohup
  expect(signalIgnored(1, status('0000000001001000'))).toBe(false);
  expect(signalIgnored(13, status('0000000000001000'))).toBe(true); // SIGPIPE
  expect(signalIgnored(1, 'Name:\tbun\n')).toBeUndefined();
  if (process.platform === 'linux') expect(typeof signalIgnored(1)).toBe('boolean');
});

describe('pairing URLs', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null }],
    eth0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
      { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 1 },
    ],
    wlan0: [{ address: '10.0.0.5', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
  } as unknown as Parameters<typeof pairingHosts>[1];

  test('every non-internal IPv4 plus localhost when bound to all interfaces', () => {
    expect(pairingHosts('0.0.0.0', ifaces)).toEqual(['192.168.1.20', '10.0.0.5', 'localhost']);
    expect(pairingHosts('::', ifaces)).toEqual(['192.168.1.20', '10.0.0.5', 'localhost']);
    expect(pairingHosts('127.0.0.1', ifaces)).toEqual(['localhost']);
    expect(pairingHosts('192.168.1.20', ifaces)).toEqual(['192.168.1.20']);
  });

  test('url format', () => {
    expect(pairingUrl('http', '192.168.1.20', 8787, 'abc')).toBe('http://192.168.1.20:8787/#token=abc');
    expect(pairingUrl('https', 'fd00::1', 443, 'abc')).toBe('https://[fd00::1]:443/#token=abc');
  });
});

interface Proc {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  stdout: () => string;
  stderr: () => string;
}
const procs: Proc[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.proc.kill('SIGKILL');
    await p.proc.exited;
  }
  cleanupTmp();
});

/** `wrap`: argv prefix to start the host through (it must exec it). */
function spawnCli(args: string[], env: Record<string, string> = {}, wrap: string[] = []): Proc {
  const proc = Bun.spawn([...wrap, process.execPath, MAIN, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production', ...env } });
  let out = '';
  let err = '';
  const pump = async (s: ReadableStream<Uint8Array>, add: (t: string) => void) => {
    const dec = new TextDecoder();
    for await (const chunk of s) add(dec.decode(chunk, { stream: true }));
  };
  void pump(proc.stdout, (t) => (out += t));
  void pump(proc.stderr, (t) => (err += t));
  const p = { proc, stdout: () => out, stderr: () => err };
  procs.push(p);
  return p;
}

interface Ready {
  event: string;
  port: number;
  pressToken: string;
  adminToken: string;
  configPath: string;
}

async function startReady(args: string[], env?: Record<string, string>, wrap?: string[]): Promise<{ p: Proc; ready: Ready }> {
  const p = spawnCli([...args, '--port', '0', '--ready-json', '--no-qr'], env, wrap);
  const line = await eventually(async () => {
    if (p.proc.exitCode !== null) throw new Error(`host exited ${p.proc.exitCode}: ${p.stderr()}`);
    return p.stdout().includes('\n') && p.stdout().split('\n')[0];
  }, 15_000, 'ready line');
  return { p, ready: JSON.parse(line!) as Ready };
}

describe('CLI (spawned)', () => {
  test('--ready-json prints exactly one JSON line; starter config + 0600 secrets are created', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'new', 'buttpad.config.json');
    const { p, ready } = await startReady(['--config', configPath]);
    expect(Object.keys(ready)).toEqual(['event', 'port', 'pressToken', 'adminToken', 'configPath']);
    expect(ready.event).toBe('ready');
    expect(ready.port).toBeGreaterThan(0);
    expect(ready.configPath).toBe(configPath);
    expect(ready.pressToken).toMatch(/^[\w-]{43}$/);
    expect(ready.adminToken).toMatch(/^[\w-]{43}$/);
    expect(ready.pressToken).not.toBe(ready.adminToken);

    expect(existsSync(configPath)).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600); // it holds commands and their env
    const secretsPath = join(dir, 'new', 'buttpad.secrets.json');
    expect(readJson<Record<string, string>>(secretsPath)).toEqual({ pressToken: ready.pressToken, adminToken: ready.adminToken });
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);

    const base = `http://127.0.0.1:${ready.port}`;
    expect((await (await fetch(`${base}/api/health`)).json()).ok).toBe(true);
    const cfg = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${ready.pressToken}` } });
    expect(cfg.status).toBe(200);
    expect(p.stderr()).toContain('Wrote a starter config');
    expect(p.stderr()).toContain(`#token=${ready.pressToken}`);
    expect(p.stderr()).toContain(`#token=${ready.adminToken}`);
    expect(p.stderr()).toContain('Plain HTTP');

    p.proc.kill('SIGTERM');
    expect(await p.proc.exited).toBe(0);
    expect(p.stdout().trimEnd().split('\n').length).toBe(1);
  }, 20_000);

  test('tokens persist across restarts; --rotate-tokens replaces them', async () => {
    const dir = tmpDir();
    const config = join(dir, 'buttpad.config.json');
    const secrets = join(dir, 'custom', 'my.secrets.json');
    const a = await startReady(['--config', config, '--secrets', secrets]);
    a.p.proc.kill('SIGTERM');
    await a.p.proc.exited;
    const b = await startReady(['--config', config, '--secrets', secrets]);
    expect(b.ready.pressToken).toBe(a.ready.pressToken);
    expect(b.ready.adminToken).toBe(a.ready.adminToken);
    b.p.proc.kill('SIGTERM');
    await b.p.proc.exited;
    const c = await startReady(['--config', config, '--secrets', secrets, '--rotate-tokens']);
    expect(c.ready.pressToken).not.toBe(a.ready.pressToken);
    expect(c.ready.adminToken).not.toBe(a.ready.adminToken);
    expect(readJson<Record<string, string>>(secrets)).toEqual({ pressToken: c.ready.pressToken, adminToken: c.ready.adminToken });
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    expect(c.p.stderr()).toContain('Rotated the tokens');
    const old = await fetch(`http://127.0.0.1:${c.ready.port}/api/state`, { headers: { authorization: `Bearer ${a.ready.pressToken}` } });
    expect(old.status).toBe(401);
  }, 30_000);

  // A test run that itself ignores SIGHUP (nohup) passes that on to the host, which then rightly keeps running.
  const hupIgnored = signalIgnored(constants.signals.SIGHUP) === true;
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    test.skipIf(sig === 'SIGHUP' && hupIgnored)(`${sig} kills running actions' process groups, then exits 0`, async () => {
      const dir = tmpDir();
      const config = join(dir, 'buttpad.config.json');
      writeJson(config, {
        version: 1,
        pads: [{ id: 'p', name: 'P', buttons: [{ id: 'long', x: 0, y: 0, action: { type: 'shell', script: 'trap "" TERM; sleep 60 & echo "@status child $!"; wait' } }] }],
      });
      const { p, ready } = await startReady(['--config', config], { BUTTPAD_CONFIG: '/nonexistent/ignored.json' });
      const base = `http://127.0.0.1:${ready.port}`;
      const auth = { authorization: `Bearer ${ready.pressToken}` };
      expect((await (await fetch(`${base}/api/press/p/long`, { method: 'POST', headers: auth })).json()).result).toBe('started');
      const status = await eventually(async () => {
        const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as { states: Record<string, { status?: string }> };
        return st.states['p/long']?.status;
      }, 5000, 'child pid');
      const child = Number(/child (\d+)/.exec(status)![1]);
      expect(isAlive(child)).toBe(true);
      const t0 = Date.now();
      p.proc.kill(sig);
      expect(await p.proc.exited).toBe(0);
      expect(Date.now() - t0).toBeLessThan(4000);
      await eventually(async () => !isAlive(child), 2000, 'action to be gone');
      expect(p.stderr()).toContain(`${sig}: shutting down, stopping 1 running action`);
    }, 20_000);

  test.skipIf(process.platform !== 'linux')('SIGHUP is left alone when the host was started to survive it (nohup)', async () => {
    const dir = tmpDir();
    // What nohup does: the host inherits SIGHUP as ignored.
    const { p, ready } = await startReady(['--config', join(dir, 'c.json')], {}, ['/bin/sh', '-c', 'trap "" HUP; exec "$@"', 'sh']);
    p.proc.kill('SIGHUP');
    await Bun.sleep(500);
    expect(p.proc.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${ready.port}/api/health`)).status).toBe(200);
    expect(p.stderr()).not.toContain('SIGHUP');
    p.proc.kill('SIGTERM');
    expect(await p.proc.exited).toBe(0);
  }, 20_000);

  test('shutdown during a kill grace period still SIGKILLs a grandchild that ignores SIGTERM', async () => {
    const dir = tmpDir();
    const config = join(dir, 'buttpad.config.json');
    const script = `sh -c 'trap "" TERM; echo "@status child $$"; exec sleep 60 >/dev/null 2>&1' & wait`;
    writeJson(config, { version: 1, pads: [{ id: 'p', name: 'P', buttons: [{ id: 'b', x: 0, y: 0, whileRunning: 'cancel', action: { type: 'shell', shell: '/bin/sh', script } }] }] });
    const { p, ready } = await startReady(['--config', config]);
    const base = `http://127.0.0.1:${ready.port}`;
    const auth = { authorization: `Bearer ${ready.pressToken}` };
    const press = async () => ((await (await fetch(`${base}/api/press/p/b`, { method: 'POST', headers: auth })).json()) as { result: string }).result;
    const state = async () => ((await (await fetch(`${base}/api/state`, { headers: auth })).json()) as { states: Record<string, { phase: string; status?: string }> }).states['p/b']!;
    expect(await press()).toBe('started');
    const status = await eventually(async () => (await state()).status, 5000, 'child pid');
    const child = Number(/child (\d+)/.exec(status)![1]);
    try {
      await Bun.sleep(CANCEL_GRACE_MS);
      expect(await press()).toBe('cancelling');
      // The shell died of the SIGTERM; the grandchild lives on until its SIGKILL is due (2 s later).
      await eventually(async () => (await state()).phase === 'failure', 5000, 'cancelled');
      expect(isAlive(child)).toBe(true);
      const t0 = Date.now();
      p.proc.kill('SIGINT');
      expect(await p.proc.exited).toBe(0);
      expect(Date.now() - t0).toBeLessThan(4000);
      await eventually(async () => !isAlive(child), 1000, 'the grandchild to be gone');
    } finally {
      if (isAlive(child)) process.kill(child, 'SIGKILL');
    }
  }, 20_000);

  test('a button flooding its output does not hold up presses of other buttons; its timeout fires on time', async () => {
    const dir = tmpDir();
    const config = join(dir, 'buttpad.config.json');
    writeJson(config, {
      version: 1,
      pads: [
        {
          id: 'p',
          name: 'P',
          buttons: [
            { id: 'flood', x: 0, y: 0, timeoutMs: 1500, action: { type: 'shell', shell: '/bin/sh', script: 'yes' } },
            { id: 'light', x: 1, y: 0, resultHoldMs: 0, action: { type: 'shell', shell: '/bin/sh', script: 'true' } },
          ],
        },
      ],
    } satisfies ConfigInput);
    const { ready } = await startReady(['--config', config]);
    const base = `http://127.0.0.1:${ready.port}`;
    const auth = { authorization: `Bearer ${ready.pressToken}` };
    const ws = await TestClient.connect(`ws://127.0.0.1:${ready.port}/ws?token=${ready.pressToken}`);
    try {
      ws.send({ t: 'press', id: 'f', pad: 'p', button: 'flood' });
      expect((await ws.next('ack', (m) => m.id === 'f')).result).toBe('started');
      await Bun.sleep(200);
      const lags: number[] = [];
      for (let i = 0; i < 5; i++) {
        let t = performance.now();
        ws.send({ t: 'press', id: `l${i}`, pad: 'p', button: 'light' });
        await ws.next('ack', (m) => m.id === `l${i}`, 10_000);
        lags.push(performance.now() - t);
        t = performance.now();
        await fetch(`${base}/api/state`, { headers: auth });
        lags.push(performance.now() - t);
        await Bun.sleep(100);
      }
      // Without yielding to the event loop, the first of these took >10 s.
      lags.sort((a, b) => a - b);
      expect(lags[lags.length >> 1]!).toBeLessThan(100);
      expect(lags.at(-1)!).toBeLessThan(1000);
      const end = await ws.next('state', (m) => m.key === 'p/flood' && m.state.phase === 'failure', 10_000);
      if (end.state.phase !== 'failure') throw new Error('unreachable');
      expect(end.state.reason).toBe('timeout');
      expect(end.state.endedAt - end.state.startedAt).toBeLessThan(1500 + 1000);
    } finally {
      ws.close();
    }
  }, 20_000);

  for (const mode of ['--ready-json', 'plain'] as const)
    test(`a log reader that goes away does not take the host down (${mode === 'plain' ? 'log on stdout' : 'log on stderr'})`, async () => {
      const dir = tmpDir();
      const config = join(dir, 'buttpad.config.json');
      writeJson(config, { version: 1, pads: [{ id: 'p', name: 'P', buttons: [{ id: 'b', x: 0, y: 0, action: { type: 'shell', shell: '/bin/sh', script: 'echo hi' } }] }] });
      const args = [MAIN, '--config', config, '--host', '127.0.0.1', '--port', '0', '--no-qr', ...(mode === 'plain' ? [] : [mode])];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } });
      const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', () => {});
      try {
        const port = await eventually(async () => {
          if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}`);
          return mode === 'plain' ? Number(/Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1]) : out.includes('\n') && (JSON.parse(out.split('\n')[0]!) as Ready).port;
        }, 15_000, 'host to listen');
        const { pressToken } = readJson<{ pressToken: string }>(join(dir, 'buttpad.secrets.json'));
        // e.g. `buttpad | tee log`, and tee dies
        (mode === 'plain' ? child.stdout : child.stderr).destroy();
        await Bun.sleep(100);
        for (let i = 0; i < 3; i++) {
          // Each press logs a line or two.
          await fetch(`http://127.0.0.1:${port}/api/press/p/b`, { method: 'POST', headers: { authorization: `Bearer ${pressToken}` } });
          await Bun.sleep(100);
        }
        expect(await Promise.race([exited, Bun.sleep(500).then(() => 'still running')])).toBe('still running');
        expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
      } finally {
        child.kill('SIGKILL');
      }
    }, 20_000);

  test.skipIf(!Bun.which('openssl'))('--tls-cert/--tls-key serve HTTPS', async () => {
    const dir = tmpDir();
    const [cert, key] = [join(dir, 'cert.pem'), join(dir, 'key.pem')];
    const gen = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
    expect(gen.exitCode).toBe(0);
    const { p, ready } = await startReady(['--config', join(dir, 'c.json'), '--tls-cert', cert, '--tls-key', key]);
    const r = await fetch(`https://127.0.0.1:${ready.port}/api/health`, { tls: { rejectUnauthorized: false } });
    expect((await r.json()).ok).toBe(true);
    expect(p.stderr()).toContain(`https://localhost:${ready.port}/#token=`);
    expect(p.stderr()).not.toContain('Plain HTTP');
  }, 20_000);

  test('invalid config → exit 1 with the errors', async () => {
    const dir = tmpDir();
    const config = join(dir, 'bad.json');
    writeJson(config, { version: 1, pads: [{ id: 'p', name: 'P', buttons: [{ id: 'a', x: 5, y: 0, action: { type: 'shell', script: 'x' } }] }] });
    const p = spawnCli(['--config', config, '--port', '0']);
    expect(await p.proc.exited).toBe(1);
    expect(p.stderr()).toContain('invalid config');
    expect(p.stderr()).toContain('pad "p" › button "a": extends outside the 2x2 grid (line 8)');
    expect(readFileSync(config, 'utf8')).toContain('"x": 5');
  }, 15_000);

  test('usage errors exit 2; --help and --version exit 0', async () => {
    const bad = spawnCli(['--bogus']);
    expect(await bad.proc.exited).toBe(2);
    expect(bad.stderr()).toContain('Usage: buttpad');
    const help = spawnCli(['--help']);
    expect(await help.proc.exited).toBe(0);
    expect(help.stdout()).toContain('--ready-json');
    const version = spawnCli(['--version']);
    expect(await version.proc.exited).toBe(0);
    expect(version.stdout()).toMatch(/^buttpad \d+\.\d+\.\d+\n$/);
  }, 15_000);

  test('a busy port is reported clearly', async () => {
    const dir = tmpDir();
    const first = await startReady(['--config', join(dir, 'a.json')]);
    const second = spawnCli(['--config', join(dir, 'a.json'), '--port', String(first.ready.port), '--host', '0.0.0.0']);
    expect(await second.proc.exited).toBe(1);
    expect(second.stderr()).toContain(`buttpad: can't listen on 0.0.0.0:${first.ready.port}: port ${first.ready.port} is in use (another ButtPad?)`);
  }, 20_000);
});

test.skipIf(!process.env.BUTTPAD_TEST_COMPILE)('bun run compile: the binary serves the embedded web app', async () => {
  const dir = tmpDir();
  const bin = join(dir, 'buttpad');
  const build = Bun.spawnSync([process.execPath, 'build', '--compile', MAIN, '--outfile', bin], { cwd: resolve(import.meta.dir, '..'), stderr: 'pipe' });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const proc = Bun.spawn([bin, '--config', join(dir, 'c.json'), '--port', '0', '--ready-json', '--no-qr'], { stdout: 'pipe', stderr: 'pipe', cwd: dir });
  procs.push({ proc, stdout: () => '', stderr: () => '' });
  const reader = proc.stdout.getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    line += new TextDecoder().decode(value);
  }
  const { port } = JSON.parse(line) as Ready;
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const src = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  expect(src).toBeDefined();
  const js = await fetch(new URL(src!, `http://127.0.0.1:${port}/`));
  expect(js.status).toBe(200);
  expect((await js.text()).length).toBeGreaterThan(1000);
}, 120_000);
