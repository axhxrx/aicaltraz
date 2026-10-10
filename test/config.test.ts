import { afterAll, describe, expect, test } from 'bun:test';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { Button, Config, findButton, parseConfig, type ConfigInput } from '../src/core/config.ts';
import { atomicWrite, ConfigLoadError, ConfigStore, redactConfig, revOf, serializeConfig } from '../src/server/config-store.ts';
import { starterConfig, starterConfigText } from '../src/server/starter.ts';
import { cleanupTmp, padConfig, tmpDir, waitFor, writeJson } from './helpers.ts';

afterAll(cleanupTmp);

const root = resolve(import.meta.dir, '..');
const shell = (script: string) => ({ type: 'shell' as const, script });
const btn = (id: string, x: number, y: number, extra: object = {}) => ({ id, x, y, action: shell('true'), ...extra });
const errorsOf = (cfg: unknown) => {
  const r = parseConfig(cfg);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
};

describe('schema validation', () => {
  test('minimal config gets every default', () => {
    const r = parseConfig({ version: 1, pads: [{ id: 'p', name: 'P', buttons: [btn('b', 0, 0)] }] });
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.config.server).toEqual({ host: '0.0.0.0', port: 8787 });
    expect(r.config.pads[0]).toMatchObject({ cols: 2, rows: 2 });
    expect(r.config.pads[0]!.buttons[0]).toEqual({
      id: 'b',
      label: '',
      color: '#2f6fde',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      trigger: 'hold',
      holdMs: 500,
      driftPx: 60,
      whileRunning: 'ignore',
      confirm: false,
      confirmWindowMs: 3000,
      timeoutMs: 30000,
      resultHoldMs: 2500,
      action: { type: 'shell', script: 'true' },
    });
    expect(parseConfig({ version: 1, pads: [{ id: 'p', name: 'P' }] })).toMatchObject({ ok: true, config: { pads: [{ buttons: [] }] } });
    const exec = Button.parse({ id: 'e', x: 0, y: 0, action: { type: 'exec', command: 'ls' } });
    expect(exec.action).toEqual({ type: 'exec', command: 'ls', args: [] });
  });

  test('requires version 1 and at least one pad', () => {
    expect(errorsOf({ version: 2, pads: [{ id: 'p', name: 'P' }] })[0]).toStartWith('version:');
    expect(errorsOf({ version: 1, pads: [] })[0]).toStartWith('pads:');
    expect(errorsOf({ pads: [{ id: 'p', name: 'P' }] })[0]).toStartWith('version:');
    expect(errorsOf(null)[0]).toStartWith('(root):');
  });

  test('duplicate pad ids', () => {
    const errs = errorsOf({ version: 1, pads: [{ id: 'p', name: 'A' }, { id: 'p', name: 'B' }] });
    expect(errs).toEqual(['pads.1.id: duplicate pad id "p"']);
  });

  test('duplicate button ids within a pad (but fine across pads)', () => {
    expect(errorsOf(padConfig([btn('a', 0, 0), btn('a', 1, 0)]))).toEqual(['pads.0.buttons.1.id: duplicate button id "a"']);
    const ok = parseConfig({ version: 1, pads: [{ id: 'p', name: 'P', buttons: [btn('a', 0, 0)] }, { id: 'q', name: 'Q', buttons: [btn('a', 0, 0)] }] });
    expect(ok.ok).toBe(true);
  });

  test('buttons must stay inside the grid', () => {
    expect(errorsOf(padConfig([btn('a', 3, 0, { w: 2 })]))).toEqual(['pads.0.buttons.0: button "a" extends outside the 4x4 grid']);
    expect(errorsOf(padConfig([btn('a', 0, 4)]))[0]).toContain('extends outside');
    expect(errorsOf(padConfig([btn('a', 0, 2, { h: 3 })]))[0]).toContain('extends outside');
    expect(parseConfig(padConfig([btn('a', 0, 0, { w: 4, h: 4 })])).ok).toBe(true);
  });

  test('buttons must not overlap', () => {
    const errs = errorsOf(padConfig([btn('big', 0, 0, { w: 2, h: 2 }), btn('small', 1, 1)]));
    expect(errs).toEqual(['pads.0.buttons.1: button "small" overlaps "big" at cell 1,1']);
    expect(parseConfig(padConfig([btn('big', 0, 0, { w: 2, h: 2 }), btn('right', 2, 0, { h: 2 }), btn('below', 0, 2, { w: 4 })])).ok).toBe(true);
  });

  test('numeric bounds', () => {
    const bad: [string, object][] = [
      ['holdMs', { holdMs: 99 }],
      ['holdMs', { holdMs: 5001 }],
      ['timeoutMs', { timeoutMs: 50 }],
      ['confirmWindowMs', { confirmWindowMs: 100 }],
      ['resultHoldMs', { resultHoldMs: -1 }],
      ['driftPx', { driftPx: -1 }],
      ['w', { w: 0 }],
      ['x', { x: 1.5 }],
      ['holdMs', { holdMs: 250.5 }],
    ];
    for (const [field, extra] of bad) expect(errorsOf(padConfig([btn('a', 0, 0, extra)]))[0]).toStartWith(`pads.0.buttons.0.${field}:`);
    expect(errorsOf(padConfig([], { cols: 13 }))[0]).toStartWith('pads.0.cols:');
    expect(errorsOf(padConfig([], { rows: 0 }))[0]).toStartWith('pads.0.rows:');
    expect(errorsOf({ ...padConfig([]), server: { port: 70000 } })[0]).toStartWith('server.port:');
    expect(parseConfig(padConfig([btn('a', 0, 0, { holdMs: 100, timeoutMs: 100, confirmWindowMs: 500, resultHoldMs: 0, driftPx: 0 })])).ok).toBe(true);
  });

  test('ids, enums, unknown keys and actions', () => {
    expect(errorsOf(padConfig([btn('has space', 0, 0)]))[0]).toBe('pads.0.buttons.0.id: letters, digits, _ and - only');
    expect(errorsOf(padConfig([], { id: 'a/b' }))[0]).toStartWith('pads.0.id:');
    expect(errorsOf(padConfig([btn('a', 0, 0, { trigger: 'longpress' })]))[0]).toStartWith('pads.0.buttons.0.trigger:');
    expect(errorsOf(padConfig([btn('a', 0, 0, { whileRunning: 'restart' })]))[0]).toStartWith('pads.0.buttons.0.whileRunning:');
    expect(errorsOf(padConfig([btn('a', 0, 0, { colour: 'red' })]))[0]).toStartWith('pads.0.buttons.0:');
    expect(errorsOf(padConfig([btn('a', 0, 0, { action: { type: 'exec' } })]))[0]).toStartWith('pads.0.buttons.0.action.command:');
    expect(errorsOf(padConfig([btn('a', 0, 0, { action: { type: 'shell', script: '' } })]))[0]).toStartWith('pads.0.buttons.0.action.script:');
    expect(errorsOf(padConfig([btn('a', 0, 0, { action: { type: 'python', code: 'x' } })]))[0]).toStartWith('pads.0.buttons.0.action.type:');
    expect(errorsOf(padConfig([btn('a', 0, 0, { action: { type: 'exec', command: 'x', script: 'y' } })]))[0]).toStartWith('pads.0.buttons.0.action:');
    expect(errorsOf(padConfig([btn('a', 0, 0, { action: { type: 'exec', command: 'x', env: { A: 1 } } })]))[0]).toStartWith('pads.0.buttons.0.action.env.A:');
    expect(errorsOf({ ...padConfig([]), extra: true })[0]).toStartWith('(root):');
  });

  test('env variable names: letters, digits and _, not starting with a digit (no spaces, "=" or empty)', () => {
    const withEnv = (env: Record<string, string>) => padConfig([btn('a', 0, 0, { action: { type: 'exec', command: 'x', env } })]);
    for (const name of ['FOO ', ' FOO', 'A B', 'A=B', '', '1ABC', 'A-B', 'Ä'])
      expect(errorsOf(withEnv({ [name]: 'v' }))).toEqual([`pads.0.buttons.0.action.env.${name}: letters, digits and _ only, not starting with a digit`]);
    expect(parseConfig(withEnv({ FOO: '', _x: '1', LC_ALL: 'C', a1: 'b' })).ok).toBe(true);
    // Shell actions too.
    expect(errorsOf(padConfig([btn('a', 0, 0, { action: { type: 'shell', script: 'true', env: { 'BAD NAME': 'x' } } })]))[0]).toStartWith('pads.0.buttons.0.action.env.BAD NAME:');
  });

  test('reports every error at once', () => {
    expect(errorsOf(padConfig([btn('a', 0, 0), btn('a', 0, 0), btn('c', 9, 9)])).length).toBe(3);
  });

  test('findButton', () => {
    const cfg = Config.parse(padConfig([btn('a', 0, 0)]));
    expect(findButton(cfg, 'p', 'a')?.id).toBe('a');
    expect(findButton(cfg, 'p', 'zz')).toBeUndefined();
    expect(findButton(cfg, 'zz', 'a')).toBeUndefined();
  });
});

