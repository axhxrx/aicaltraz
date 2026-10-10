/**
 * Pairing tokens. Two random bearer tokens live in a 0600 JSON file next to the config:
 * `pressToken` (press buttons) and `adminToken` (also edit config = run arbitrary commands).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Role } from '../core/protocol.ts';
import { errCode, errnoText } from './errors.ts';
import { atomicWrite, NotRegularFileError, readRegularFile, WriteError } from './files.ts';

export interface Secrets {
  pressToken: string;
  adminToken: string;
}

export interface LoadedSecrets {
  secrets: Secrets;
  path: string;
  created: boolean;
  rotated: boolean;
  /** The file was group/world-accessible and got chmod'ed to 0600. */
  fixedMode: boolean;
}

const isWindows = process.platform === 'win32';

export const newToken = () => randomBytes(32).toString('base64url');

export function loadSecrets(path: string, opts: { rotate?: boolean } = {}): LoadedSecrets {
  let existing: string | undefined;
  try {
    existing = readRegularFile(path, 64 * 1024).toString('utf8');
  } catch (e) {
    if (e instanceof NotRegularFileError) throw new Error(`can't use the secrets file: ${e.message}`);
    if (errCode(e) !== 'ENOENT') throw new Error(`can't read the secrets file ${path}: ${errnoText(e)}`, { cause: e });
  }
  if (existing !== undefined && !opts.rotate) {
    const secrets = parseSecrets(existing);
    if (!secrets) throw new Error(`${path}: invalid secrets file (expected {"pressToken": "…", "adminToken": "…"}); fix it or start with --rotate-tokens`);
    let fixedMode = false;
    if (!isWindows && (statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
      fixedMode = true;
    }
    return { secrets, path, created: false, rotated: false, fixedMode };
  }
  const secrets = { pressToken: newToken(), adminToken: newToken() };
  writePrivate(path, JSON.stringify(secrets, null, 2) + '\n');
  return { secrets, path, created: existing === undefined, rotated: existing !== undefined, fixedMode: false };
}

function parseSecrets(text: string): Secrets | undefined {
  try {
    const v = JSON.parse(text) as Partial<Secrets> | null;
    const ok = (t: unknown): t is string => typeof t === 'string' && t.length > 0;
    if (v && ok(v.pressToken) && ok(v.adminToken) && v.pressToken !== v.adminToken) return { pressToken: v.pressToken, adminToken: v.adminToken };
  } catch {}
  return undefined;
}

/** Safe write (files.ts) of a file only the owner can read; through a symlink, to its target. */
function writePrivate(path: string, text: string) {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    throw new WriteError(path, `could not write ${path}: can't create its folder: ${errnoText(e)}`, errCode(e), { cause: e });
  }
  let target = path;
  try {
    target = realpathSync(path);
  } catch {}
  try {
    atomicWrite(target, text, { mode: 0o600 });
  } catch (e) {
    if (!(e instanceof WriteError)) throw e;
    throw new WriteError(path, `${e.message} (--secrets PATH keeps the pairing tokens somewhere else)`, e.code, { cause: e });
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Returns a resolver from a presented token to its role. Compares digests in constant time. */
export function makeAuth(secrets: Secrets): (token: string | null | undefined) => Role | null {
  const admin = digest(secrets.adminToken);
  const press = digest(secrets.pressToken);
  return (token) => {
    if (!token) return null;
    const d = digest(token);
    const isAdmin = timingSafeEqual(d, admin);
    const isPress = timingSafeEqual(d, press);
    return isAdmin ? 'admin' : isPress ? 'press' : null;
  };
}

/** Token from `Authorization: Bearer <token>`. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h?.match(/^Bearer\s+(\S+)\s*$/i);
  return m?.[1] ?? null;
}
