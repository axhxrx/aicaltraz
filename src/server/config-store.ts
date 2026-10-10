/**
 * The config file is the source of truth. This store loads it, watches it for hand edits, and
 * writes UI saves back atomically in a compact form (button fields at their defaults omitted).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeSync,
  type FSWatcher,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Button, parseConfig, type Action, type Config } from '../core/config.ts';
import type { Role, WireConfig } from '../core/protocol.ts';

const isWindows = process.platform === 'win32';

/** sha256 (hex, first 16 chars) of the file's bytes. */
export const revOf = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

// Derived from the schema so compaction follows any change to the defaults.
const BUTTON_DEFAULTS: Record<string, unknown> = (() => {
  const { id: _id, x: _x, y: _y, action: _a, ...defaults } = Button.parse({ id: 'x', x: 0, y: 0, action: { type: 'shell', script: 'x' } });
  return defaults;
})();

function compactAction(a: Action): Record<string, unknown> {
  if (a.type === 'exec' && a.args.length === 0) {
    const { args: _args, ...rest } = a;
    return rest;
  }
  return a;
}

function compactButton(b: Button): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || (k in BUTTON_DEFAULTS && BUTTON_DEFAULTS[k] === v)) continue;
    out[k] = k === 'action' ? compactAction(v as Action) : v;
  }
  return out;
}

/** 2-space JSON with button defaults omitted, newline-terminated. */
export function serializeConfig(cfg: Config): string {
  const compact = { ...cfg, pads: cfg.pads.map((p) => ({ ...p, buttons: p.buttons.map(compactButton) })) };
  return JSON.stringify(compact, null, 2) + '\n';
}

/** What a press-role client may see: everything but `action`. */
export function redactConfig(cfg: Config): WireConfig {
  return { ...cfg, pads: cfg.pads.map((p) => ({ ...p, buttons: p.buttons.map(({ action: _action, ...b }) => b) })) };
}

export type ReadResult = { ok: true; config: Config; rev: string } | { ok: false; errors: string[]; rev?: string };

export function readConfigFile(path: string): ReadResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { ok: false, errors: [`(file): cannot read ${path}: ${err.code ?? err.message}`] };
  }
  const rev = revOf(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, rev, errors: [`(root): invalid JSON: ${(e as Error).message}`] };
  }
  const r = parseConfig(raw);
  return r.ok ? { ok: true, config: r.config, rev } : { ok: false, rev, errors: r.errors };
}

/** Rev of the file's bytes as they are now, valid config or not; undefined if it can't be read. */
function revOfFile(path: string): string | undefined {
  try {
    return revOf(readFileSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Write via a temp file in the same directory + rename. Keeps the existing file's mode; a new file gets
 * 0600, since a config holds commands and their env. `stillOk` gets a last say right before the
 * rename: false leaves the file alone (and returns false).
 */
export function atomicWrite(path: string, text: string, stillOk?: () => boolean): boolean {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {}
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', mode);
    try {
      if (!isWindows) fchmodSync(fd, mode); // exactly that mode, whatever the umask
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (stillOk && !stillOk()) {
      rmSync(tmp, { force: true });
      return false;
    }
    renameSync(tmp, path);
    return true;
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
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

export class ConfigLoadError extends Error {
  constructor(
    readonly path: string,
    readonly errors: string[],
  ) {
    super(`invalid config ${path}:\n  ${errors.join('\n  ')}`);
  }
}

/**
 * 409: the file isn't the one `baseRev` names. `rev` is the rev of its bytes now; `invalid` (with
 * the file's `errors`) when those bytes aren't a valid config (a hand edit with a typo, or caught
 * mid-write): the host still runs the previous config.
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

export class ConfigStore {
  /** Errors of the file on disk while it is broken (the last good config keeps running). */
  fileErrors: string[] | null = null;
  /** Rev of the file's bytes as last read, valid or not (`rev` is the last valid one); undefined: unreadable. */
  diskRev: string | undefined;
  private brokenRev: string | undefined;
  private listeners = new Set<ConfigListener>();
  private watching = false;
  private watchers = new Map<string, FSWatcher>();
  /** File names the watchers react to. */
  private watchNames = new Set<string>();
  private debounceMs = 200;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    /** The configured path, absolute. It may be a symlink: it's read and watched as such, saves replace its target. */
    readonly path: string,
    /** Directory of the file the path resolved to at startup; actions' relative paths resolve against it. */
    readonly dir: string,
    public config: Config,
    public rev: string,
  ) {
    this.diskRev = rev;
  }

  /**
   * Load `path`; if it doesn't exist and `starter` is given, write `starter(absPath)` there first.
   * Throws ConfigLoadError when the file is invalid.
   */
  static open(path: string, starter?: (absPath: string) => string): { store: ConfigStore; created: boolean } {
    const abs = resolve(path);
    let created = false;
    if (!existsSync(abs)) {
      if (!starter) throw new ConfigLoadError(abs, [`(file): not found`]);
      mkdirSync(dirname(abs), { recursive: true });
      atomicWrite(abs, starter(abs));
      created = true;
    }
    const r = readConfigFile(abs);
    if (!r.ok) throw new ConfigLoadError(abs, r.errors);
    return { store: new ConfigStore(abs, dirname(writeTarget(abs)), r.config, r.rev), created };
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
   * too. `force` skips that check (the user chose to replace whatever is there).
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
    const text = serializeConfig(config);
    const rev = revOf(text);
    const checked = this.diskRev;
    // A last look right before the rename: a write that landed since the check stays (409 instead).
    if (!atomicWrite(writeTarget(this.path), text, () => force || revOfFile(this.path) === checked)) {
      this.sync();
      return this.conflict();
    }
    this.diskRev = rev;
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
   * Watch for hand edits, debounced. Watches directories, which survives atomic renames by editors
   * and by us: the configured path's (even a symlink replaced by a file, as `sed -i` does) and, while
   * it's a symlink, its target's (edits of the target itself).
   */
  watch(debounceMs = 200) {
    if (this.watching) return;
    this.watching = true;
    this.debounceMs = debounceMs;
    this.rewatch();
  }

  private rewatch() {
    if (!this.watching) return;
    const files = [this.path, writeTarget(this.path)];
    const dirs = new Set(files.map((f) => dirname(f)));
    this.watchNames = new Set(files.map((f) => basename(f)));
    for (const [dir, w] of this.watchers)
      if (!dirs.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const w = watch(dir, { persistent: false }, (_event, file) => {
          if (file != null && !this.watchNames.has(String(file))) return;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.sync();
            this.rewatch(); // the link may point elsewhere now, or be a plain file
          }, this.debounceMs);
        });
        w.on('error', () => {});
        this.watchers.set(dir, w);
      } catch (e) {
        console.error(`buttpad: cannot watch ${dir} for config edits:`, (e as Error).message);
      }
    }
  }

  close() {
    clearTimeout(this.timer);
    this.watching = false;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
