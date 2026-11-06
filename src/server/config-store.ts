/**
 * The config file is the source of truth. This store loads it, watches it for hand edits, and
 * writes UI saves back safely (src/server/files.ts) in a compact form that stays close to what the
 * author wrote (see serializeConfig).
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Button, Config as ConfigSchema, ExecAction, Pad, parseConfig, ShellAction, type Action, type Config } from '../core/config.ts';
import type { Role, WireConfig } from '../core/protocol.ts';
import { describeJsonError, explainConfigErrors } from './config-errors.ts';
import { errCode, errnoText } from './errors.ts';
import { atomicWrite, NotRegularFileError, readRegularFile, WriteError } from './files.ts';

/** The one safe write, for every file the host writes (config, secrets, state): see files.ts. */
export { atomicWrite, WriteError, type AtomicWriteOptions } from './files.ts';

/** How often the watcher also stats the file, for changes fs.watch misses (see `watch`). */
export const POLL_MS = 2000;
/** A file that keeps changing is re-read at least this often. */
const MAX_DEBOUNCE_MS = 1000;

/** sha256 (hex, first 16 chars) of the file's bytes. */
export const revOf = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

// Derived from the schema so compaction follows any change to the defaults.
const BUTTON_DEFAULTS: Record<string, unknown> = (() => {
  const { id: _id, x: _x, y: _y, action: _a, ...defaults } = Button.parse({ id: 'x', x: 0, y: 0, action: { type: 'shell', script: 'x' } });
  return defaults;
})();
const SERVER_DEFAULTS: Record<string, unknown> = ConfigSchema.shape.server.parse(undefined);
/** Schema order of each object's keys: where a key the author's file doesn't have yet goes. */
const KEY_ORDER = {
  config: Object.keys(ConfigSchema.shape),
  server: Object.keys(SERVER_DEFAULTS),
  pad: Object.keys(Pad.shape),
  button: Object.keys(Button.shape),
  exec: Object.keys(ExecAction.shape),
  shell: Object.keys(ShellAction.shape),
  none: ['type'],
};
/** Arrays of strings/numbers, and objects of only those, go on one line when it stays this short (indent included). */
export const INLINE_WIDTH = 100;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const objects = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const isPrimitive = (v: unknown) => v === null || (typeof v !== 'object' && typeof v !== 'function');

/**
 * `keys` (schema order) arranged like the author's `template` keys. A key the template lacks goes
 * right after the last of them (in the author's order) that comes before it in schema order —
 * `timeoutMs` after `holdMs`, wherever the author put that — else before the first that comes after.
 */
function arrange(keys: string[], template: Obj | undefined, schema: string[]): string[] {
  const rank = (k: string) => (schema.includes(k) ? schema.indexOf(k) : schema.length);
  if (!template) return [...keys].sort((a, b) => rank(a) - rank(b));
  const out = Object.keys(template).filter((k) => keys.includes(k));
  for (const k of keys) {
    if (out.includes(k)) continue;
    const r = rank(k);
    const after = out.findLastIndex((o) => rank(o) < r);
    const before = out.findIndex((o) => rank(o) > r);
    out.splice(after >= 0 ? after + 1 : before >= 0 ? before : out.length, 0, k);
  }
  return out;
}

function ordered(obj: Obj, template: Obj | undefined, schema: string[]): Obj {
  const out: Obj = {};
  for (const k of arrange(Object.keys(obj), template, schema)) out[k] = obj[k];
  return out;
}

/**
 * A button without its fields at their defaults — except those the author wrote for this button
 * (`same`, its version in the file the save replaces): an explicit `"trigger": "hold"` stays.
 */
function compactButton(b: Button, same: Obj | undefined, template: Obj | undefined): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || (k in BUTTON_DEFAULTS && BUTTON_DEFAULTS[k] === v && !(same && k in same))) continue;
    out[k] = v;
  }
  const a: Action = b.action;
  const sameAction = isObj(same?.action) && same.action.type === a.type ? same.action : undefined;
  const action: Obj = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || (k === 'args' && Array.isArray(v) && v.length === 0 && !(sameAction && 'args' in sameAction))) continue;
    action[k] = v;
  }
  const templateAction = sameAction ?? (isObj(template?.action) && template.action.type === a.type ? template.action : undefined);
  out.action = ordered(action, templateAction, KEY_ORDER[a.type]);
  return ordered(out, template, KEY_ORDER.button);
}

