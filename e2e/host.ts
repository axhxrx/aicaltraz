/** Starts a real ButtPad host (src/server/main.ts) for a spec file: temp config dir, free port. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigInput } from '../src/core/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Ready {
  event: 'ready';
  port: number;
  pressToken: string;
  adminToken: string;
  configPath: string;
}

export interface Host {
  readonly url: string;
  readonly port: number;
  readonly pressToken: string;
  readonly adminToken: string;
  readonly configPath: string;
  /** (Re)start on the same port, same tokens. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Stop and delete the temp dir. */
  dispose(): Promise<void>;
  /** Everything the host printed (for debugging failures). */
  log(): string;
}

export async function startHost(config: ConfigInput): Promise<Host> {
  const dir = mkdtempSync(path.join(tmpdir(), 'buttpad-e2e-'));
  const configPath = path.join(dir, 'buttpad.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  let proc: ChildProcess | null = null;
  let ready: Ready | null = null;
  let output = '';

  const start = () =>
    new Promise<void>((resolve, reject) => {
      const args = ['src/server/main.ts', '--config', configPath, '--host', '127.0.0.1', '--port', String(ready?.port ?? 0), '--ready-json', '--no-qr'];
      const p = spawn('bun', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } });
      proc = p;
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`host did not get ready:\n${output}`)), 20_000);
      p.stdout!.on('data', (chunk: Buffer) => {
        output += chunk;
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const msg = JSON.parse(line) as Ready;
            if (msg.event === 'ready') {
              ready = msg;
              clearTimeout(timer);
              resolve();
            }
          } catch {
            /* not our line */
          }
        }
      });
      p.stderr!.on('data', (chunk: Buffer) => (output += chunk));
      p.on('exit', (code) => {
        clearTimeout(timer);
        if (proc === p) proc = null;
        reject(new Error(`host exited (${code}) before ready:\n${output}`));
      });
    });

  const stop = async () => {
    const p = proc;
    if (!p) return;
    proc = null;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => p.kill('SIGKILL'), 5000);
      p.once('exit', () => (clearTimeout(kill), resolve()));
      p.kill('SIGTERM');
    });
  };

  await start();
  const r = () => ready!;
  return {
    get url() {
      return `http://127.0.0.1:${r().port}`;
    },
    get port() {
      return r().port;
    },
    get pressToken() {
      return r().pressToken;
    },
    get adminToken() {
      return r().adminToken;
    },
    configPath,
    start,
    stop,
    async dispose() {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    },
    log: () => output,
  };
}
