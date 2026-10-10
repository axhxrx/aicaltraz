/**
 * Runs one action: spawns it detached (own process group on POSIX) so a kill reaches the whole
 * tree, parses the stdout output protocol, keeps capped output tails, and enforces the timeout.
 *
 * Output protocol (stdout, one directive per line):
 *   @progress N   0..100, determinate progress
 *   @status text  status line shown while running
 *   @result text  result text shown after the run
 *   @state text   the device's latched state ("REC ●", "ON 80%"), kept across runs; `@state` alone clears it
 *
 * Text that reaches clients (status, result, latched state) is sanitized: ANSI escape sequences,
 * control characters and bidi overrides/isolates are removed. So is the host log (sanitizeLog).
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, win32 } from 'node:path';
import type { Action } from '../core/config.ts';
import { errCode, hasLiveMember } from './proc.ts';

export const TAIL_BYTES = 16 * 1024;
export const RESULT_MAX = 200;
/** Latched device state (`@state`), at most this many characters. */
export const LATCHED_MAX = 40;
export const KILL_GRACE_MS = 2000;
/** While a killed run's process group lingers, how often to check whether it's gone. */
const KILL_POLL_MS = 50;
/** After the main process exits, how long to wait for its output pipes to drain; then they're closed. */
export const DRAIN_MS = 250;
/** Min interval between progress/status updates (they become WebSocket broadcasts). */
const UPDATE_INTERVAL_MS = 50;
const MAX_LINE = 16 * 1024;
/** Longer timer delays overflow and fire immediately. */
export const MAX_DELAY_MS = 2 ** 31 - 1;

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

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
  /** `@state text`: the device's latched state; null when `@state` cleared it. */
  latched?: string | null;
}

export interface RunOutcome {
  /** null when killed by a signal or never spawned. */
  exitCode: number | null;
  signal: string | null;
  reason?: 'timeout' | 'spawn';
  /** Result text per the output protocol, at most RESULT_MAX chars. A spawn failure names files by their base name. */
  text?: string;
  /** Spawn failure in full (absolute paths), for the admin run log. */
  error?: string;
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
  /** What runs, for the run log: the argv shell-quoted (`<shell> -c <script>` for a shell action). */
  readonly command?: string;
  /** The resolved working folder. */
  readonly cwd?: string;
  readonly done: Promise<RunOutcome>;
  /**
   * SIGTERM the process group; SIGKILL whatever is left after the grace period. Windows: taskkill /T /F.
   * Returns whether a signal was delivered (false: nothing left to kill, e.g. it already exited).
   */
  kill(): boolean;
  /** SIGKILL the process group now. */
  forceKill(): void;
  /** Whether anything in the run's process group is still alive (on Linux, zombies don't count). */
  alive(): boolean;
  /** Killed, and the process group was neither seen empty nor SIGKILLed yet (the grace period is running). */
  dying(): boolean;
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

/** Splits a byte stream into UTF-8 lines (\n, \r\n or a bare \r); overlong lines are cut at MAX_LINE. */
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

// CSI (ESC [ or the 8-bit CSI … final byte), OSC (ESC ] … BEL or ST, or to the end of the line),
// DCS/SOS/PM/APC strings (ESC P/X/^/_ … ST), other two-byte escapes, and a stray ESC.
const ANSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]|\x1b/g;
const SPACING = /[\t\n\v\f\r]/g;
/** C0 and C1 controls (and DEL), bidi embeddings/overrides U+202A–U+202E, isolates U+2066–U+2069. */
const CONTROLS = /[\x00-\x08\x0e-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Display text from untrusted output: no escape sequences, controls (tabs etc. become spaces) or bidi overrides. */
export const sanitize = (s: string) => s.replace(ANSI, '').replace(SPACING, ' ').replace(CONTROLS, '');

/** Host log text (it goes to a terminal): sanitize() line by line, so a multi-line message keeps its line breaks. */
export const sanitizeLog = (s: string) => s.split('\n').map(sanitize).join('\n');

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Trim and cap a display string to `max` characters (code points), cutting between graphemes, with an ellipsis. */
export function clip(s: string, max = RESULT_MAX): string {
  const t = s.trim();
  if (t.length <= max) return t;
  if (Array.from(t).length <= max) return t;
  let out = '';
  let n = 0;
  for (const { segment } of graphemes.segment(t)) {
    const len = Array.from(segment).length;
    if (n + len > max - 1) break;
    out += segment;
    n += len;
  }
  return out.trimEnd() + '…';
}

export type Directive = { kind: 'progress'; value: number } | { kind: 'status' | 'result' | 'state'; text: string };

/** Parse one stdout line; `null` for a plain line, `undefined` for an unknown/invalid `@` line. */
export function parseDirective(line: string): Directive | null | undefined {
  if (!line.startsWith('@')) return null;
  const m = /^@(progress|status|result|state)(?:[ \t]+(.*))?$/.exec(line);
  if (!m) return undefined;
  const arg = (m[2] ?? '').trim();
  if (m[1] === 'progress') {
    const value = Number.parseFloat(arg);
    return Number.isFinite(value) ? { kind: 'progress', value } : undefined;
  }
  return { kind: m[1] as 'status' | 'result' | 'state', text: arg };
}

/**
 * Result text rules: last `@result`; else the last non-empty non-`@` stdout line; on failure with
 * neither, the last non-empty stderr line. An explicit empty `@result` means "no text".
 */
export function pickResultText(o: { result?: string; lastOut?: string; lastErr?: string; failed: boolean }): string | undefined {
  const t = o.result ?? o.lastOut ?? (o.failed ? o.lastErr : undefined);
  return t ? clip(t) || undefined : undefined;
}

const hasSep = (p: string) => p.includes('/') || (isWindows && p.includes('\\'));

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || (isWindows && p.startsWith('~\\'))) return join(homedir(), p.slice(2));
  return p;
}