/** `server` without fields at their defaults (unless the author wrote them); none at all when nothing is left. */
function compactServer(server: Config['server'], same: unknown): Obj | undefined {
  const own = isObj(same) ? same : undefined;
  const out: Obj = {};
  for (const [k, v] of Object.entries(server)) if (v !== SERVER_DEFAULTS[k] || (own && k in own)) out[k] = v;
  return Object.keys(out).length || own ? ordered(out, own, KEY_ORDER.server) : undefined;
}

/**
 * JSON, 2-space indented; an array of strings/numbers, or an object of only those (and such arrays),
 * on one line when that fits in INLINE_WIDTH — `"args": ["wash", "100", "10"]`,
 * `"action": { "type": "exec", "command": "./fade.sh" }`.
 */
export function formatJson(v: unknown, indent = 0, lead = 0): string {
  if (isPrimitive(v)) return JSON.stringify(v) ?? 'null';
  const inner = ' '.repeat(indent + 2);
  const fits = (s: string) => indent + lead + s.length <= INLINE_WIDTH && !s.includes('\n');
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(isPrimitive)) {
      const line = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (fits(line)) return line;
    }
    return `[\n${v.map((x) => inner + formatJson(x, indent + 2)).join(',\n')}\n${' '.repeat(indent)}]`;
  }
  const entries = Object.entries(v as Obj).filter(([, x]) => x !== undefined);
  if (!entries.length) return '{}';
  /** A value that sits on its parent's line: a string/number…, an array of those, `{}`. */
  const flat = (x: unknown) => isPrimitive(x) || (Array.isArray(x) && x.every(isPrimitive)) || (isObj(x) && !Object.keys(x).length);
  const oneLine = (x: unknown) => (Array.isArray(x) ? `[${x.map((y) => JSON.stringify(y)).join(', ')}]` : isObj(x) ? '{}' : JSON.stringify(x));
  if (entries.every(([, x]) => flat(x))) {
    const line = `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`).join(', ')} }`;
    if (fits(line)) return line;
  }
  return `{\n${entries
    .map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return inner + key + formatJson(x, indent + 2, key.length);
    })
    .join(',\n')}\n${' '.repeat(indent)}}`;
}

/**
 * The config as a file, newline-terminated: button fields at their defaults left out (and exec's
 * empty `args`, and `server` when it is the default), short arrays and objects on one line.
 * `original` (the file's JSON as the author last wrote it) keeps their key order — top level, pads,
 * buttons and actions, matched by id; new ones follow the file's first pad/button — and the fields
 * they wrote out even at a default. Values round-trip exactly: parseConfig(JSON.parse(result))
 * equals `cfg`.
 */
export function serializeConfig(cfg: Config, original?: unknown): string {
  const orig = isObj(original) ? original : undefined;
  const origPads = objects(orig?.pads);
  const everyButton = origPads.flatMap((p) => objects(p.buttons));
  const pads = cfg.pads.map((p) => {
    const samePad = origPads.find((o) => o.id === p.id);
    const padButtons = objects(samePad?.buttons);
    const buttons = p.buttons.map((b) => {
      const same = padButtons.find((o) => o.id === b.id);
      const template = same ?? everyButton.find((o) => o.id === b.id) ?? padButtons[0] ?? everyButton[0];
      return compactButton(b, same, template);
    });
    return ordered({ ...p, buttons }, samePad ?? origPads[0], KEY_ORDER.pad);
  });
  const top: Obj = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined) continue;
    if (k === 'server') {
      const server = compactServer(cfg.server, orig?.server);
      if (server) top.server = server;
    } else top[k] = k === 'pads' ? pads : v;
  }
  return formatJson(ordered(top, orig, KEY_ORDER.config)) + '\n';
}

/** What a press-role client may see: everything but `action`. */
export function redactConfig(cfg: Config): WireConfig {
  return { ...cfg, pads: cfg.pads.map((p) => ({ ...p, buttons: p.buttons.map(({ action: _action, ...b }) => b) })) };
}

/**
 * `errors` are worded for people (config-errors.ts): `pad "lights" › button "key": holdMs must be ≤ 5000
 * (line 42)`, `invalid JSON at line 3, column 7: …`. `rev` is missing when the file can't be read.
 * `raw` is the file's JSON as written (when it is JSON at all): what a save keeps the key order of.
 */
export type ReadResult = { ok: true; config: Config; rev: string; raw: unknown } | { ok: false; errors: string[]; rev?: string; raw?: unknown };

/** Why the file can't be read at all, in words. */
export function describeReadError(path: string, e: unknown): string {
  if (e instanceof NotRegularFileError)
    return `${path} is ${e.kind}, not a regular file${e.kind === 'a directory' ? ` (--config takes the file's path, e.g. ${join(path, 'buttpad.config.json')})` : ''}`;
  if (errCode(e) === 'EFBIG') return (e as Error).message;
  return `cannot read ${path}: ${errnoText(e)}`;
}

export function readConfigFile(path: string): ReadResult {
  let bytes: Buffer;
  try {
    bytes = readRegularFile(path);
  } catch (e) {
    return { ok: false, errors: [describeReadError(path, e)] };
  }
  const rev = revOf(bytes);
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, rev, errors: [describeJsonError(text, e)] };
  }
  const r = parseConfig(raw);
  return r.ok ? { ok: true, config: r.config, rev, raw } : { ok: false, rev, raw, errors: explainConfigErrors(raw, r.errors, text) };
}

/** Rev of the file's bytes as they are now, valid config or not; undefined if it can't be read (or isn't a regular file). */
function revOfFile(path: string): string | undefined {
  try {
    return revOf(readRegularFile(path));
  } catch {
    return undefined;
  }
}

/** Where a write to `path` goes: a symlink's target, so the link stays a link. */
function writeTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The directory actions' relative paths resolve against: the config file's, following the path's own
 * symlink (a config linked from a dotfiles checkout runs the scripts next to the real file) but not
 * symlinked directories above it, which resolve when an action starts (so a deploy-style
 * `current -> releases/42` swap takes effect).
 */
export function configDir(path: string): string {
  let p = path;
  for (let n = 0; n < 40; n++) {
    let target: string;
    try {
      if (!lstatSync(p).isSymbolicLink()) break;
      target = readlinkSync(p);
    } catch {
      break;
    }
    p = resolve(dirname(p), target);
  }
  return dirname(p);
}

export class ConfigLoadError extends Error {
  constructor(
    readonly path: string,
    readonly errors: string[],
    /** The file couldn't be read at all (missing, not a regular file, no permission). */
    readonly unreadable = false,
  ) {
    super(unreadable ? `can't use the config file: ${errors.join('; ')}` : `invalid config ${path}:\n  ${errors.join('\n  ')}`);
  }
}

