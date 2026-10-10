/**
 * Error messages people can act on: errno codes in plain words, and why the host can't listen.
 * `can't listen on 192.0.2.7:8787: no network interface on this machine has that address` instead of
 * `ENOENT: no such file or directory, listen`.
 */
import { isIP } from 'node:net';

export const errCode = (e: unknown): string | undefined => {
  const c = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof c === 'string' ? c : undefined;
};

const ERRNO: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'the file system is read-only',
  ENOSPC: 'no space left on the device',
  EDQUOT: 'disk quota exceeded',
  EIO: 'input/output error (a failing disk?)',
  EISDIR: 'is a directory',
  ENOTDIR: 'a part of the path is not a directory',
  EBUSY: 'the file is busy (a mount point?)',
  EXDEV: 'it is on another file system',
  EEXIST: 'already exists',
  EMFILE: 'too many open files',
  ENFILE: 'too many open files on this machine',
  ENAMETOOLONG: 'the name is too long',
  ELOOP: 'too many levels of symbolic links',
  EFBIG: 'the file is too big',
  ETXTBSY: 'the file is busy',
  EAGAIN: 'try again later (resource temporarily unavailable)',
};

/** `no space left on the device (ENOSPC)`; the error's own message when there's no code. */
export function errnoText(e: unknown): string {
  const code = errCode(e);
  const known = code ? ERRNO[code] : undefined;
  if (known) return `${known} (${code})`;
  const msg = (e as Error | undefined)?.message ?? String(e);
  return code && !msg.includes(code) ? `${msg} (${code})` : msg;
}

/** The host can't start serving. `message` is the whole sentence; `code` the errno code, if any. */
export class ListenError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ListenError';
  }
}

/** `host:port`, bracketing IPv6. */
export const hostPort = (host: string, port: number) => `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host || '0.0.0.0'}:${port}`;

const EVERY = 'use "0.0.0.0" to listen on every network interface, or "127.0.0.1" for this machine only';

/**
 * What Bun.serve threw, explained. `from` says where the host/port came from (for the hint).
 * TLS file problems are reported as such, not as a listen failure.
 */
export function listenError(host: string, port: number, e: unknown, from: { host: string; port: string } = { host: 'server.host', port: 'server.port' }): ListenError {
  const code = errCode(e);
  const msg = (e as Error | undefined)?.message ?? String(e);
  const syscall = (e as NodeJS.ErrnoException | undefined)?.syscall;
  if (code?.startsWith('ERR_OSSL') || /PEM routines|SSL/i.test(msg))
    return new ListenError(`can't use the TLS certificate/key: they aren't a valid PEM certificate and private key (${code ?? msg})`, code, { cause: e });
  if (syscall === 'open' || (syscall !== 'listen' && code === 'ENOENT')) {
    const file = /'([^']+)'/.exec(msg)?.[1];
    return new ListenError(`can't read the TLS ${file ? `file ${file}` : 'certificate/key'}: ${errnoText(e)}`, code, { cause: e });
  }
  const at = `can't listen on ${hostPort(host, port)}`;
  let why: string;
  switch (code) {
    case 'EADDRINUSE':
      why = `port ${port} is in use (another ButtPad?); pick another port (${from.port}), or --port 0 for any free one`;
      break;
    case 'EADDRNOTAVAIL':
      why = isIP(host)
        ? `no network interface on this machine has the address ${host} (${from.host}); ${EVERY}`
        : `"${host}" (${from.host}) is not an address of this machine; ${EVERY}`;
      break;
    case 'ENOENT':
    case 'ENOTFOUND':
    case 'EAI_NONAME':
      why = `"${host}" (${from.host}) is neither an IP address nor a host name that resolves; ${EVERY}`;
      break;
    case 'EAFNOSUPPORT':
      why = `IPv6 isn't available on this machine (${from.host} is "${host}"); ${EVERY}`;
      break;
    case 'EACCES':
    case 'EPERM':
      why = port < 1024 ? `permission denied: ports below 1024 need extra privileges; pick a port ≥ 1024 (${from.port})` : `permission denied (${code})`;
      break;
    default:
      why = errnoText(e);
  }
  return new ListenError(`${at}: ${why}`, code, { cause: e });
}
