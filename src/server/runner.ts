/**
 * Runs one action: spawns it detached (own process group on POSIX) so a kill reaches the whole
 * tree, parses the stdout output protocol, keeps capped output tails, and enforces the timeout.
 *
 * Output protocol (stdout, one directive per line):
 *   @progress N   0..100, determinate progress
 *   @status text  status line shown while running
 *   @result text  result text shown after the run
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import type { Action } from '../core/config.ts';

export const TAIL_BYTES = 16 * 1024;
export const RESULT_MAX = 200;
export const KILL_GRACE_MS = 2000;
/** After the main process exits, how long to wait for its output pipes to drain. */
const DRAIN_MS = 250;
/** Min interval between progress/status updates (they become WebSocket broadcasts). */
const UPDATE_INTERVAL_MS = 50;
const MAX_LINE = 16 * 1024;
/** Longer timer delays overflow and fire immediately. */
export const MAX_DELAY_MS = 2 ** 31 - 1;

const isWindows = process.platform === 'win32';

export interface RunSpec {
  action: Action;
  /** Directory relative `cwd`s and commands resolve against (the config file's directory). */
  baseDir: string;
  timeoutMs: number;
  /** Extra env vars (BUTTPAD_*), applied over host env + action env. */
  env?: Record<string, string>;
  killGraceMs?: number;
}

export interface RunUpdate {
  progress?: number;
  status?: string;
}

export interface RunOutcome {
  /** null when killed by a signal or never spawned. */
  exitCode: number | null;
  signal: string | null;
  reason?: 'timeout' | 'spawn';
  /** Result text per the output protocol, at most RESULT_MAX chars. */
  text?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunHooks {
  onUpdate?(u: RunUpdate): void;
  /** Always called asynchronously, exactly once. */
  onExit?(o: RunOutcome): void;
}

export interface RunHandle {
  readonly pid: number | undefined;
  readonly done: Promise<RunOutcome>;
  /** SIGTERM the process group; SIGKILL whatever is left after the grace period. Windows: taskkill /T /F. */
  kill(): void;
  /** SIGKILL the process group now. */
  forceKill(): void;
  /** Whether anything in the run's process group is still alive. */
  alive(): boolean;
  stdout(): string;
  stderr(): string;
}

/** Byte-capped tail of a stream. */
export class Tail {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private dropped = false;

  constructor(readonly cap = TAIL_BYTES) {}

  push(b: Uint8Array) {
    if (b.length >= this.cap) {
      this.chunks = [b.slice(b.length - this.cap)];
      this.dropped ||= this.size > 0 || b.length > this.cap;
      this.size = this.cap;
      return;
    }
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.cap) {
      const first = this.chunks[0]!;
      const excess = this.size - this.cap;
      this.dropped = true;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    const all = Buffer.concat(this.chunks);
    let start = 0;
    // Don't start mid-character after trimming.
    if (this.dropped) while (start < all.length && start < 4 && (all[start]! & 0xc0) === 0x80) start++;
    return all.subarray(start).toString('utf8');
  }
}

/** Splits a byte stream into UTF-8 lines (\n, \r\n or \r); overlong lines are cut at MAX_LINE. */
class LineReader {
  private decoder = new TextDecoder();
  private buf = '';

  constructor(private onLine: (line: string) => void) {}

  push(b: Uint8Array) {
    this.feed(this.decoder.decode(b, { stream: true }));
  }

  end() {
    this.feed(this.decoder.decode());
    if (this.buf) this.onLine(this.buf);
    this.buf = '';
  }

  private feed(s: string) {
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.append(s.slice(start, i));
      const line = this.buf;
      this.buf = '';
      this.onLine(line);
      start = i + 1;
    }
    this.append(s.slice(start));
  }

  private append(part: string) {
    const room = MAX_LINE - this.buf.length;
    if (room > 0) this.buf += part.length > room ? part.slice(0, room) : part;
  }
}

const ANSI =/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Trim and cap a display string to RESULT_MAX characters (code points). */
export function clip(s: string): string {
  const t = s.trim();
  if (t.length <= RESULT_MAX) return t;
  const cps = Array.from(t);
  return cps.length <= RESULT_MAX ? t : cps.slice(0, RESULT_MAX - 1).join('') + '…';
}

export type Directive = { kind: 'progress'; value: number } | { kind: 'status'; text: string } | { kind: 'result'; text: string };