export const resolveCwd = (baseDir: string, cwd?: string) => (cwd ? resolve(baseDir, expandHome(cwd)) : baseDir);

/**
 * argv for a shell action. POSIX: `shell` or /bin/sh — never $SHELL, so a script behaves the same
 * whether the host was started from a terminal or by a service. Windows: `shell` or %ComSpec% or
 * cmd.exe. `verbatim`: pass args to Windows unquoted (cmd.exe does its own parsing).
 */
export function shellArgv(
  script: string,
  shell: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): { argv: string[]; verbatim: boolean } {
  if (platform !== 'win32') return { argv: [shell || '/bin/sh', '-c', script], verbatim: false };
  const sh = shell || env.ComSpec || env.COMSPEC || 'cmd.exe';
  const name = win32.basename(sh).toLowerCase();
  if (name === 'cmd' || name === 'cmd.exe') return { argv: [sh, '/d', '/s', '/c', `"${script}"`], verbatim: true };
  if (/^(powershell|pwsh)(\.exe)?$/.test(name)) return { argv: [sh, '-NoProfile', '-NonInteractive', '-Command', script], verbatim: false };
  return { argv: [sh, '-c', script], verbatim: false };
}

const SAFE_WORD = /^[\w@%+=:,./-]+$/;

/** argv as a POSIX shell command line (what ran, for the run log). */
export function shellQuote(argv: readonly string[]): string {
  return argv.map((a) => (SAFE_WORD.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');
}

/** A spawn failure: in full for the admin run log (`error`), and as every client sees it (`text`: no host paths). */
interface SpawnFailure {
  text: string;
  error: string;
}

const fileName = (p: string) => (isWindows ? win32.basename(p) : basename(p)) || p;
const failure = (what: string, path: string): SpawnFailure => ({ error: `${what}: ${path}`, text: `${what}: ${fileName(path)}` });

class SpawnError extends Error {
  constructor(readonly failure: SpawnFailure) {
    super(failure.error);
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function describeSpawnError(e: unknown, action: Action, cmd0: string): SpawnFailure {
  if (e instanceof SpawnError) return e.failure;
  const code = errCode(e);
  const shell = action.type === 'shell';
  if (code === 'ENOENT') {
    if (hasSep(cmd0) && existsSync(cmd0)) return failure('interpreter not found (check the #! line)', cmd0);
    return failure(shell ? 'shell not found' : 'command not found', cmd0);
  }
  if ((code === 'EACCES' || code === 'ENOEXEC' || code === 'EISDIR') && isDir(cmd0)) return failure('is a directory', cmd0);
  if (code === 'EACCES') return failure('permission denied (chmod +x?)', cmd0);
  if (code === 'ENOEXEC') return failure('not executable as a program (missing #! line?)', cmd0);
  return { error: `spawn failed: ${(e as Error)?.message ?? String(e)}`, text: `spawn failed${code ? ` (${code})` : ''}` };
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

/** A run that is over before it starts (action `none`): exit 0, reported asynchronously like any run. */
export function finishedRun(o: Partial<RunOutcome> = {}, hooks: RunHooks = {}): RunHandle {
  const outcome: RunOutcome = { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 0, ...o };
  const done = new Promise<RunOutcome>((resolveDone) =>
    queueMicrotask(() => {
      try {
        hooks.onExit?.(outcome);
      } catch (e) {
        console.error('buttpad: run exit handler failed:', e);
      }
      resolveDone(outcome);
    }),
  );
  return { pid: undefined, done, kill: () => false, forceKill: () => {}, alive: () => false, dying: () => false, stdout: () => '', stderr: () => '' };
}

export function startRun(spec: RunSpec, hooks: RunHooks = {}): RunHandle {
  const action = spec.action;
  if (action.type === 'none') return finishedRun({}, hooks);
  const t0 = performance.now();
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
  let lastUpdate = -Infinity;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  const flushUpdate = () => {
    clearTimeout(updateTimer);
    updateTimer = undefined;
    if (!pending || finished) return;
    const u = pending;
    pending = undefined;
    lastUpdate = performance.now();
    try {
      hooks.onUpdate?.(u);
    } catch (e) {
      console.error('buttpad: run update handler failed:', e);
    }
  };
  const scheduleUpdate = () => {
    if (!pending || updateTimer) return;
    const wait = UPDATE_INTERVAL_MS - (performance.now() - lastUpdate);
    if (wait <= 0) flushUpdate();
    else updateTimer = setTimeout(flushUpdate, wait);
  };

  const outLines = new LineReader((raw) => {
    if (finished) return;
    const line = sanitize(raw).trimEnd();
    const d = parseDirective(line);
    if (d === null) {
      if (line.trim()) lastOut = line;
    } else if (d?.kind === 'progress') pending = { ...pending, progress: d.value };
    else if (d?.kind === 'status') pending = { ...pending, status: clip(d.text) };
    else if (d?.kind === 'state') pending = { ...pending, latched: clip(d.text, LATCHED_MAX) || null };
    else if (d?.kind === 'result') result = d.text;
  });
  const errLines = new LineReader((raw) => {
    if (finished) return;
    const line = sanitize(raw).trim();
    if (line) lastErr = line;
  });

  let cmd0 = action.type === 'exec' ? action.command : (action.shell ?? '');
  let child: Child | undefined;
  let spawnError: SpawnFailure | undefined;
  let command: string | undefined;
  let cwd: string | undefined;
  try {
    cwd = resolveCwd(spec.baseDir, action.cwd);
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
    command = verbatim ? argv.join(' ') : shellQuote(argv);
    if (!isDir(cwd)) throw new SpawnError(failure('cwd not found', cwd));
    child = spawnChild(argv, cwd, env, verbatim);
  } catch (e) {
    spawnError = describeSpawnError(e, action, cmd0);
  }

  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, tail: Tail, lines: LineReader) => {
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tail.push(value);
        if (!finished) {
          lines.push(value);
          scheduleUpdate();
        }
        // Reads of a pipe that always has data resolve without ever returning to the event loop: a
        // firehose (`yes`) would starve timers (timeouts!) and sockets. Give the event loop a turn.
        await new Promise((r) => setImmediate(r));
      }
    } catch {}
  };

  /** The group was seen empty (or all zombies) after the leader exited: its id may be recycled, never signal it again. */
  let gone = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const taskkill = (pid: number) => {
    try {
      Bun.spawn(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    } catch {}
  };
  /** Returns whether the signal was delivered. */
  const signalGroup = (sig: 'SIGTERM' | 'SIGKILL'): boolean => {
    if (!child || gone) return false;
    if (isWindows) {
      if (exited) return false;
      taskkill(child.pid);
      return true;
    }
    try {
      process.kill(-child.pid, sig);
      return true;
    } catch (e) {
      if (exited) {
        if (errCode(e) === 'ESRCH') gone = true;
        return false;
      }
      // The leader lives but its group can't be signalled (it left the group, or EPERM): signal it alone.
      try {
        child.kill(sig);
        return true;
      } catch {
        return false;
      }
    }
  };
  const alive = () => {
    if (!child || gone) return false;
    if (isWindows) return !exited;
    try {
      process.kill(-child.pid, 0);
    } catch (e) {
      if (errCode(e) === 'EPERM') return true;
      if (exited) gone = true;
      return !exited;
    }
    // Members that died stay zombies until their new parent reaps them (some inits take a second or
    // more, a PID-1 host never does), and kill() counts zombies. Only zombies left = gone for good.
    if (exited && isLinux && !hasLiveMember(child.pid)) gone = true;
    return !gone;
  };
  const stopKillTimers = () => {
    clearTimeout(killTimer);
    clearInterval(pollTimer);
    killTimer = pollTimer = undefined;
  };
  const kill = (): boolean => {
    if (killTimer) return true; // already on its way down
    if ((exited && !alive()) || !signalGroup('SIGTERM')) return false;
    if (isWindows) return true; // taskkill /F is final
    killTimer = setTimeout(() => {
      stopKillTimers();
      if (alive()) signalGroup('SIGKILL');
    }, grace);
    // Stop tracking as soon as the group is empty, so the delayed SIGKILL can't hit a recycled pid.
    pollTimer = setInterval(() => {
      if (!alive()) stopKillTimers();
    }, KILL_POLL_MS);
    killTimer.unref?.();
    pollTimer.unref?.();
    return true;
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
      // A last line without a newline; a background process may still hold the pipes open.
      outLines.end();
      errLines.end();
      flushUpdate();
      finished = true;
      const reason = spawnError ? 'spawn' : timedOut ? 'timeout' : undefined;
      const failed = reason !== undefined || exitCode !== 0;
      const outcome: RunOutcome = {
        exitCode,
        signal,
        reason,
        text: spawnError ? clip(sanitize(spawnError.text)) : pickResultText({ result, lastOut, lastErr, failed }),
        stdout: outTail.text(),
        stderr: errTail.text(),
        durationMs: Math.round(performance.now() - t0),
      };
      if (spawnError) outcome.error = spawnError.error;
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
      // …and don't keep reading what they write either (`(yes &); echo x` would keep the host busy
      // forever): close our ends of the pipes. Their next write fails (EPIPE/SIGPIPE). They are not
      // killed: a finished run may leave a background process behind on purpose.
      for (const r of readers) r.cancel().catch(() => {});
    });
  });

  return {
    pid: child?.pid,
    command,
    cwd,
    done,
    kill,
    forceKill: () => {
      stopKillTimers();
      signalGroup('SIGKILL');
    },
    alive,
    dying: () => killTimer !== undefined,
    stdout: () => outTail.text(),
    stderr: () => errTail.text(),
  };
}
