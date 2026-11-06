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
 *
 * The run log (GET /api/runs) survives too, in a sibling file (buttpad.runs.json, see RunsFile
 * below): the last HISTORY_SIZE finished runs per button, their output tails cut to
 * SAVED_TAIL_BYTES. Same posture: written 0600, read without blocking, everything in it checked
 * and capped (it is display data: nothing in it is ever run or signalled, and its run ids don't
 * seed the run id counter: the state file's `lastRunId` does).
 */
import { statSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FailureReason, LastResult } from '../core/machine.ts';
import type { RunRecord } from '../core/protocol.ts';
import { atomicWrite } from './config-store.ts';
import { errnoText } from './errors.ts';
import { NotRegularFileError, readRegularFileStat } from './files.ts';
import { LATCHED_MAX } from './runner.ts';

export const STATE_FILE = 'buttpad.state.json';
export const STATE_VERSION = 1;
/** Routine changes (latched state, results) are saved at most this often (≤ 4/s)… */
export const SAVE_INTERVAL_MS = 250;
/** …a run starting or ending at most this often (the restart needs those most). */
export const URGENT_SAVE_INTERVAL_MS = 50;
/**
 * Marks a latched device state (`@state`) the host can't vouch for: the run that set it was cut
 * off by a crash, so the device may be in any state now ("? BGM ●"). The next `@state` replaces it.
 */
export const UNCERTAIN_PREFIX = '? ';
/** A latched state as kept: `@state` text, possibly marked uncertain. */
export const LATCHED_KEPT_MAX = LATCHED_MAX + UNCERTAIN_PREFIX.length;

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
/**
 * Run ids go up by one per run of a button: 2^40 is millennia of presses. One above it is malformed
 * (dropped like any other bad value, not clamped: a clamp would bring it back down after every
 * restart, and the ids after it would repeat). Near MAX_SAFE_INTEGER, +1 stops changing anything
 * (2^53 + 1 = 2^53): a crafted file froze the ids there.
 */
export const MAX_RUN_ID = 2 ** 40;
const isRunId = (v: unknown): v is number => isCount(v) && v <= MAX_RUN_ID;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 1;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
const REASONS: readonly FailureReason[] = ['exit', 'timeout', 'spawn', 'cancelled', 'interrupted'];

function parseLast(v: unknown, clean: (s: string, max: number) => string): LastResult | undefined {
  if (!isRecord(v) || !isRunId(v.runId) || typeof v.ok !== 'boolean' || !isTime(v.endedAt)) return undefined;
  const last: LastResult = { runId: v.runId, ok: v.ok, endedAt: v.endedAt };
  if (REASONS.includes(v.reason as FailureReason)) last.reason = v.reason as FailureReason;
  const text = typeof v.text === 'string' ? clean(v.text, 200) : '';
  if (text) last.text = text;
  return last;
}

function parseLive(v: unknown): LiveEntry | undefined {
  if (!isRecord(v) || !isKey(v.key)) return undefined;
  if (!isRunId(v.runId) || !isPid(v.pid) || !isPid(v.pgid) || !isTime(v.startedAt)) return undefined;
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
      if (!isRecord(v) || !isKey(key) || !isRunId(v.lastRunId)) continue;
      const memo: ButtonMemo = { lastRunId: v.lastRunId };
      const last = parseLast(v.last, clean);
      if (last) memo.last = last;
      // The run READY's `last` names is one the ids have passed.
      if (last && last.runId > memo.lastRunId) memo.lastRunId = last.runId;
      const latched = typeof v.latched === 'string' ? clean(v.latched, LATCHED_KEPT_MAX) : '';
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

/**
 * A file of ours, as JSON: read without blocking on a FIFO or device, at most `maxBytes`, with
 * whether someone else could have written it (`notPrivate`). A string says why it can't be used.
 */
function readOwnJson(path: string, maxBytes: number): { ok: true; raw: unknown; notPrivate?: string } | { ok: false; missing: boolean; error: string } {
  let text: string;
  let stat: Stats;
  try {
    // Never blocks on a FIFO or device (files.ts checks before and after opening, non-blocking).
    const r = readRegularFileStat(path, maxBytes);
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
  const why = notPrivate(path, stat);
  return why ? { ok: true, raw, notPrivate: why } : { ok: true, raw };
}

export function loadState(path: string, clean: (s: string, max: number) => string): LoadResult {
  const f = readOwnJson(path, MAX_STATE_BYTES);
  if (!f.ok) return f;
  const r = parseState(f.raw, clean);
  if (typeof r === 'string') return { ok: false, missing: false, error: r };
  return f.notPrivate ? { ok: true, state: r, notPrivate: f.notPrivate } : { ok: true, state: r };
}

// ---------------------------------------------------------------------------------------------
// The run log across restarts.

export const RUNS_VERSION = 1;
/** Per stream, what a saved run keeps of its output: the last 2 KB. */
export const SAVED_TAIL_BYTES = 2048;
/** What a saved run keeps of its `command` and `cwd` (the start: a long script is cut). */
export const SAVED_COMMAND_MAX = 4096;
/** The whole file at most: past it, the oldest runs (over all buttons) are left out. */
export const RUNS_FILE_MAX = 2 * 1024 * 1024;
/** The run log is saved at most this often (a run ending, a config change dropping runs). */
export const RUNS_SAVE_INTERVAL_MS = 1000;
/** Runs per button the run log keeps (in memory, and in the file). */
export const HISTORY_SIZE = 20;

export interface PersistedRuns {
  version: typeof RUNS_VERSION;
  savedAt: number;
  /** Per button key, newest first. */
  runs: Record<string, RunRecord[]>;
}

/** Where the run log goes: next to the state file, `buttpad.state.json` → `buttpad.runs.json`. */
export function runsPathFor(statePath: string): string {
  const name = basename(statePath);
  const stem = name.endsWith('.state.json') ? name.slice(0, -'.state.json'.length) : name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
  return join(dirname(statePath), `${stem}.runs.json`);
}

/** The end of `s`, at most `maxBytes` of UTF-8 (whole characters), marked with a leading "…" when cut. */
export function tailBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let start = buf.length - (maxBytes - 3); // room for the "…" (3 bytes)
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return '…' + buf.subarray(start).toString('utf8');
}

/** The start of `s`, at most `max` characters, marked with a trailing "…" when cut. */
const headChars = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1) + '…');