describe('serializeConfig / redactConfig / revOf', () => {
  const full: ConfigInput = {
    $schema: './s.json',
    version: 1,
    pads: [
      {
        id: 'p',
        name: 'P',
        cols: 3,
        rows: 2,
        buttons: [
          { id: 'a', x: 0, y: 0, action: { type: 'exec', command: 'ls', args: [] } },
          { id: 'b', label: 'B', x: 1, y: 0, w: 2, holdMs: 900, trigger: 'tap', key: 'b', action: { type: 'exec', command: 'echo', args: ['x'], env: { A: '1' } } },
          { id: 'c', x: 0, y: 1, color: '#2f6fde', timeoutMs: 30000, confirm: true, action: { type: 'shell', script: 'true', shell: '/bin/sh', cwd: 'sub' } },
        ],
      },
    ],
  };
  const cfg = Config.parse(full);

  test('omits button fields at their defaults and empty exec args', () => {
    const out = JSON.parse(serializeConfig(cfg));
    expect(out.pads[0].buttons).toEqual([
      { id: 'a', x: 0, y: 0, action: { type: 'exec', command: 'ls' } },
      { id: 'b', label: 'B', x: 1, y: 0, w: 2, trigger: 'tap', holdMs: 900, key: 'b', action: { type: 'exec', command: 'echo', args: ['x'], env: { A: '1' } } },
      { id: 'c', x: 0, y: 1, confirm: true, action: { type: 'shell', script: 'true', shell: '/bin/sh', cwd: 'sub' } },
    ]);
    expect(Object.keys(out)).toEqual(['$schema', 'version', 'server', 'pads']);
    expect(out.pads[0]).toMatchObject({ cols: 3, rows: 2 });
  });

  test('is 2-space JSON with a trailing newline, and round-trips', () => {
    const text = serializeConfig(cfg);
    expect(text).toEndWith('}\n');
    expect(text).toContain('\n  "version": 1,');
    expect(Config.parse(JSON.parse(text))).toEqual(cfg);
    expect(serializeConfig(Config.parse(JSON.parse(text)))).toBe(text);
  });

  test('redactConfig strips every action and nothing else, without mutating', () => {
    const wire = redactConfig(cfg);
    for (const b of wire.pads[0]!.buttons) expect(b).not.toHaveProperty('action');
    expect(wire.pads[0]!.buttons[1]).toMatchObject({ id: 'b', label: 'B', key: 'b', holdMs: 900 });
    expect(JSON.stringify(wire)).not.toContain('echo');
    expect(cfg.pads[0]!.buttons[1]!.action).toBeDefined();
  });

  test('revOf is the first 16 hex chars of sha256', () => {
    expect(revOf('hello')).toBe('2cf24dba5fb0a30e');
    expect(revOf(new TextEncoder().encode('hello'))).toBe('2cf24dba5fb0a30e');
  });
});