/**
 * 409: the file isn't the one `baseRev` names. `rev` is the rev of its bytes now; `invalid` (with
 * the file's `errors`) when those bytes aren't a valid config (a hand edit with a typo, or caught
 * mid-write): the host still runs the previous config. 400 `errors` are parseConfig's (index paths:
 * the editor maps them onto its fields).
 */
export type SaveResult =
  | { ok: true; rev: string }
  | { ok: false; status: 400; errors: string[] }
  | { ok: false; status: 409; rev: string; invalid?: true; errors?: string[] };

export interface ConfigListener {
  /** A new config is active (hand edit or UI save). Also fires when a broken file is fixed. */
  change?(config: Config, rev: string, prev: Config): void;
  /** The file on disk changed but is invalid; the previous config stays active. */
  error?(errors: string[]): void;
}

/** Identity and content stamp of a path (followed), or why it can't be stat'ed. */
function stamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    return `!${errCode(e) ?? 'error'}`;
  }
}

/** A directory's identity (dev:ino, symlinks followed), or undefined if it isn't there. */
function dirId(dir: string): string | undefined {
  try {
    const st = statSync(dir);
    return st.isDirectory() ? `${st.dev}:${st.ino}` : undefined;
  } catch {
    return undefined;
  }
}

export class ConfigStore {
  /** Errors of the file on disk while it is broken (the last good config keeps running). */
  fileErrors: string[] | null = null;
  /** Rev of the file's bytes as last read, valid or not (`rev` is the last valid one); undefined: unreadable. */
  diskRev: string | undefined;
  private brokenRev: string | undefined;
  private listeners = new Set<ConfigListener>();
  private watching = false;
  /** By directory identity: a directory replaced under the same path gets a new watcher. */
  private watchers = new Map<string, FSWatcher>();
  /** File names the watchers react to. */
  private watchNames = new Set<string>();
  private unwatchable = new Set<string>();
  private debounceMs = 200;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingSince: number | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  /** What the poll saw last (see `signature`). */
  private seen = '';

