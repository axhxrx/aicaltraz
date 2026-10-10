/**
 * Config & IO robustness (QA round 2, chaos): the one safe write under a full disk, short writes,
 * fsync and read-back failures, bind mounts and read-only file systems; non-regular files read without
 * blocking; the watcher across directory moves, deploy-style symlink swaps and bind mounts; `~` in paths.
 * Tests that need real mounts run as root only (they mount tmpfs / bind mounts and always unmount).
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandTilde, parseCli } from '../src/server/cli.ts';
import { atomicWrite, configDir, ConfigLoadError, ConfigStore, readConfigFile, revOf, WriteError } from '../src/server/config-store.ts';
import { readRegularFile } from '../src/server/files.ts';
import { startHost, type Host } from '../src/server/host.ts';
import { loadSecrets } from '../src/server/secrets.ts';
import { cleanupTmp, padConfig, tmpDir, waitFor, writeJson } from './helpers.ts';

const btn = (id: string, x: number, y: number, extra: object = {}) => ({ id, x, y, action: { type: 'shell' as const, script: 'true' }, ...extra });
const cfgText = (id: string) => JSON.stringify(padConfig([btn(id, 0, 0)]), null, 2) + '\n';
const idOf = (s: ConfigStore) => s.config.pads[0]!.buttons[0]!.id;
const err = (code: string, message = code) => Object.assign(new Error(message), { code });
const tmpFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

const spies: { mockRestore(): void }[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});
afterAll(cleanupTmp);

// ---- real mounts (root only) -------------------------------------------------------------------

const run = (argv: string[]) => Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
const canMount = (() => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  const dir = tmpDir('buttpad-mountprobe-');
  if (run(['mount', '-t', 'tmpfs', '-o', 'size=64k', 'tmpfs', dir]).exitCode !== 0) return false;
  run(['umount', dir]);
  return true;
})();

/** Runs `fn` with `dir` mounted as described (a tmpfs of `size`, or a bind mount of `source`), always unmounting. */
async function withMount<T>(args: string[], target: string, fn: () => T | Promise<T>): Promise<T> {
  const m = run(['mount', ...args, target]);
  if (m.exitCode !== 0) throw new Error(`mount ${args.join(' ')} ${target}: ${m.stderr.toString()}`);
  try {
    return await fn();
  } finally {
    for (let i = 0; i < 20 && run(['umount', target]).exitCode !== 0; i++) await Bun.sleep(50);
  }
}

// ---- atomicWrite ------------------------------------------------------------------------------