describe('ConfigStore', () => {
  const valid = padConfig([btn('a', 0, 0)]);

  test('writes the starter config when the file is missing (creating directories)', () => {
    const path = join(tmpDir(), 'deep', 'dir', 'buttpad.config.json');
    const { store, created } = ConfigStore.open(path, starterConfigText);
    expect(created).toBe(true);
    expect(store.path).toBe(path);
    expect(store.rev).toBe(revOf(readFileSync(path)));
    expect(store.config.pads[0]!.buttons.length).toBeGreaterThan(3);
    const again = ConfigStore.open(path, starterConfigText);
    expect(again.created).toBe(false);
    expect(again.store.rev).toBe(store.rev);
  });

  test('refuses a missing file without a starter, and invalid files', () => {
    const dir = tmpDir();
    expect(() => ConfigStore.open(join(dir, 'nope.json'))).toThrow(ConfigLoadError);
    writeFileSync(join(dir, 'bad.json'), '{"version": 1, "pads": [}');
    try {
      ConfigStore.open(join(dir, 'bad.json'));
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigLoadError);
      expect((e as ConfigLoadError).errors[0]).toStartWith('(root): invalid JSON');
    }
    writeJson(join(dir, 'overlap.json'), padConfig([btn('a', 0, 0), btn('b', 0, 0)]));
    expect(() => ConfigStore.open(join(dir, 'overlap.json'))).toThrow(/overlaps/);
  });

  test('accepts a UTF-8 BOM', () => {
    const path = join(tmpDir(), 'c.json');
    writeFileSync(path, '﻿' + JSON.stringify(valid));
    expect(ConfigStore.open(path).store.config.pads[0]!.id).toBe('p');
  });

  test('save: 409 on stale baseRev, 400 on invalid config, otherwise an atomic compact write', () => {
    const dir = tmpDir();
    const path = join(dir, 'c.json');
    writeJson(path, { $schema: 'x.json', ...valid });
    const { store } = ConfigStore.open(path);
    const changes: string[] = [];
    store.subscribe({ change: (_c, rev) => changes.push(rev) });

    expect(store.save(valid, 'stale')).toEqual({ ok: false, status: 409, rev: store.rev });
    const bad = store.save(padConfig([btn('a', 0, 0), btn('b', 0, 0)]), store.rev);
    expect(bad).toMatchObject({ ok: false, status: 400 });
    expect((bad as { errors: string[] }).errors[0]).toContain('overlaps');

    const next = padConfig([btn('a', 0, 0), btn('b', 1, 0, { label: 'B' })]);
    const r = store.save(next, store.rev);
    if (!r.ok) throw new Error('save failed');
    const text = readFileSync(path, 'utf8');
    expect(r.rev).toBe(revOf(text));
    expect(store.rev).toBe(r.rev);
    expect(changes).toEqual([r.rev]);
    expect(text).toBe(serializeConfig(store.config));
    expect(JSON.parse(text).$schema).toBe('x.json'); // kept from the file when the body has none
    expect(JSON.parse(text).pads[0].buttons[1]).toEqual({ id: 'b', label: 'B', x: 1, y: 0, action: { type: 'shell', script: 'true' } });
    expect(readdirSync(dir)).toEqual(['c.json']); // no temp files left behind

    // Saving identical content is a no-op with the same rev.
    expect(store.save(next, r.rev)).toEqual({ ok: true, rev: r.rev });
    expect(changes.length).toBe(1);
  });

  test('save keeps the file mode and replaces a symlink target, not the link', () => {
    const dir = tmpDir();
    const real = join(dir, 'real.json');
    writeJson(real, valid);
    chmodSync(real, 0o640);
    const link = join(dir, 'link.json');
    symlinkSync(real, link);
    const { store } = ConfigStore.open(link);
    expect(store.path).toBe(link);
    expect(store.dir).toBe(dir);
    expect(store.save(padConfig([btn('z', 0, 0)]), store.rev).ok).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(link, 'utf8')).pads[0].buttons[0].id).toBe('z');
    expect(statSync(real).mode & 0o777).toBe(0o640);
  });

  test('a new config file is 0600 (it holds commands and env); a rewrite keeps the mode exactly, whatever the umask', () => {
    const path = join(tmpDir(), 'new', 'c.json');
    const { store } = ConfigStore.open(path, starterConfigText);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    const umask = process.umask(0o077);
    try {
      expect(store.save(valid, store.rev).ok).toBe(true);
    } finally {
      process.umask(umask);
    }
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  test('save picks up an unseen hand edit first (→ 409), so it is never silently overwritten', () => {
    const path = join(tmpDir(), 'c.json');
    writeJson(path, valid);
    const { store } = ConfigStore.open(path);
    const base = store.rev;
    writeJson(path, padConfig([btn('hand', 0, 0)]));
    const r = store.save(padConfig([btn('ui', 0, 0)]), base);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(store.config.pads[0]!.buttons[0]!.id).toBe('hand');
  });

  test('sync: hand edits swap in; invalid edits keep the old config and report once; fixing recovers', () => {
    const path = join(tmpDir(), 'c.json');
    writeJson(path, valid);
    const { store } = ConfigStore.open(path);
    const events: string[] = [];
    store.subscribe({ change: (c) => events.push(`change:${c.pads[0]!.buttons.map((b) => b.id).join(',')}`), error: (e) => events.push(`error:${e.length}`) });

    expect(store.sync()).toBe('unchanged');
    writeJson(path, padConfig([btn('a', 0, 0), btn('b', 1, 0)]));
    expect(store.sync()).toBe('changed');
    const goodRev = store.rev;

    writeFileSync(path, '{ nope');
    expect(store.sync()).toBe('error');
    expect(store.sync()).toBe('error');
    expect(store.fileErrors?.[0]).toStartWith('(root): invalid JSON');
    expect(store.rev).toBe(goodRev);
    expect(store.config.pads[0]!.buttons.length).toBe(2);

    writeJson(path, padConfig([btn('a', 0, 0), btn('b', 0, 0)]));
    expect(store.sync()).toBe('error');
    writeJson(path, padConfig([btn('a', 0, 0), btn('b', 1, 0)]));
    expect(store.sync()).toBe('changed'); // same rev as before, but clients must hear the error is gone
    expect(store.fileErrors).toBeNull();
    expect(events).toEqual(['change:a,b', 'error:1', 'error:1', 'change:a,b']);
  });

  test('a broken hand edit since baseRev is a 409 too (invalid, with its errors): it is replaced only with force or its own rev', () => {
    const path = join(tmpDir(), 'c.json');
    writeJson(path, valid);
    const { store } = ConfigStore.open(path);
    const goodRev = store.rev;
    // A colleague's edit with a typo, or one caught mid-write: someone's work all the same.
    const broken = '{ "version": 1, "pads": [ { "id": "p", "name": "Pad", "buttons": [ {"id": "theirs" ';
    writeFileSync(path, broken);
    const r = store.save(padConfig([btn('mine', 0, 0)]), goodRev);
    expect(r).toEqual({ ok: false, status: 409, rev: revOf(broken), invalid: true, errors: [expect.stringMatching(/^\(root\): invalid JSON/)] });
    expect(readFileSync(path, 'utf8')).toBe(broken);
    expect(store.rev).toBe(goodRev); // still running the last good config
    // Saving with the broken file's own rev means "I've seen it": that replaces it.
    expect(store.save(padConfig([btn('fixed', 0, 0)]), revOf(broken)).ok).toBe(true);
    expect(store.fileErrors).toBeNull();
    expect(JSON.parse(readFileSync(path, 'utf8')).pads[0].buttons[0].id).toBe('fixed');
    // So does force, whatever the base.
    writeFileSync(path, '{ broken again');
    expect(store.save(padConfig([btn('forced', 0, 0)]), 'whatever')).toMatchObject({ ok: false, status: 409, invalid: true });
    const f = store.save(padConfig([btn('forced', 0, 0)]), 'whatever', { force: true });
    expect(f).toEqual({ ok: true, rev: revOf(readFileSync(path)) });
    expect(store.config.pads[0]!.buttons[0]!.id).toBe('forced');
  });

  test('force overwrites a newer valid hand edit; without it that is a 409 naming the new rev', () => {
    const path = join(tmpDir(), 'c.json');
    writeJson(path, valid);
    const { store } = ConfigStore.open(path);
    const base = store.rev;
    writeJson(path, padConfig([btn('hand', 0, 0)]));
    const r = store.save(padConfig([btn('ui', 0, 0)]), base);
    expect(r).toEqual({ ok: false, status: 409, rev: revOf(readFileSync(path)) });
    expect(store.save(padConfig([btn('ui', 0, 0)]), base, { force: true }).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).pads[0].buttons[0].id).toBe('ui');
    // A deleted file counts as changed (invalid: nothing to read).
    rmSync(path);
    expect(store.save(valid, store.rev)).toMatchObject({ ok: false, status: 409, invalid: true, errors: [expect.stringContaining('cannot read')] });
    expect(store.save(valid, store.rev, { force: true }).ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test('atomicWrite: a last check right before the rename can call it off, leaving no temp file', () => {
    const dir = tmpDir();
    const path = join(dir, 'c.json');
    writeFileSync(path, 'old');
    expect(atomicWrite(path, 'new', () => false)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['c.json']);
    expect(atomicWrite(path, 'new', () => true)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  test('a write that lands while a save is writing is kept: 409, not replaced', () => {
    const path = join(tmpDir(), 'c.json');
    writeJson(path, valid);
    const { store } = ConfigStore.open(path);
    const base = store.rev;
    // The hand edit lands right after the save checked baseRev against the file, before its rename.
    const realSync = store.sync.bind(store);
    let first = true;
    store.sync = () => {
      const r = realSync();
      if (first) {
        first = false;
        writeJson(path, padConfig([btn('hand', 0, 0)]));
      }
      return r;
    };
    const r = store.save(padConfig([btn('ui', 0, 0)]), base);
    expect(r).toEqual({ ok: false, status: 409, rev: revOf(readFileSync(path)) });
    expect(JSON.parse(readFileSync(path, 'utf8')).pads[0].buttons[0].id).toBe('hand');
    expect(store.config.pads[0]!.buttons[0]!.id).toBe('hand');
  });

  test('watch: debounced reload on hand edits, including editor-style rename-over', async () => {
    const dir = tmpDir();
    const path = join(dir, 'c.json');
    writeJson(path, valid);
    const { store } = ConfigStore.open(path);
    const revs: string[] = [];
    store.subscribe({ change: (_c, rev) => revs.push(rev) });
    store.watch(50);
    try {
      writeJson(path, padConfig([btn('one', 0, 0)]));
      await waitFor(() => store.config.pads[0]!.buttons[0]!.id === 'one', 3000, 'in-place edit');
      const tmp = join(dir, '.c.json.swp');
      writeJson(tmp, padConfig([btn('two', 0, 0)]));
      renameSync(tmp, path);
      await waitFor(() => store.config.pads[0]!.buttons[0]!.id === 'two', 3000, 'rename-over edit');
      // Our own saves don't trigger a second reload.
      store.save(padConfig([btn('three', 0, 0)]), store.rev);
      await Bun.sleep(300);
      expect(revs.length).toBe(3);
      expect(new Set(revs).size).toBe(3);
    } finally {
      store.close();
    }
  });

  test('watch: a symlinked config reloads on edits of its target, and after `sed -i` replaced the link with a file', async () => {
    const dir = tmpDir();
    const realDir = join(dir, 'dotfiles');
    mkdirSync(realDir);
    const real = join(realDir, 'buttpad.json');
    writeJson(real, padConfig([btn('one', 0, 0)]));
    const link = join(dir, 'buttpad.config.json');
    symlinkSync(real, link);
    const { store } = ConfigStore.open(link);
    const id = () => store.config.pads[0]!.buttons[0]!.id;
    expect(store.path).toBe(link);
    expect(store.dir).toBe(realDir); // relative action paths still resolve next to the real file
    store.watch(50);
    try {
      writeJson(real, padConfig([btn('two', 0, 0)]));
      await waitFor(() => id() === 'two', 3000, 'edit of the target');
      // sed -i: a temp file next to the link, renamed over it.
      writeJson(join(dir, 'sedAbc123'), padConfig([btn('three', 0, 0)]));
      renameSync(join(dir, 'sedAbc123'), link);
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      await waitFor(() => id() === 'three', 3000, 'link replaced by a file');
      // Now the file at the configured path is the config: saves go there, its edits are seen.
      expect(store.save(padConfig([btn('four', 0, 0)]), store.rev).ok).toBe(true);
      expect(JSON.parse(readFileSync(link, 'utf8')).pads[0].buttons[0].id).toBe('four');
      expect(JSON.parse(readFileSync(real, 'utf8')).pads[0].buttons[0].id).toBe('two');
      writeJson(link, padConfig([btn('five', 0, 0)]));
      await waitFor(() => id() === 'five', 3000, 'edit of the new file');
    } finally {
      store.close();
    }
  });
});

describe('examples and starter config', () => {
  const examplePath = join(root, 'examples', 'buttpad.example.json');

  test('the example config is valid and already in canonical (compact) form', () => {
    const text = readFileSync(examplePath, 'utf8');
    const r = parseConfig(JSON.parse(text));
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(serializeConfig(r.config)).toBe(text);
    expect(r.config.pads.map((p) => p.id)).toEqual(['lights', 'camera', 'test']);
    const all = r.config.pads.flatMap((p) => p.buttons);
    expect(all.some((b) => b.confirm)).toBe(true);
    expect(all.some((b) => b.whileRunning === 'queue')).toBe(true);
    expect(all.some((b) => b.whileRunning === 'cancel')).toBe(true);
    expect(all.some((b) => b.key)).toBe(true);
    expect(all.some((b) => b.w > 1 || b.h > 1)).toBe(true);
    expect(r.config.$schema).toBe('../schema/buttpad.config.schema.json');
    expect(existsSync(resolve(dirname(examplePath), r.config.$schema!))).toBe(true);
  });

  test('every example script exists, is executable and parses as POSIX sh', () => {
    const cfg = Config.parse(JSON.parse(readFileSync(examplePath, 'utf8')));
    for (const b of cfg.pads.flatMap((p) => p.buttons))
      if (b.action.type === 'exec' && b.action.command.startsWith('./')) accessSync(resolve(dirname(examplePath), b.action.command), constants.X_OK);
    const scripts = readdirSync(join(root, 'examples', 'scripts'));
    expect(scripts).toContain('light.sh');
    for (const s of scripts) {
      const path = join(root, 'examples', 'scripts', s);
      accessSync(path, constants.X_OK);
      const check = Bun.spawnSync(['sh', '-n', path]);
      expect(check.exitCode).toBe(0);
    }
  });

  test('starter config is valid and canonical on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const cfg = Config.parse(starterConfig('/x/buttpad.config.json', platform));
      expect(cfg.pads[0]!.buttons.length).toBeGreaterThanOrEqual(5);
      expect(JSON.stringify(cfg)).toContain('/x/buttpad.config.json');
    }
    const text = starterConfigText('/x/buttpad.config.json');
    expect(serializeConfig(Config.parse(JSON.parse(text)))).toBe(text);
  });

  test('schema/buttpad.config.schema.json is up to date (bun run schema)', () => {
    const file = JSON.parse(readFileSync(join(root, 'schema', 'buttpad.config.schema.json'), 'utf8'));
    const fresh = z.toJSONSchema(Config, { io: 'input' }) as Record<string, unknown>;
    const { title: _t, description: _d, ...rest } = file;
    expect(rest).toEqual(fresh);
  });
});