/** Parse one stdout line; `null` for a plain line, `undefined` for an unknown/invalid `@` line. */
export function parseDirective(line: string): Directive | null | undefined {
  if (!line.startsWith('@')) return null;
  const m = /^@(progress|status|result)(?:[ \t]+(.*))?$/.exec(line);
  if (!m) return undefined;
  const arg = (m[2] ?? '').trim();
  if (m[1] === 'progress') {
    const value = Number.parseFloat(arg);
    return Number.isFinite(value) ? { kind: 'progress', value } : undefined;
  }
  return { kind: m[1] as 'status' | 'result', text: arg };
}

/**
 * Result text rules: last `@result`; else the last non-empty non-`@` stdout line; on failure with
 * neither, the last non-empty stderr line. An explicit empty `@result` means "no text".
 */
export function pickResultText(o: { result?: string; lastOut?: string; lastErr?: string; failed: boolean }): string | undefined {
  const t = o.result ?? o.lastOut ?? (o.failed ? o.lastErr : undefined);
  return t ? clip(t) : undefined;
}

const hasSep = (p: string) => p.includes('/') || (isWindows && p.includes('\\'));

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || (isWindows && p.startsWith('~\\'))) return join(homedir(), p.slice(2));
  return p;
}

export const resolveCwd = (baseDir: string, cwd?: string) => (cwd ? resolve(baseDir, expandHome(cwd)) : baseDir);

/** argv for a shell action. `verbatim`: pass args to Windows unquoted (cmd.exe does its own parsing). */
export function shellArgv(
  script: string,
  shell: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): { argv: string[]; verbatim: boolean } {
  if (platform !== 'win32') return { argv: [shell || env.SHELL || '/bin/sh', '-c', script], verbatim: false };
  const sh = shell || env.ComSpec || env.COMSPEC || 'cmd.exe';
  const name = win32.basename(sh).toLowerCase();
  if (name === 'cmd' || name === 'cmd.exe') return { argv: [sh, '/d', '/s', '/c', `"${script}"`], verbatim: true };
  if (/^(powershell|pwsh)(\.exe)?$/.test(name)) return { argv: [sh, '-NoProfile', '-NonInteractive', '-Command', script], verbatim: false };
  return { argv: [sh, '-c', script], verbatim: false };
}

class SpawnError extends Error {}

function describeSpawnError(e: unknown, action: Action, cmd0: string): string {
  if (e instanceof SpawnError) return e.message;
  const code = (e as NodeJS.ErrnoException)?.code;
  if (action.type === 'shell') {
    if (code === 'ENOENT') return `shell not found: ${cmd0}`;
    if (code === 'EACCES') return `permission denied: ${cmd0}`;
  } else {
    if (code === 'ENOENT' && !hasSep(action.command)) return `command not found: ${action.command}`;
    if (code === 'ENOENT') return existsSync(cmd0) ? `cannot execute ${cmd0}: interpreter not found (check its #! line)` : `not found: ${cmd0}`;
    if (code === 'EACCES') return `permission denied: ${cmd0} (is it executable? chmod +x)`;
  }
  return `spawn failed: ${(e as Error)?.message ?? String(e)}`;
}