describe('atomicWrite: never a cut-off file, never a false success', () => {
  const setup = () => {
    const dir = tmpDir();
    const path = join(dir, 'c.json');
    writeFileSync(path, 'old content\n');
    return { dir, path };
  };

  test('short writes are continued until every byte is written', () => {
    const { dir, path } = setup();
    const real = fs.writeSync;
    let calls = 0;
    spies.push(
      spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Uint8Array, off: number, len: number, pos: number) => {
        calls++;
        return real(fd, buf, off, Math.min(len, 7), pos);
      }) as typeof fs.writeSync),
    );
    const text = 'x'.repeat(100) + '\n';
    expect(atomicWrite(path, text)).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(15);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(tmpFiles(dir)).toEqual([]);
  });

  test('a full disk mid-write (short write, then ENOSPC) throws, leaving the old file and no temp file', () => {
    const { dir, path } = setup();
    const real = fs.writeSync;
    let calls = 0;
    spies.push(
      spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Uint8Array, off: number, len: number, pos: number) => {
        if (calls++ === 0) return real(fd, buf, off, Math.min(len, 4096), pos);
        throw err('ENOSPC', 'ENOSPC: no space left on device, write');
      }) as typeof fs.writeSync),
    );
    let thrown: unknown;
    try {
      atomicWrite(path, 'y'.repeat(10_000));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WriteError);
    expect((thrown as WriteError).code).toBe('ENOSPC');
    expect((thrown as WriteError).message).toBe(`could not write ${path}: no space left on the device (ENOSPC); it was left as it was`);
    expect(readFileSync(path, 'utf8')).toBe('old content\n');
    expect(tmpFiles(dir)).toEqual([]);
  });

  test('a failed fsync, or bytes that read back different, throw too: the old file stays', () => {
    const { dir, path } = setup();
    const fsync = spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw err('EIO');
    });
    spies.push(fsync);
    expect(() => atomicWrite(path, 'new')).toThrow(/could not write .*input\/output error \(a failing disk\?\) \(EIO\); it was left as it was/);
    fsync.mockRestore();
    const realRead = fs.readSync;
    spies.push(
      spyOn(fs, 'readSync').mockImplementation(((fd: number, buf: Uint8Array, off: number, len: number, pos: number) => {
        const n = realRead(fd, buf, off, len, pos);
        if (n > 0) buf[off] = buf[off]! ^ 1; // the file system hands back something else
        return n;
      }) as typeof fs.readSync),
    );
    expect(() => atomicWrite(path, 'new')).toThrow(/the file system lost data/);
    expect(readFileSync(path, 'utf8')).toBe('old content\n');
    expect(tmpFiles(dir)).toEqual([]);
  });

  test('the directory is fsync\'ed after the rename; a disk error there is reported', () => {
    const { path } = setup();
    const realFsync = fs.fsyncSync;
    let n = 0;
    spies.push(
      spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
        if (++n === 2) throw err('EIO'); // 1: the temp file, 2: the directory
        realFsync(fd);
      }),
    );
    expect(() => atomicWrite(path, 'new')).toThrow(`wrote ${path}, but the disk reported an error making it permanent: input/output error (a failing disk?) (EIO)`);
    expect(n).toBe(2);
  });

  test('a read-only file system reports that, not the failed cleanup of the temp file', () => {
    const { path } = setup();
    const realOpen = fs.openSync;
    spies.push(
      spyOn(fs, 'openSync').mockImplementation(((p: string, flags: string | number, mode?: number) => {
        const writing = typeof flags === 'string' ? flags !== 'r' : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
        if (writing) throw err('EROFS', `EROFS: read-only file system, open '${p}'`);
        return realOpen(p, flags, mode);
      }) as typeof fs.openSync),
      spyOn(fs, 'rmSync').mockImplementation(((p: string) => {
        throw err('EROFS', `EROFS: read-only file system, rm '${p}'`);
      }) as typeof fs.rmSync),
    );
    expect(() => atomicWrite(path, 'new')).toThrow(`could not write ${path}: the file system is read-only (EROFS); it was left as it was`);
  });

  test('EBUSY/EXDEV on the rename (a single-file bind mount): a verified in-place write, same inode', () => {
    for (const code of ['EBUSY', 'EXDEV']) {
      const { dir, path } = setup();
      const ino = statSync(path).ino;
      spies.push(
        spyOn(fs, 'renameSync').mockImplementation(() => {
          throw err(code);
        }),
      );
      expect(atomicWrite(path, 'a new, longer content\n')).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('a new, longer content\n');
      expect(atomicWrite(path, 'short\n')).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('short\n');
      expect(statSync(path).ino).toBe(ino);
      expect(tmpFiles(dir)).toEqual([]);
      spies.pop()!.mockRestore();
    }
  });

  test('in place: a full disk while growing the file leaves the old bytes; a failed overwrite puts them back', () => {
    const { path } = setup();
    spies.push(
      spyOn(fs, 'renameSync').mockImplementation(() => {
        throw err('EBUSY');
      }),
    );
    const real = fs.writeSync;
    const writes = spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Uint8Array, off: number, len: number, pos: number) => {
      if (pos >= 12) throw err('ENOSPC'); // beyond the old end: the disk is full
      return real(fd, buf, off, len, pos);
    }) as typeof fs.writeSync);
    spies.push(writes);
    expect(() => atomicWrite(path, 'much longer than the old content\n')).toThrow(/no space left on the device \(ENOSPC\); it was left as it was/);
    expect(readFileSync(path, 'utf8')).toBe('old content\n');
    writes.mockRestore();
    let n = 0;
    spies.push(
      spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Uint8Array, off: number, len: number, pos: number) => {
        // 1: the temp file's write goes through; 2: the in-place overwrite fails halfway; then the old bytes go back.
        if (pos === 0 && len === 4 && ++n === 2) {
          real(fd, buf, off, 2, pos);
          throw err('EIO');
        }
        return real(fd, buf, off, len, pos);
      }) as typeof fs.writeSync),
    );
    expect(() => atomicWrite(path, 'new\n')).toThrow(/\(EIO\); its previous content was put back/);
    expect(readFileSync(path, 'utf8')).toBe('old content\n');
  });

  test('refuses to replace a directory, FIFO or device; keeps modes (new files 0600, `mode` forces one)', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'sub'));
    expect(() => atomicWrite(join(dir, 'sub'), 'x')).toThrow(/is a directory, not a regular file/);
    if (process.platform !== 'win32') {
      expect(run(['mkfifo', join(dir, 'fifo')]).exitCode).toBe(0);
      expect(() => atomicWrite(join(dir, 'fifo'), 'x')).toThrow(/is a named pipe \(FIFO\), not a regular file/);
      expect(statSync(join(dir, 'fifo')).isFIFO()).toBe(true);
      const fresh = join(dir, 'fresh.json');
      atomicWrite(fresh, 'x');
      expect(statSync(fresh).mode & 0o777).toBe(0o600);
      chmodSync(fresh, 0o640);
      atomicWrite(fresh, 'y');
      expect(statSync(fresh).mode & 0o777).toBe(0o640);
      atomicWrite(fresh, 'z', { mode: 0o600 });
      expect(statSync(fresh).mode & 0o777).toBe(0o600);
    }
  });

  test.skipIf(!canMount)('a really full disk (64 KB tmpfs): PUT /api/config is a 500 that says so; the file is intact; a smaller save then works', async () => {
    const dir = tmpDir('buttpad-full-');
    const elsewhere = tmpDir();
    await withMount(['-t', 'tmpfs', '-o', 'size=64k', 'tmpfs'], dir, async () => {
      const configPath = join(dir, 'buttpad.config.json');
      writeJson(configPath, padConfig([btn('a', 0, 0)]));
      const before = readFileSync(configPath, 'utf8');
      const host = await startHost({ configPath, secretsPath: join(elsewhere, 's.json'), statePath: join(elsewhere, 'state.json'), host: '127.0.0.1', port: 0, log: () => {} });
      hosts.push(host);
      const url = `http://127.0.0.1:${host.port}/api/config`;
      const headers = { authorization: `Bearer ${host.secrets.adminToken}`, 'content-type': 'application/json' };
      const { config, rev } = await (await fetch(url, { headers })).json();
      const big = structuredClone(config);
      for (let i = 0; i < 15; i++) big.pads[0].buttons.push(btn(`b${i}`, i % 4, 1 + Math.floor(i / 4), { action: { type: 'shell', script: `echo ${'x'.repeat(5000)}` } }));
      big.pads[0].rows = 5;
      const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ config: big, baseRev: rev }) });
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body.error).toBe(`could not write ${configPath}: no space left on the device (ENOSPC); it was left as it was`);
      expect(body.errors).toEqual([body.error]);
      expect(readFileSync(configPath, 'utf8')).toBe(before);
      expect(readdirSync(dir)).toEqual(['buttpad.config.json']);
      expect(host.config.rev).toBe(rev);
      const small = structuredClone(config);
      small.pads[0].buttons[0].label = 'Fits';
      const ok = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ config: small, baseRev: rev }) });
      expect(ok.status).toBe(200);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).pads[0].buttons[0].label).toBe('Fits');
      await host.stop();
    });
  }, 20_000);

  test.skipIf(!canMount)('a read-only mount: the 500 names the real error (EROFS)', async () => {
    const src = tmpDir();
    const mnt = tmpDir();
    const elsewhere = tmpDir();
    writeJson(join(src, 'buttpad.config.json'), padConfig([btn('a', 0, 0)]));
    await withMount(['--bind', src], mnt, async () => {
      expect(run(['mount', '-o', 'remount,ro,bind', mnt]).exitCode).toBe(0);
      const configPath = join(mnt, 'buttpad.config.json');
      const host = await startHost({ configPath, secretsPath: join(elsewhere, 's.json'), statePath: join(elsewhere, 'state.json'), host: '127.0.0.1', port: 0, log: () => {} });
      hosts.push(host);
      const url = `http://127.0.0.1:${host.port}/api/config`;
      const headers = { authorization: `Bearer ${host.secrets.adminToken}`, 'content-type': 'application/json' };
      const { config, rev } = await (await fetch(url, { headers })).json();
      config.pads[0].buttons[0].label = 'x';
      const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ config, baseRev: rev }) });
      expect(r.status).toBe(500);
      expect((await r.json()).error).toBe(`could not write ${configPath}: the file system is read-only (EROFS); it was left as it was`);
      await host.stop();
    });
  }, 20_000);

  test('a directory without write permission (the file has it): an in-place write', () => {
    const { dir, path } = setup();
    const realOpen = fs.openSync;
    spies.push(
      spyOn(fs, 'openSync').mockImplementation(((p: string, flags: string | number, mode?: number) => {
        if (String(p).endsWith('.tmp')) throw err('EACCES', `EACCES: permission denied, open '${p}'`);
        return realOpen(p, flags, mode);
      }) as typeof fs.openSync),
    );
    expect(atomicWrite(path, 'written in place\n')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('written in place\n');
    expect(tmpFiles(dir)).toEqual([]);
  });

  test.skipIf(!canMount)('Docker --read-only with a bind-mounted config file: the save goes into the file', async () => {
    const appSrc = tmpDir();
    const app = tmpDir();
    const real = join(tmpDir(), 'real.json');
    writeFileSync(real, cfgText('one'));
    writeFileSync(join(appSrc, 'buttpad.config.json'), '');
    await withMount(['--bind', appSrc], app, async () => {
      expect(run(['mount', '-o', 'remount,ro,bind', app]).exitCode).toBe(0);
      const mounted = join(app, 'buttpad.config.json');
      await withMount(['--bind', real], mounted, () => {
        const { store } = ConfigStore.open(mounted);
        expect(store.save(padConfig([btn('saved', 0, 0)]), store.rev)).toMatchObject({ ok: true });
        expect(JSON.parse(readFileSync(real, 'utf8')).pads[0].buttons[0].id).toBe('saved');
      });
    });
  }, 20_000);

  test.skipIf(!canMount)('a single-file bind mount (Docker-style): saves write in place; edits from outside are picked up', async () => {
    const hostDir = tmpDir();
    const appDir = tmpDir();
    const real = join(hostDir, 'real.json');
    const mounted = join(appDir, 'buttpad.config.json');
    writeFileSync(real, cfgText('one'));
    writeFileSync(mounted, '');
    await withMount(['--bind', real], mounted, async () => {
      const { store } = ConfigStore.open(mounted);
      store.watch(50, 200);
      try {
        const r = store.save(padConfig([btn('saved', 0, 0)]), store.rev);
        expect(r.ok).toBe(true);
        expect(JSON.parse(readFileSync(real, 'utf8')).pads[0].buttons[0].id).toBe('saved');
        expect(tmpFiles(appDir)).toEqual([]);
        writeFileSync(real, cfgText('edited-outside'));
        await waitFor(() => idOf(store) === 'edited-outside', 8000, 'an edit of the mounted file from outside');
      } finally {
        store.close();
      }
    });
  }, 20_000);
});

