/**
 * The host's file IO, for the config, the secrets and the state file: one safe write (`atomicWrite`)
 * and one safe read (`readRegularFile`).
 *
 * atomicWrite never reports success for bytes that aren't on disk, and never leaves a half-written
 * file in place of a good one: the new bytes go to a temp file next to the target, fully (short writes
 * are continued; a full disk throws), are fsync'ed, read back and compared, and only then renamed over
 * the target; then the directory is fsync'ed so the rename survives a crash. A file that can't be
 * renamed over (a single-file bind mount: EBUSY/EXDEV), or whose directory can't take a temp file, is
 * rewritten in place instead: grown first (so a full disk fails before any old byte changes), then
 * overwritten, truncated, fsync'ed and read back; on failure the old bytes are put back.
 */
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { errCode, errnoText } from './errors.ts';

const isWindows = process.platform === 'win32';
const O_NONBLOCK = isWindows ? 0 : (constants.O_NONBLOCK ?? 0);

/** Largest file the host reads: a config or state file is a few KB, a UI save at most 1 MB. */
export const MAX_READ_BYTES = 16 * 1024 * 1024;

/** A write that didn't happen. `message` says what happened to the file (left as it was, or worse). */
export class WriteError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WriteError';
  }
}

/** The path is a FIFO, device, directory or socket: never opened for reading (a FIFO would block). */
export class NotRegularFileError extends Error {
  readonly code = 'ENOTREG';
  constructor(
    readonly path: string,
    readonly kind: string,
  ) {
    super(`${path} is ${kind}, not a regular file`);
    this.name = 'NotRegularFileError';
  }
}

export function fileKind(st: Stats): string {
  if (st.isFile()) return 'a regular file';
  if (st.isDirectory()) return 'a directory';
  if (st.isFIFO()) return 'a named pipe (FIFO)';
  if (st.isSocket()) return 'a socket';
  if (st.isCharacterDevice()) return 'a character device';
  if (st.isBlockDevice()) return 'a block device';
  return 'not a regular file';
}

/** An error of ours whose message says it all (errno text would only say "input/output error"). */
const ioError = (message: string, code = 'EIO') => Object.assign(new Error(message), { code, plain: true });
const reason = (e: unknown) => ((e as { plain?: boolean } | undefined)?.plain ? (e as Error).message : errnoText(e));

/**
 * The bytes of a regular file. Anything else (FIFO, device, directory, socket) throws
 * NotRegularFileError without blocking: it's checked before opening, and again on the open file
 * (opened non-blocking, in case it was swapped for a FIFO in between). Bigger than `maxBytes`: EFBIG.
 */
export function readRegularFile(path: string, maxBytes = MAX_READ_BYTES): Buffer {
  return readRegularFileStat(path, maxBytes).data;
}

/** readRegularFile, plus the stat of the file the bytes came from (the open file: owner and mode of exactly what was read). */
export function readRegularFileStat(path: string, maxBytes = MAX_READ_BYTES): { data: Buffer; stat: Stats } {
  const st = statSync(path);
  if (!st.isFile()) throw new NotRegularFileError(path, fileKind(st));
  const fd = openSync(path, constants.O_RDONLY | O_NONBLOCK);
  try {
    const now = fstatSync(fd);
    if (!now.isFile()) throw new NotRegularFileError(path, fileKind(now));
    if (now.size > maxBytes) throw ioError(`${path} is too big (${(now.size / 1048576).toFixed(1)} MB; at most ${maxBytes / 1048576} MB)`, 'EFBIG');
    return { data: readAll(fd, now.size, maxBytes, path), stat: now };
  } finally {
    closeQuietly(fd);
  }
}

/** From offset 0 to EOF (the file may have grown or shrunk since its size was taken). */
function readAll(fd: number, sizeHint: number, maxBytes: number, path: string): Buffer {
  let buf = Buffer.allocUnsafe(Math.max(sizeHint, 0) + 1);
  let len = 0;
  for (;;) {
    if (len === buf.length) {
      if (len > maxBytes) throw ioError(`${path} is too big (more than ${maxBytes / 1048576} MB)`, 'EFBIG');
      const bigger = Buffer.allocUnsafe(buf.length * 2);
      buf.copy(bigger, 0, 0, len);
      buf = bigger;
    }
    const n = readSync(fd, buf, len, buf.length - len, len);
    if (n === 0) return buf.subarray(0, len);
    len += n;
  }
}