function spawnChild(argv: string[], cwd: string, env: Record<string, string | undefined>, verbatim: boolean) {
  return Bun.spawn(argv, {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
  });
}
type Child = ReturnType<typeof spawnChild>;

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export function startRun(spec: RunSpec, hooks: RunHooks = {}): RunHandle {
  const t0 = Date.now();
  const grace = spec.killGraceMs ?? KILL_GRACE_MS;
  const outTail = new Tail();
  const errTail = new Tail();
  let result: string | undefined;
  let lastOut: string | undefined;
  let lastErr: string | undefined;
  let finished = false;
  let exited = false;
  let timedOut = false;

  // Coalesced progress/status updates.
  let pending: RunUpdate | undefined;
  let lastUpdate = 0;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  const flushUpdate = () => {
    updateTimer = undefined;
    if (!pending || finished) return;
    const u = pending;
    pending = undefined;
    lastUpdate = Date.now();
    try {
      hooks.onUpdate?.(u);
    } catch (e) {
      console.error('buttpad: run update handler failed:', e);
    }
  };
  const scheduleUpdate = () => {
    if (!pending || updateTimer) return;
    const wait = UPDATE_INTERVAL_MS - (Date.now() - lastUpdate);
    if (wait <= 0) flushUpdate();
    else updateTimer = setTimeout(flushUpdate, wait);
  };

  const outLines = new LineReader((raw) => {
    if (finished) return;
    const line = stripAnsi(raw).trimEnd();
    const d = parseDirective(line);
    if (d === null) {
      if (line.trim()) lastOut = line;
    } else if (d?.kind === 'progress') pending = { ...pending, progress: d.value };
    else if (d?.kind === 'status') pending = { ...pending, status: clip(d.text) };
    else if (d?.kind === 'result') result = d.text;
  });
  const errLines = new LineReader((raw) => {
    if (finished) return;
    const line = stripAnsi(raw).trim();
    if (line) lastErr = line;
  });

  const action = spec.action;
  let cmd0 = action.type === 'exec' ? action.command : (action.shell ?? '');
  let child: Child | undefined;
  let spawnError: string | undefined;
  try {
    const cwd = resolveCwd(spec.baseDir, action.cwd);
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {}
    if (!isDir) throw new SpawnError(`cwd not found: ${cwd}`);
    const env = { ...process.env, ...action.env, ...spec.env };
    let argv: string[];
    let verbatim = false;
    if (action.type === 'exec') {
      const cmd = expandHome(action.command);
      cmd0 = hasSep(cmd) ? resolve(cwd, cmd) : cmd;
      argv = [cmd0, ...action.args];
    } else {
      ({ argv, verbatim } = shellArgv(action.script, action.shell));
      cmd0 = argv[0]!;
    }
    child = spawnChild(argv, cwd, env, verbatim);
  } catch (e) {
    spawnError = describeSpawnError(e, action, cmd0);
  }

  const pump = async (stream: ReadableStream<Uint8Array>, tail: Tail, lines: LineReader) => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tail.push(value);
        lines.push(value);
        if (!finished) scheduleUpdate();
      }
    } catch {
    } finally {
      lines.end();
    }
  };

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const taskkill = (pid: number) => {
    try {
      Bun.spawn(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    } catch {}
  };
  const signalGroup = (sig: 'SIGTERM' | 'SIGKILL') => {
    if (!child) return;
    if (isWindows) {
      if (!exited) taskkill(child.pid);
      return;
    }
    try {
      process.kill(-child.pid, sig);
    } catch (e) {
      if (errCode(e) !== 'ESRCH' && !exited) {
        try {
          child.kill(sig);
        } catch {}
      }
    }
  };
  const alive = () => {
    if (!child) return false;
    if (isWindows) return !exited;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (e) {
      return errCode(e) === 'EPERM';
    }
  };
  const kill = () => {
    if (!child || killTimer || (exited && !alive())) return;
    signalGroup('SIGTERM');
    if (isWindows) return;
    killTimer = setTimeout(() => signalGroup('SIGKILL'), grace);
    killTimer.unref?.();
  };

  const timeout = child
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, Math.min(spec.timeoutMs, MAX_DELAY_MS))
    : undefined;

  const done = new Promise<RunOutcome>((resolveDone) => {
    const finish = (exitCode: number | null, signal: string | null) => {
      clearTimeout(timeout);
      flushUpdate();
      clearTimeout(updateTimer);
      finished = true;
      const reason = spawnError ? 'spawn' : timedOut ? 'timeout' : undefined;
      const failed = reason !== undefined || exitCode !== 0;
      const outcome: RunOutcome = {
        exitCode,
        signal,
        reason,
        text: spawnError ? clip(spawnError) : pickResultText({ result, lastOut, lastErr, failed }),
        stdout: outTail.text(),
        stderr: errTail.text(),
        durationMs: Date.now() - t0,
      };
      try {
        hooks.onExit?.(outcome);
      } catch (e) {
        console.error('buttpad: run exit handler failed:', e);
      }
      resolveDone(outcome);
    };
    if (!child) {
      queueMicrotask(() => finish(null, null));
      return;
    }
    const c = child;
    const pumps = Promise.all([pump(c.stdout, outTail, outLines), pump(c.stderr, errTail, errLines)]);
    void c.exited.then(async () => {
      exited = true;
      clearTimeout(timeout);
      // Background grandchildren may hold the pipes open; don't wait for them.
      await Promise.race([pumps, Bun.sleep(DRAIN_MS)]);
      finish(c.exitCode, c.signalCode);
    });
  });

  return {
    pid: child?.pid,
    done,
    kill,
    forceKill: () => signalGroup('SIGKILL'),
    alive,
    stdout: () => outTail.text(),
    stderr: () => errTail.text(),
  };
}
