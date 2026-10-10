/**
 * buttpad.state.json, next to the config (mode 0600): what the host must not forget across a
 * restart or a crash.
 *
 * - per button: the last run id (ids keep increasing across restarts), the last result (READY's
 *   `last`) and the latched device state (`@state`);
 * - the runs in flight: pid, process group, start time and a start-time fingerprint of the
 *   process, so a host started after a crash can stop what the crashed one left running (and only
 *   that: a PID reused by another process has another fingerprint) and say those runs were
 *   interrupted. Runs a graceful shutdown stopped stay listed (`stopped`) for the same report.
 *
 * Written atomically (temp file + rename), throttled: routine changes at most every
 * SAVE_INTERVAL_MS, run starts/ends sooner (URGENT_SAVE_INTERVAL_MS). A missing or unreadable
 * file means starting fresh (the host says so); the next save replaces it.
 *
 * The fingerprint is no secret (anyone can read /proc), so the runs in flight are trusted to name
 * processes to stop only when no one but the host's user could have written the file (`notPrivate`).
 */
import { statSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import type { FailureReason, LastResult } from '../core/machine.ts';
import { atomicWrite } from './config-store.ts';
import { errnoText } from './errors.ts';
import { NotRegularFileError, readRegularFileStat } from './files.ts';

export const STATE_FILE = 'buttpad.state.json';
export const STATE_VERSION = 1;
/** Routine changes (latched state, results) are saved at most this often (≤ 4/s)… */
export const SAVE_INTERVAL_MS = 250;
/** …a run starting or ending at most this often (the restart needs those most). */
export const URGENT_SAVE_INTERVAL_MS = 50;

export interface ButtonMemo {
  lastRunId: number;
  last?: LastResult;
  latched?: string;
}

export interface LiveEntry {
  key: string;
  runId: number;
  pid: number;
  pgid: number;
  /** Epoch ms. */
  startedAt: number;
  /** processFingerprint(pid) taken when it started. Without one, a leftover is never signalled. */
  fingerprint?: string;
  command?: string;
  cwd?: string;
  /** Stopped by a graceful shutdown (already dead, or SIGKILLed). */
  stopped?: 'shutdown';
  endedAt?: number;
}

export interface PersistedState {
  version: typeof STATE_VERSION;
  savedAt: number;
  /** The host that wrote it: a second host must not take over the runs of one still running. */
  host?: { pid: number; fingerprint?: string };
  buttons: Record<string, ButtonMemo>;
  live: LiveEntry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A button key as the host writes them: `pad/button`, both ids as the config allows them (src/core/config.ts). */
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && /^[\w-]+\/[\w-]+$/.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 1;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
const REASONS: readonly FailureReason[] = ['exit', 'timeout', 'spawn', 'cancelled', 'interrupted'];

function parseLast(v: unknown, clean: (s: string, max: number) => string): LastResult | undefined {
  if (!isRecord(v) || !isCount(v.runId) || typeof v.ok !== 'boolean' || !isTime(v.endedAt)) return undefined;
  const last: LastResult = { runId: v.runId, ok: v.ok, endedAt: v.endedAt };
  if (REASONS.includes(v.reason as FailureReason)) last.reason = v.reason as FailureReason;
  const text = typeof v.text === 'string' ? clean(v.text, 200) : '';
  if (text) last.text = text;
  return last;
}

function parseLive(v: unknown): LiveEntry | undefined {
  if (!isRecord(v) || !isKey(v.key)) return undefined;
  if (!isCount(v.runId) || !isPid(v.pid) || !isPid(v.pgid) || !isTime(v.startedAt)) return undefined;
  // The host only ever writes its runs' own process groups (detached: pgid = pid), and never itself:
  // anything else would let a hand-edited file aim a kill at some other group.
  if (v.pgid !== v.pid || v.pid === process.pid) return undefined;
  const e: LiveEntry = { key: v.key, runId: v.runId, pid: v.pid, pgid: v.pgid, startedAt: v.startedAt };
  const fp = str(v.fingerprint, 200);
  if (fp) e.fingerprint = fp;
  const command = str(v.command, 100_000);
  if (command !== undefined) e.command = command;
  const cwd = str(v.cwd, 10_000);
  if (cwd !== undefined) e.cwd = cwd;
  if (v.stopped === 'shutdown') e.stopped = 'shutdown';
  if (isTime(v.endedAt)) e.endedAt = v.endedAt;
  return e;
}

/**
 * Validates a state file's JSON; anything malformed inside is dropped rather than trusted (the file
 * may have been edited by hand). `clean` sanitizes display text (results, latched state). A string
 * says why the whole file is unusable.
 */
export function parseState(raw: unknown, clean: (s: string, max: number) => string): PersistedState | string {
  if (!isRecord(raw)) return 'not a JSON object';
  if (raw.version !== STATE_VERSION) return `unknown version ${JSON.stringify(raw.version ?? null)}`;
  const buttons: Record<string, ButtonMemo> = {};
  if (isRecord(raw.buttons))
    for (const [key, v] of Object.entries(raw.buttons)) {
      if (!isRecord(v) || !isKey(key) || !isCount(v.lastRunId)) continue;
      const memo: ButtonMemo = { lastRunId: v.lastRunId };
      const last = parseLast(v.last, clean);
      if (last) memo.last = last;
      const latched = typeof v.latched === 'string' ? clean(v.latched, 40) : '';
      if (latched) memo.latched = latched;
      buttons[key] = memo;
    }
  const live = Array.isArray(raw.live) ? raw.live.map(parseLive).filter((e): e is LiveEntry => !!e) : [];
  const state: PersistedState = { version: STATE_VERSION, savedAt: isTime(raw.savedAt) ? raw.savedAt : 0, buttons, live };
  if (isRecord(raw.host) && isPid(raw.host.pid)) state.host = { pid: raw.host.pid, fingerprint: str(raw.host.fingerprint, 200) };
  return state;
}

/** `notPrivate`: why someone else could have written the file (see notPrivate()); absent when no one could. */
export type LoadResult = { ok: true; state: PersistedState; notPrivate?: string } | { ok: false; missing: boolean; error: string };

/** A state file is a few KB; a bigger one isn't ours. */
const MAX_STATE_BYTES = 8 * 1024 * 1024;

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(4, '0');

/**
 * Why the state file at `path` could have been written by someone other than this host's user
 * (`st`: the stat of the open file that was read); undefined when it couldn't: owned by that user,
 * mode 0600 or stricter (`mode & 0o077` = 0), in a folder that isn't group- or world-writable (the
 * same posture as the secrets file). A file that fails this could aim the startup kill at any
 * process group of this user (its fingerprints are computable from /proc), so its runs in flight are
 * never signalled. Windows: no check (no fingerprint there, nothing is ever signalled).
 */
export function notPrivate(path: string, st: Stats, uid: number | undefined = process.geteuid?.()): string | undefined {
  if (process.platform === 'win32' || uid === undefined) return undefined;
  if (st.uid !== uid) return `it is owned by uid ${st.uid}, not by this host's user (uid ${uid})`;
  if (st.mode & 0o077) return `its mode is ${octal(st.mode)}, not 0600`;
  const dir = dirname(path);
  let d: Stats;
  try {
    d = statSync(dir);
  } catch (e) {
    return `its folder ${dir} can't be checked: ${errnoText(e)}`;
  }
  if (d.mode & 0o022) return `its folder ${dir} is group- or world-writable (mode ${octal(d.mode)})`;
  return undefined;
}

export function loadState(path: string, clean: (s: string, max: number) => string): LoadResult {
  let text: string;
  let stat: Stats;
  try {
    // Never blocks on a FIFO or device (files.ts checks before and after opening, non-blocking).
    const r = readRegularFileStat(path, MAX_STATE_BYTES);
    text = r.data.toString('utf8');
    stat = r.stat;
  } catch (e) {
    if (e instanceof NotRegularFileError) return { ok: false, missing: false, error: `not a regular file: it is ${e.kind}` };
    const err = e as NodeJS.ErrnoException;
    return { ok: false, missing: err.code === 'ENOENT', error: err.code === 'EFBIG' ? 'too big' : (err.code ?? err.message) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, missing: false, error: `invalid JSON (${(e as Error).message})` };
  }
  const r = parseState(raw, clean);
  if (typeof r === 'string') return { ok: false, missing: false, error: r };
  const why = notPrivate(path, stat);
  return why ? { ok: true, state: r, notPrivate: why } : { ok: true, state: r };
}

export interface StateFileOptions {
  log?: (msg: string) => void;
  /** Injection point for tests. Default: atomicWrite (config-store.ts), mode 0600. */
  write?: (path: string, text: string) => void;
  /** Monotonic ms. */
  clock?: () => number;
}

/** Saves snapshots of the host's run state to `path`, throttled. Never throws: failures are logged. */
export class StateFile {
  /** Snapshots written (tests). */
  writes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dueAt = Infinity;
  private lastWrite = -Infinity;
  private failing = false;
  private closed = false;
  private readonly write: (path: string, text: string) => void;
  private readonly clock: () => number;

  constructor(
    readonly path: string,
    private readonly snapshot: () => PersistedState,
    private readonly opts: StateFileOptions = {},
  ) {
    this.write = opts.write ?? ((p, t) => void atomicWrite(p, t, { mode: 0o600 }));
    this.clock = opts.clock ?? (() => performance.now());
  }

  /** Something changed: save soon; `urgent` (a run started or ended) sooner. */
  request(urgent = false) {
    if (this.closed) return;
    const now = this.clock();
    const due = Math.max(now, this.lastWrite + (urgent ? URGENT_SAVE_INTERVAL_MS : SAVE_INTERVAL_MS));
    if (this.timer && this.dueAt <= due) return;
    clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = setTimeout(() => this.flush(), due - now);
    this.timer.unref?.();
  }

  /** Save now, synchronously (shutdown, the process 'exit' handler). Whether it worked; a failure (WriteError) is logged, never thrown. */
  flush(): boolean {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dueAt = Infinity;
    this.lastWrite = this.clock();
    try {
      this.write(this.path, JSON.stringify(this.snapshot(), null, 1) + '\n');
      this.writes++;
      if (this.failing) this.opts.log?.(`state: saving ${this.path} works again`);
      this.failing = false;
      return true;
    } catch (e) {
      if (!this.failing)
        this.opts.log?.(`state: cannot save ${this.path} (${(e as Error).message}); run ids, results and running actions won't survive a restart until this is fixed`);
      this.failing = true;
      return false;
    }
  }

  /** No more timed saves (explicit `flush()` still works). */
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dueAt = Infinity;
  }
}