export interface AtomicWriteOptions {
  /** A last say right before the target is replaced: false leaves it alone, and atomicWrite returns false. */
  stillOk?: () => boolean;
  /** Mode of the written file. Default: the existing file's mode; 0600 for a new file. */
  mode?: number;
}

/**
 * Replace `path` with `data`, safely (see the top of this file). Returns true once the new bytes are on
 * disk (false: `stillOk` called it off). Throws WriteError otherwise, with the target as it was (the
 * message says so), and no temp file left behind. Refuses to replace anything but a regular file, and
 * a file without write permission.
 */
export function atomicWrite(path: string, data: string | Uint8Array, opts: AtomicWriteOptions | (() => boolean) = {}): boolean {
  const { stillOk, mode: forcedMode } = typeof opts === 'function' ? { stillOk: opts, mode: undefined } : opts;
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const dir = dirname(path);
  let existing: Stats | undefined;
  try {
    existing = statSync(path);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw failed(path, e, true);
  }
  if (existing) {
    if (!existing.isFile()) throw new WriteError(path, `could not write ${path}: it is ${fileKind(existing)}, not a regular file`, 'ENOTREG');
    try {
      accessSync(path, constants.W_OK);
    } catch (e) {
      const code = errCode(e);
      const why = code === 'EROFS' ? errnoText(e) : `the file is read-only (${code ?? 'EACCES'})`;
      throw new WriteError(path, `could not write ${path}: ${why}; it was left as it was`, code, { cause: e });
    }
  }
  const mode = forcedMode ?? (existing ? existing.mode & 0o777 : 0o600);
  /**
   * The directory can't take the temp file, but the file itself may be writable: a directory without
   * write permission, or a file bind-mounted from another file system (Docker: `-v ./c.json:/app/c.json`,
   * maybe with a read-only or full root file system).
   */
  const tempRefused = (e: unknown) => {
    const code = errCode(e);
    if (!existing) return false;
    // The file passed the write-permission check, so a read-only directory means it's mounted on its own.
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return true;
    return (code === 'ENOSPC' || code === 'EDQUOT') && sameDevice(dir, existing) === false;
  };

  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', mode);
  } catch (e) {
    if (tempRefused(e)) return inPlace(path, bytes, forcedMode, stillOk);
    throw failed(path, e, !!existing);
  }
  try {
    writeTemp(fd, bytes, mode);
    verify(tmp, bytes);
  } catch (e) {
    removeQuietly(tmp);
    if (tempRefused(e)) return inPlace(path, bytes, forcedMode, stillOk);
    throw failed(path, e, !!existing);
  }
  if (stillOk && !stillOk()) {
    removeQuietly(tmp);
    return false;
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    removeQuietly(tmp);
    const code = errCode(e);
    // A single-file bind mount (Docker) on the same file system: EBUSY. Windows: the file is open elsewhere.
    if (existing && (code === 'EBUSY' || code === 'EXDEV' || (isWindows && (code === 'EPERM' || code === 'EACCES')))) return inPlace(path, bytes, forcedMode);
    throw failed(path, e, !!existing);
  }
  fsyncDir(dir, path);
  return true;
}

/** Write, fsync and close the temp file; the first error wins (close can report a failed write too, on NFS). */
function writeTemp(fd: number, bytes: Uint8Array, mode: number) {
  let err: unknown;
  try {
    if (!isWindows) chmodBestEffort(fd, mode); // exactly that mode, whatever the umask
    writeAll(fd, bytes, 0);
    fsyncSync(fd);
  } catch (e) {
    err = e;
  }
  try {
    closeSync(fd);
  } catch (e) {
    err ??= e;
  }
  if (err !== undefined) throw err;
}

/** false: `st` (the file) lives on another device than `dir`: a mount point (or, on overlayfs, a file of a lower layer). */
function sameDevice(dir: string, st: Stats): boolean | undefined {
  try {
    return statSync(dir).dev === st.dev;
  } catch {
    return undefined;
  }
}

function failed(path: string, e: unknown, existed: boolean, what = existed ? 'it was left as it was' : 'nothing was written'): WriteError {
  if (e instanceof WriteError) return e;
  return new WriteError(path, `could not write ${path}: ${reason(e)}; ${what}`, errCode(e), { cause: e });
}