/** A run as the file keeps it: output tails cut to SAVED_TAIL_BYTES, `command`/`cwd` to SAVED_COMMAND_MAX. */
export function savedRecord(r: RunRecord): RunRecord {
  const out: RunRecord = { ...r, stdout: tailBytes(r.stdout, SAVED_TAIL_BYTES), stderr: tailBytes(r.stderr, SAVED_TAIL_BYTES) };
  if (r.command !== undefined) out.command = headChars(r.command, SAVED_COMMAND_MAX);
  if (r.cwd !== undefined) out.cwd = headChars(r.cwd, SAVED_COMMAND_MAX);
  return out;
}

function parseRecord(v: unknown, key: string, clean: (s: string, max: number) => string): RunRecord | undefined {
  if (!isRecord(v) || !isRunId(v.runId) || !isTime(v.startedAt) || !isTime(v.endedAt)) return undefined;
  const [pad = '', button = ''] = key.split('/');
  // Only finished runs are saved; a record names its own button.
  if (v.pad !== pad || v.button !== button) return undefined;
  const text = (x: unknown) => (typeof x === 'string' ? x : '');
  const r: RunRecord = {
    runId: v.runId,
    pad,
    button,
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    stdout: tailBytes(text(v.stdout), SAVED_TAIL_BYTES),
    stderr: tailBytes(text(v.stderr), SAVED_TAIL_BYTES),
  };
  if (v.exitCode === null || Number.isSafeInteger(v.exitCode)) r.exitCode = v.exitCode as number | null;
  if (REASONS.includes(v.reason as FailureReason)) r.reason = v.reason as FailureReason;
  // Display text, like the host writes it (sanitized); the paths are shown as they are.
  if (typeof v.error === 'string') r.error = clean(v.error, 2000);
  if (typeof v.command === 'string') r.command = headChars(v.command, SAVED_COMMAND_MAX);
  if (typeof v.cwd === 'string') r.cwd = headChars(v.cwd, SAVED_COMMAND_MAX);
  return r;
}

/** Validates a run log file's JSON like parseState: what's malformed inside is dropped. A string says why the whole file is unusable. */
export function parseRuns(raw: unknown, clean: (s: string, max: number) => string): PersistedRuns | string {
  if (!isRecord(raw)) return 'not a JSON object';
  if (raw.version !== RUNS_VERSION) return `unknown version ${JSON.stringify(raw.version ?? null)}`;
  const runs: Record<string, RunRecord[]> = {};
  if (isRecord(raw.runs))
    for (const [key, list] of Object.entries(raw.runs)) {
      if (!isKey(key) || !Array.isArray(list)) continue;
      const seen = new Set<number>();
      const records = list
        .map((v) => parseRecord(v, key, clean))
        .filter((r): r is RunRecord => !!r && !seen.has(r.runId) && !!seen.add(r.runId))
        .sort((a, b) => b.startedAt - a.startedAt || b.runId - a.runId)
        .slice(0, HISTORY_SIZE);
      if (records.length) runs[key] = records;
    }
  return { version: RUNS_VERSION, savedAt: isTime(raw.savedAt) ? raw.savedAt : 0, runs };
}