  private constructor(
    /** The configured path, absolute. It may be a symlink: it's read and watched as such, saves replace its target. */
    readonly path: string,
    /** Where actions' relative paths resolve (see `configDir`). */
    readonly dir: string,
    public config: Config,
    public rev: string,
    /** The file's JSON as last read (or written): a save keeps its key order (serializeConfig). */
    private raw: unknown,
  ) {
    this.diskRev = rev;
  }

  /**
   * Load `path`; if it doesn't exist and `starter` is given, write `starter(absPath)` there first.
   * Throws ConfigLoadError when the file is invalid or unreadable, WriteError when the starter can't be written.
   */
  static open(path: string, starter?: (absPath: string) => string): { store: ConfigStore; created: boolean } {
    const abs = resolve(path);
    let created = false;
    if (stamp(abs) === '!ENOENT') {
      if (!starter) throw new ConfigLoadError(abs, [`${abs} not found`], true);
      try {
        mkdirSync(dirname(abs), { recursive: true });
      } catch (e) {
        throw new WriteError(abs, `could not write a starter config to ${abs}: can't create its folder: ${errnoText(e)}`, errCode(e), { cause: e });
      }
      try {
        atomicWrite(abs, starter(abs));
      } catch (e) {
        if (!(e instanceof WriteError)) throw e;
        throw new WriteError(abs, e.message.replace(`could not write ${abs}`, `could not write a starter config to ${abs}`), e.code, { cause: e });
      }
      created = true;
    }
    const r = readConfigFile(abs);
    if (!r.ok) throw new ConfigLoadError(abs, r.errors, r.rev === undefined);
    return { store: new ConfigStore(abs, configDir(abs), r.config, r.rev, r.raw), created };
  }

