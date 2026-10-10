/**
 * The config file is the source of truth. This store loads it, watches it for hand edits, and
 * writes UI saves back atomically in a compact form (button fields at their defaults omitted).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
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

/** Write via a temp file in the same directory + rename, keeping the existing file's mode. */
export function atomicWrite(path: string, text: string) {
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {}
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', mode);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
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

export type SaveResult = { ok: true; rev: string } | { ok: false; status: 400; errors: string[] } | { ok: false; status: 409; rev: string };

export interface ConfigListener {
  /** A new config is active (hand edit or UI save). Also fires when a broken file is fixed. */
  change?(config: Config, rev: string, prev: Config): void;
  /** The file on disk changed but is invalid; the previous config stays active. */
  error?(errors: string[]): void;
}

export class ConfigStore {
  readonly dir: string;
  /** Errors of the file on disk while it is broken (the last good config keeps running). */
  fileErrors: string[] | null = null;
  private brokenRev: string | undefined;
  private listeners = new Set<ConfigListener>();
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    readonly path: string,
    public config: Config,
    public rev: string,
  ) {
    this.dir = dirname(path);
  }

  /**
   * Load `path`; if it doesn't exist and `starter` is given, write `starter(absPath)` there first.
   * Throws ConfigLoadError when the file is invalid.
   */
  static open(path: string, starter?: (absPath: string) => string): { store: ConfigStore; created: boolean } {
    let abs = resolve(path);
    let created = false;
    if (!existsSync(abs)) {
      if (!starter) throw new ConfigLoadError(abs, [`(file): not found`]);
      mkdirSync(dirname(abs), { recursive: true });
      atomicWrite(abs, starter(abs));
      created = true;
    }
    // Follow symlinks so saves replace the target, not the link.
    abs = realpathSync(abs);
    const r = readConfigFile(abs);
    if (!r.ok) throw new ConfigLoadError(abs, r.errors);
    return { store: new ConfigStore(abs, r.config, r.rev), created };
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

  /** A UI save: validate, check `baseRev`, write compactly. */
  save(input: unknown, baseRev: string): SaveResult {
    // Pick up a hand edit the watcher hasn't delivered yet, so baseRev is checked against the file.
    this.sync();
    if (baseRev !== this.rev) return { ok: false, status: 409, rev: this.rev };
    const r = parseConfig(input);
    if (!r.ok) return { ok: false, status: 400, errors: r.errors };
    let config = r.config;
    if (config.$schema === undefined && this.config.$schema !== undefined) {
      const { $schema: _none, ...rest } = config;
      config = { $schema: this.config.$schema, ...rest };
    }
    const text = serializeConfig(config);
    const rev = revOf(text);
    atomicWrite(this.path, text);
    if (rev !== this.rev || this.fileErrors !== null) this.activate(config, rev);
    return { ok: true, rev };
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

  /** Watch the directory (survives atomic renames by editors and by us), debounced. */
  watch(debounceMs = 200) {
    if (this.watcher) return;
    const name = basename(this.path);
    this.watcher = watch(this.dir, { persistent: false }, (_event, file) => {
      if (file != null && String(file) !== name) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.sync(), debounceMs);
    });
    this.watcher.on('error', () => {});
  }

  close() {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