/** All of `bytes` at `position`; a short write is continued (the next one throws, e.g. ENOSPC). */
function writeAll(fd: number, bytes: Uint8Array, position: number) {
  let off = 0;
  while (off < bytes.length) {
    const n = writeSync(fd, bytes, off, bytes.length - off, position + off);
    if (!(n > 0)) throw ioError(`short write (${off} of ${bytes.length} bytes)`);
    off += n;
  }
}

function verify(path: string, bytes: Buffer) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    verifyFd(fd, bytes);
  } finally {
    closeQuietly(fd);
  }
}

/** The file holds exactly `bytes`: size, then content. */
function verifyFd(fd: number, bytes: Buffer) {
  const size = fstatSync(fd).size;
  let same = size === bytes.length;
  if (same) {
    const back = Buffer.allocUnsafe(size + 1);
    let len = 0;
    for (let n; len < back.length && (n = readSync(fd, back, len, back.length - len, len)) > 0; ) len += n;
    same = len === size && back.subarray(0, len).equals(bytes);
  }
  if (!same) throw ioError(`what was read back differs from the ${bytes.length} bytes written (${size} bytes on disk): the file system lost data`);
}

/** Make a rename durable. A file system that can't fsync directories is fine; a disk error isn't. */
function fsyncDir(dir: string, path: string) {
  if (isWindows) return;
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY);
  } catch {
    return; // e.g. a write-only directory: nothing more to do
  }
  try {
    fsyncSync(fd);
  } catch (e) {
    const code = errCode(e);
    if (code === 'EIO' || code === 'ENOSPC' || code === 'EDQUOT')
      throw new WriteError(path, `wrote ${path}, but the disk reported an error making it permanent: ${errnoText(e)}`, code, { cause: e });
  } finally {
    closeQuietly(fd);
  }
}

/**
 * Rewrite a file in place (it can't be renamed over). Grows it first, so a full disk fails before any
 * old byte changes; then overwrites, truncates, fsyncs and reads back. On failure, the old bytes are
 * put back (they fit: their blocks are still allocated).
 */
function inPlace(path: string, bytes: Buffer, mode: number | undefined, stillOk?: () => boolean): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | O_NONBLOCK);
  } catch (e) {
    throw failed(path, e, true);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new WriteError(path, `could not write ${path}: it is ${fileKind(st)}, not a regular file`, 'ENOTREG');
    if (stillOk && !stillOk()) return false;
    const old = readAll(fd, st.size, MAX_READ_BYTES, path);
    if (bytes.length > old.length)
      try {
        writeAll(fd, bytes.subarray(old.length), old.length);
        fsyncSync(fd);
      } catch (e) {
        truncateQuietly(fd, old.length);
        throw failed(path, e, true);
      }
    try {
      writeAll(fd, bytes.subarray(0, Math.min(old.length, bytes.length)), 0);
      ftruncateSync(fd, bytes.length);
      if (mode !== undefined && !isWindows) chmodBestEffort(fd, mode);
      fsyncSync(fd);
      verifyFd(fd, bytes);
    } catch (e) {
      try {
        writeAll(fd, old, 0);
        ftruncateSync(fd, old.length);
        fsyncSync(fd);
      } catch {
        throw failed(path, e, true, 'it may be damaged (putting its previous content back failed too)');
      }
      throw failed(path, e, true, 'its previous content was put back');
    }
    return true;
  } catch (e) {
    throw failed(path, e, true);
  } finally {
    closeQuietly(fd);
  }
}

/** File systems without Unix modes (FAT, some network mounts) refuse chmod: not worth failing a save over. */
function chmodBestEffort(fd: number, mode: number) {
  try {
    fchmodSync(fd, mode);
  } catch (e) {
    const code = errCode(e);
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EINVAL') throw e;
  }
}

function closeQuietly(fd: number) {
  try {
    closeSync(fd);
  } catch {}
}

function truncateQuietly(fd: number, len: number) {
  try {
    ftruncateSync(fd, len);
    fsyncSync(fd);
  } catch {}
}

/** Cleanup must never hide the error that made it necessary (EROFS on the temp file's rm, say). */
function removeQuietly(path: string) {
  try {
    rmSync(path, { force: true });
  } catch {}
}