export type RunsLoadResult = { ok: true; runs: PersistedRuns; notPrivate?: string } | { ok: false; missing: boolean; error: string };

export function loadRuns(path: string, clean: (s: string, max: number) => string): RunsLoadResult {
  // A file the host wrote is at most RUNS_FILE_MAX; a much bigger one isn't ours.
  const f = readOwnJson(path, 2 * RUNS_FILE_MAX);
  if (!f.ok) return f;
  const r = parseRuns(f.raw, clean);
  if (typeof r === 'string') return { ok: false, missing: false, error: r };
  return f.notPrivate ? { ok: true, runs: r, notPrivate: f.notPrivate } : { ok: true, runs: r };
}

/**
 * The run log file's text: per button (in `history` order) its finished runs, newest first, cut by
 * savedRecord; at most RUNS_FILE_MAX bytes in all — past that, the oldest runs over all buttons are
 * left out (the in-memory log keeps them).
 */
export function runsFileText(history: Iterable<[string, readonly RunRecord[]]>, savedAt: number, maxBytes = RUNS_FILE_MAX): string {
  const all: { key: string; json: string; endedAt: number; startedAt: number }[] = [];
  for (const [key, list] of history)
    for (const r of list) if (r.endedAt !== undefined) all.push({ key, json: JSON.stringify(savedRecord(r)), endedAt: r.endedAt, startedAt: r.startedAt });
  const head = `{"version":${RUNS_VERSION},"savedAt":${savedAt},"runs":{`;
  let size = Buffer.byteLength(head) + 3;
  const kept = new Set<(typeof all)[number]>();
  for (const x of [...all].sort((a, b) => b.endedAt - a.endedAt || b.startedAt - a.startedAt)) {
    const add = Buffer.byteLength(x.json) + Buffer.byteLength(JSON.stringify(x.key)) + 4;
    if (size + add > maxBytes) break;
    size += add;
    kept.add(x);
  }
  const byKey = new Map<string, string[]>();
  for (const x of all) if (kept.has(x)) byKey.set(x.key, [...(byKey.get(x.key) ?? []), x.json]);
  return `${head}${[...byKey].map(([key, list]) => `\n${JSON.stringify(key)}:[\n${list.join(',\n')}]`).join(',')}\n}}\n`;
}

export interface StateFileOptions {
  log?: (msg: string) => void;
  /** Injection point for tests. Default: atomicWrite (config-store.ts), mode 0600. */
  write?: (path: string, text: string) => void;
  /** Monotonic ms. */
  clock?: () => number;
  /** Saves at most this often (default SAVE_INTERVAL_MS)… */
  intervalMs?: number;
  /** …urgent ones at most this often (default URGENT_SAVE_INTERVAL_MS). */
  urgentIntervalMs?: number;
  /** For the log: what the file is ("state") and what is at stake while saving fails. */
  name?: string;
  stake?: string;
}

/** Saves snapshots (`text()`) of the host's run state to `path`, throttled. Never throws: failures are logged. */
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
  private readonly text: () => string;

  constructor(
    readonly path: string,
    /** The state as an object (written as JSON), or the file's text as is. */
    snapshot: () => PersistedState | string,
    private readonly opts: StateFileOptions = {},
  ) {
    this.write = opts.write ?? ((p, t) => void atomicWrite(p, t, { mode: 0o600 }));
    this.clock = opts.clock ?? (() => performance.now());
    this.text = () => {
      const s = snapshot();
      return typeof s === 'string' ? s : JSON.stringify(s, null, 1) + '\n';
    };
  }

  /** Something changed: save soon; `urgent` (a run started or ended) sooner. */
  request(urgent = false) {
    if (this.closed) return;
    const now = this.clock();
    const due = Math.max(now, this.lastWrite + (urgent ? (this.opts.urgentIntervalMs ?? URGENT_SAVE_INTERVAL_MS) : (this.opts.intervalMs ?? SAVE_INTERVAL_MS)));
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
    const name = this.opts.name ?? 'state';
    try {
      this.write(this.path, this.text());
      this.writes++;
      if (this.failing) this.opts.log?.(`${name}: saving ${this.path} works again`);
      this.failing = false;
      return true;
    } catch (e) {
      if (!this.failing)
        this.opts.log?.(
          `${name}: cannot save ${this.path} (${(e as Error).message}); ${this.opts.stake ?? "run ids, results and running actions won't survive a restart"} until this is fixed`,
        );
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