  subscribe(l: ConfigListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  wire(role: Role): WireConfig {
    return role === 'admin' ? this.config : redactConfig(this.config);
  }

  /** Re-read the file now. */
  sync(): 'unchanged' | 'changed' | 'error' {
    const r = readConfigFile(this.path);
    this.diskRev = r.rev;
    if (r.raw !== undefined) this.raw = r.raw;
    if (!r.ok) {
      const key = r.rev ?? r.errors.join('\n');
      if (key !== this.brokenRev) {
        this.brokenRev = key;
        this.fileErrors = r.errors;
        this.emit((l) => l.error?.(r.errors));
      }
      return 'error';
    }
    const recovered = this.fileErrors !== null;
    if (r.rev === this.rev && !recovered) return 'unchanged';
    this.activate(r.config, r.rev);
    return 'changed';
  }

  /**
   * A UI save: check `baseRev`, validate, write compactly. `baseRev` must name the file's bytes as
   * they are now, valid or not: a hand edit with a typo, or one caught mid-write, is someone's work
   * too. `force` skips that check (the user chose to replace whatever is there). A write that fails
   * throws WriteError, with the file left as it was.
   */
  save(input: unknown, baseRev: string, { force = false }: { force?: boolean } = {}): SaveResult {
    // Pick up a hand edit the watcher hasn't delivered yet, so baseRev is checked against the file.
    this.sync();
    if (!force && baseRev !== this.diskRev) return this.conflict();
    const r = parseConfig(input);
    if (!r.ok) return { ok: false, status: 400, errors: r.errors };
    let config = r.config;
    if (config.$schema === undefined && this.config.$schema !== undefined) {
      const { $schema: _none, ...rest } = config;
      config = { $schema: this.config.$schema, ...rest };
    }
    // Laid out like the file the author wrote (key order, short lines), not regenerated from scratch.
    const text = serializeConfig(config, this.raw);
    const rev = revOf(text);
    const checked = this.diskRev;
    // A last look right before the rename: a write that landed since the check stays (409 instead).
    if (!atomicWrite(writeTarget(this.path), text, { stillOk: () => force || revOfFile(this.path) === checked })) {
      this.sync();
      return this.conflict();
    }
    this.diskRev = rev;
    this.raw = JSON.parse(text);
    if (rev !== this.rev || this.fileErrors !== null) this.activate(config, rev);
    return { ok: true, rev };
  }

  private conflict(): SaveResult {
    if (this.fileErrors) return { ok: false, status: 409, rev: this.diskRev ?? this.rev, invalid: true, errors: this.fileErrors };
    return { ok: false, status: 409, rev: this.rev };
  }

  private activate(config: Config, rev: string) {
    const prev = this.config;
    this.config = config;
    this.rev = rev;
    this.fileErrors = null;
    this.brokenRev = undefined;
    this.emit((l) => l.change?.(config, rev, prev));
  }

  /** A failing listener must not take the store (or the watcher's timer) down with it. */
  private emit(fn: (l: ConfigListener) => void) {
    for (const l of this.listeners)
      try {
        fn(l);
      } catch (e) {
        console.error('buttpad: config listener failed:', e);
      }
  }

  /**
   * Watch for hand edits, debounced. fs.watch on the directories (which survives atomic renames by
   * editors and by us): the configured path's (even a symlink replaced by a file, as `sed -i` does)
   * and, while it's a symlink, its target's. Plus a stat of the file every `pollMs`, for what
   * fs.watch can't see: the directory moved away and recreated, a symlinked directory swapped
   * (deploy-style `ln -sfn`), a bind-mounted file edited from outside, network file systems. When a
   * watched directory is replaced, its watcher is re-armed.
   */
  watch(debounceMs = 200, pollMs = POLL_MS) {
    if (this.watching) return;
    this.watching = true;
    this.debounceMs = debounceMs;
    this.seen = this.signature();
    this.rewatch();
    this.poller = setInterval(() => {
      if (this.signature() !== this.seen) this.schedule();
    }, pollMs);
    this.poller.unref?.();
  }

  /** The file's identity and content stamp, and the identity of each directory it's watched through. */
  private signature(): string {
    const target = writeTarget(this.path);
    return [stamp(this.path), dirId(dirname(this.path)), target === this.path ? '' : dirId(dirname(target))].join('|');
  }

  private schedule() {
    const now = performance.now();
    this.pendingSince ??= now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.pendingSince + Math.max(MAX_DEBOUNCE_MS, this.debounceMs) - now));
    this.timer = setTimeout(() => {
      this.timer = this.pendingSince = undefined;
      if (!this.watching) return;
      // Taken before the read: a change after it is seen by the next poll.
      const sig = this.signature();
      this.sync();
      this.rewatch(); // the link may point elsewhere now, be a plain file, or its directory be a new one
      this.seen = sig;
    }, wait);
  }

  private rewatch() {
    if (!this.watching) return;
    const files = [this.path, writeTarget(this.path)];
    this.watchNames = new Set(files.map((f) => basename(f)));
    const want = new Map<string, string>();
    for (const f of files) {
      const id = dirId(dirname(f));
      if (id) want.set(id, dirname(f));
    }
    for (const [id, w] of this.watchers)
      if (!want.has(id)) {
        w.close();
        this.watchers.delete(id);
      }
    for (const [id, dir] of want) {
      if (this.watchers.has(id)) continue;
      try {
        const w = watch(dir, { persistent: false }, (_event, file) => {
          if (file != null && !this.watchNames.has(String(file))) return;
          this.schedule();
        });
        w.on('error', () => {
          // The directory went away: the poll notices and re-arms.
          w.close();
          if (this.watchers.get(id) === w) this.watchers.delete(id);
        });
        this.watchers.set(id, w);
        this.unwatchable.delete(id);
      } catch (e) {
        if (!this.unwatchable.has(id)) console.error(`buttpad: cannot watch ${dir} for config edits (checking every ${POLL_MS / 1000} s instead):`, (e as Error).message);
        this.unwatchable.add(id);
      }
    }
  }

  close() {
    clearTimeout(this.timer);
    clearInterval(this.poller);
    this.timer = this.poller = this.pendingSince = undefined;
    this.watching = false;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