// ---- reading ----------------------------------------------------------------------------------

describe('non-regular config files are refused without blocking', () => {
  test.skipIf(process.platform === 'win32')('a FIFO: the host refuses it at once (no reader blocks on it)', () => {
    const dir = tmpDir();
    const fifo = join(dir, 'buttpad.config.json');
    expect(run(['mkfifo', fifo]).exitCode).toBe(0);
    // In a child, so a regression hangs that child (killed by the timeout), not the test runner.
    const code = `
      const { readConfigFile } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'server', 'config-store.ts'))});
      console.log(JSON.stringify(readConfigFile(${JSON.stringify(fifo)})));`;
    const t0 = Date.now();
    const child = Bun.spawnSync([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(child.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(9000);
    expect(JSON.parse(child.stdout.toString())).toEqual({ ok: false, errors: [`${fifo} is a named pipe (FIFO), not a regular file`] });
    expect(() => ConfigStore.open(fifo)).toThrow(`can't use the config file: ${fifo} is a named pipe (FIFO), not a regular file`);
    expect(() => loadSecrets(fifo)).toThrow(`can't use the secrets file: ${fifo} is a named pipe (FIFO), not a regular file`);
  });

  test('a directory (with a hint), a device, a file too big to be a config', () => {
    const dir = tmpDir();
    expect(readConfigFile(dir)).toEqual({ ok: false, errors: [`${dir} is a directory, not a regular file (--config takes the file's path, e.g. ${join(dir, 'buttpad.config.json')})`] });
    try {
      ConfigStore.open(dir);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigLoadError);
      expect((e as ConfigLoadError).unreadable).toBe(true);
    }
    if (existsSync('/dev/null')) expect(readConfigFile('/dev/null')).toEqual({ ok: false, errors: ['/dev/null is a character device, not a regular file'] });
    const big = join(dir, 'big.json');
    writeFileSync(big, '');
    truncateSync(big, 17 * 1024 * 1024); // sparse
    expect(readConfigFile(big).ok).toBe(false);
    expect(() => readRegularFile(big)).toThrow(/is too big \(17\.0 MB; at most 16 MB\)/);
    expect(readConfigFile(join(dir, 'missing.json'))).toEqual({ ok: false, errors: [`cannot read ${join(dir, 'missing.json')}: no such file or directory (ENOENT)`] });
  });

  test('a FIFO swapped in for the config while the host runs: reported, previous config kept', async () => {
    if (process.platform === 'win32') return;
    const dir = tmpDir();
    const path = join(dir, 'c.json');
    writeFileSync(path, cfgText('one'));
    const { store } = ConfigStore.open(path);
    const errors: string[][] = [];
    store.subscribe({ error: (e) => errors.push(e) });
    store.watch(50, 200);
    try {
      unlinkSync(path);
      expect(run(['mkfifo', path]).exitCode).toBe(0);
      await waitFor(() => errors.length > 0, 8000, 'the FIFO to be reported');
      expect(errors[0]).toEqual([`${path} is a named pipe (FIFO), not a regular file`]);
      expect(idOf(store)).toBe('one');
      // A save over it is a 409 (the file isn't what baseRev names); forcing it refuses to replace a FIFO.
      expect(store.save(padConfig([btn('two', 0, 0)]), store.rev)).toMatchObject({ ok: false, status: 409, invalid: true });
      expect(() => store.save(padConfig([btn('two', 0, 0)]), store.rev, { force: true })).toThrow(WriteError);
    } finally {
      store.close();
    }
  });
});

// ---- the watcher --------------------------------------------------------------------------------

describe('watcher: reloads survive directory moves, deploy-style symlink swaps and missed events', () => {
  test('the config directory moved away and recreated (`mv cfg cfg.old; mkdir cfg`): reloads, and keeps reloading', async () => {
    const root = tmpDir();
    mkdirSync(join(root, 'cfg'));
    writeFileSync(join(root, 'cfg', 'c.json'), cfgText('one'));
    const { store } = ConfigStore.open(join(root, 'cfg', 'c.json'));
    store.watch(50, 200);
    try {
      renameSync(join(root, 'cfg'), join(root, 'cfg.old'));
      mkdirSync(join(root, 'cfg'));
      writeFileSync(join(root, 'cfg', 'c.json'), cfgText('two'));
      await waitFor(() => idOf(store) === 'two', 8000, 'the recreated directory to be read');
      writeFileSync(join(root, 'cfg', 'c.json'), cfgText('three'));
      await waitFor(() => idOf(store) === 'three', 8000, 'a later edit');
      // The old directory isn't watched any more.
      writeFileSync(join(root, 'cfg.old', 'c.json'), cfgText('stale'));
      await Bun.sleep(500);
      expect(idOf(store)).toBe('three');
    } finally {
      store.close();
    }
  }, 20_000);

  test('a symlinked directory swapped (`ln -sfn rel2 current`): reloads, and actions resolve in the new release', async () => {
    const root = tmpDir();
    for (const r of ['rel1', 'rel2']) {
      mkdirSync(join(root, r));
      writeFileSync(join(root, r, 'c.json'), cfgText(r));
    }
    symlinkSync('rel1', join(root, 'current'));
    const { store } = ConfigStore.open(join(root, 'current', 'c.json'));
    expect(store.dir).toBe(join(root, 'current'));
    store.watch(50, 200);
    try {
      symlinkSync('rel2', join(root, 'current.new'));
      renameSync(join(root, 'current.new'), join(root, 'current'));
      await waitFor(() => idOf(store) === 'rel2', 8000, 'the swapped-in release');
      writeFileSync(join(root, 'rel2', 'c.json'), cfgText('rel2-edited'));
      await waitFor(() => idOf(store) === 'rel2-edited', 8000, 'an edit in the new release');
    } finally {
      store.close();
    }
  }, 20_000);

  test('a change fs.watch never reports is found by the stat poll', async () => {
    const dir = tmpDir();
    const path = join(dir, 'c.json');
    writeFileSync(path, cfgText('one'));
    const { store } = ConfigStore.open(path);
    // No fs.watch events at all (a network file system, say): only the poll can see the edit.
    const watchSpy = spyOn(fs, 'watch').mockImplementation((() => {
      throw err('ENOSYS', 'fs.watch not supported here');
    }) as unknown as typeof fs.watch);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    spies.push(watchSpy, errSpy);
    store.watch(50, 200);
    try {
      expect(errSpy.mock.calls[0]?.[0]).toContain('checking every 2 s instead');
      writeFileSync(path, cfgText('two'));
      await waitFor(() => idOf(store) === 'two', 8000, 'the poll');
    } finally {
      store.close();
    }
  }, 20_000);

  test('configDir: a symlinked config file resolves to its target\'s folder; symlinked folders above it stay as written', () => {
    const root = tmpDir();
    mkdirSync(join(root, 'dotfiles'));
    writeFileSync(join(root, 'dotfiles', 'bp.json'), cfgText('a'));
    symlinkSync('dotfiles/bp.json', join(root, 'link.json'));
    expect(configDir(join(root, 'link.json'))).toBe(join(root, 'dotfiles'));
    symlinkSync('dotfiles', join(root, 'current'));
    expect(configDir(join(root, 'current', 'bp.json'))).toBe(join(root, 'current'));
    expect(configDir(join(root, 'dotfiles', 'bp.json'))).toBe(join(root, 'dotfiles'));
  });

  test('saves still never trigger a second reload, and a broken file then fixed is reported once each', async () => {
    const dir = tmpDir();
    const path = join(dir, 'c.json');
    writeFileSync(path, cfgText('one'));
    const { store } = ConfigStore.open(path);
    const events: string[] = [];
    store.subscribe({ change: (c) => events.push(`change:${c.pads[0]!.buttons[0]!.id}`), error: () => events.push('error') });
    store.watch(50, 100);
    try {
      expect(store.save(padConfig([btn('saved', 0, 0)]), store.rev).ok).toBe(true);
      await Bun.sleep(400);
      writeFileSync(path, '{ "broken": ');
      await waitFor(() => events.includes('error'), 8000, 'the broken file');
      await Bun.sleep(400);
      writeFileSync(path, cfgText('fixed'));
      await waitFor(() => events.includes('change:fixed'), 8000, 'the fix');
      expect(events).toEqual(['change:saved', 'error', 'change:fixed']);
      expect(store.rev).toBe(revOf(readFileSync(path)));
    } finally {
      store.close();
    }
  }, 20_000);
});

// ---- ~ in paths -------------------------------------------------------------------------------

describe('~ in --config, --secrets, --tls-cert/--tls-key and BUTTPAD_CONFIG', () => {
  const env = { HOME: '/home/someone' };
  test('expands like a shell would have', () => {
    expect(parseCli(['--config=~/bp/c.json'], env).config).toBe('/home/someone/bp/c.json');
    expect(parseCli(['--config', '~'], env).config).toBe('/home/someone');
    expect(parseCli([], { ...env, BUTTPAD_CONFIG: '~/x.json' }).config).toBe('/home/someone/x.json');
    expect(parseCli(['--secrets', '~/s.json'], env).secrets).toBe('/home/someone/s.json');
    expect(parseCli(['--tls-cert', '~/c.pem', '--tls-key', '~/k.pem'], env).tls).toEqual({ cert: '/home/someone/c.pem', key: '/home/someone/k.pem' });
  });

  test('leaves everything else alone', () => {
    expect(parseCli(['--config', 'a/~/b.json'], env).config).toBe('a/~/b.json');
    expect(parseCli(['--config', '~other/b.json'], env).config).toBe('~other/b.json');
    expect(parseCli([], env).config).toBe('./buttpad.config.json');
    expect(expandTilde('~/x')).toBe(join(homedir(), 'x'));
  });

  test('a quoted BUTTPAD_CONFIG=~/… no longer creates a directory named "~"', async () => {
    const home = tmpDir();
    const cwd = tmpDir();
    const main = join(import.meta.dir, '..', 'src', 'server', 'main.ts');
    const proc = Bun.spawn([process.execPath, main, '--port', '0', '--host', '127.0.0.1', '--no-qr', '--ready-json'], {
      cwd,
      env: { ...process.env, HOME: home, BUTTPAD_CONFIG: '~/buttpad/c.json', NODE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const ready = JSON.parse(new TextDecoder().decode(value).split('\n')[0]!);
      expect(ready.configPath).toBe(join(home, 'buttpad', 'c.json'));
      expect(existsSync(join(home, 'buttpad', 'c.json'))).toBe(true);
      expect(existsSync(join(cwd, '~'))).toBe(false);
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
      rmSync(join(cwd, '~'), { recursive: true, force: true });
    }
  }, 20_000);
});
