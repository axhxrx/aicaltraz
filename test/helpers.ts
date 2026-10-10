import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigInput } from '../src/core/config.ts';
import type { ServerMsg } from '../src/core/protocol.ts';

const dirs: string[] = [];

/** A fresh temp dir (realpath'd), removed by `cleanupTmp()`. */
export function tmpDir(prefix = 'buttpad-test-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

export function cleanupTmp() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function writeExecutable(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

export const writeJson = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 2) + '\n');
export const readJson = <T = unknown>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;

/** A one-pad config whose buttons are given as partials. */
export function padConfig(buttons: NonNullable<ConfigInput['pads'][number]['buttons']>, pad: Partial<ConfigInput['pads'][number]> = {}): ConfigInput {
  return { version: 1, pads: [{ id: 'p', name: 'Pad', cols: 4, rows: 4, buttons, ...pad }] };
}

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(15);
  }
}

/** Polls an async probe until it returns something truthy. */
export async function eventually<T>(fn: () => Promise<T | undefined | false | null>, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** True if the process exists and isn't a zombie. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return process.platform !== 'linux';
  }
}

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/** WebSocket test client that records every server message. */
export class TestClient {
  readonly msgs: ServerMsg[] = [];
  closed: { code: number; reason: string } | undefined;
  private wakers = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      this.msgs.push(JSON.parse(String(e.data)) as ServerMsg);
      for (const w of this.wakers) w();
    };
    ws.onclose = (e) => {
      this.closed = { code: e.code, reason: e.reason };
      for (const w of this.wakers) w();
    };
  }

  static connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    const c = new TestClient(ws);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(c);
      ws.onerror = () => reject(new Error(`WebSocket ${url} failed`));
    });
  }

  send(v: unknown) {
    this.ws.send(typeof v === 'string' ? v : JSON.stringify(v));
  }

  /** First message (at index ≥ from) of type `t` matching `pred`; waits if there is none yet. */
  async next<T extends ServerMsg['t']>(t: T, pred: (m: Msg<T>) => boolean = () => true, timeoutMs = 5000, from = 0): Promise<Msg<T>> {
    const find = () => this.msgs.slice(from).find((m): m is Msg<T> => m.t === t && pred(m as Msg<T>));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = find();
      if (m) return m;
      if (this.closed) throw new Error(`socket closed while waiting for "${t}"`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for "${t}"; got ${JSON.stringify(this.msgs.map((x) => x.t))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        function done() {
          clearTimeout(timer);
          wakers.delete(done);
          resolve();
        }
        const wakers = this.wakers;
        wakers.add(done);
      });
    }
  }

  indexOf(m: ServerMsg) {
    return this.msgs.indexOf(m);
  }

  close() {
    this.ws.close();
  }
}
