/**
 * Pairing tokens. Two random bearer tokens live in a 0600 JSON file next to the config:
 * `pressToken` (press buttons) and `adminToken` (also edit config = run arbitrary commands).
 * Browsers open their WebSocket with a one-time ticket made from one (WsTickets, below).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Role, WsTicket } from '../core/protocol.ts';
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

/** A WebSocket ticket is valid this long (host's monotonic clock)… */
export const WS_TICKET_TTL_MS = 30_000;
/** …and at most this many are out per token: making one more drops that token's oldest. */
export const WS_TICKETS_PER_TOKEN = 64;

/**
 * One-time tickets for `/ws?ticket=…` (POST /api/ws-ticket makes them, with the token in the
 * Authorization header): a browser can't set headers on a WebSocket, and a URL ends up in logs (a
 * reverse proxy's, a preview pane's), so it never puts its long-lived token in one. A ticket is 32
 * random bytes, valid WS_TICKET_TTL_MS, good for one request (whatever becomes of it) and carries
 * the role of the token that made it. Kept as sha256 digests: a lookup's timing says nothing about
 * a ticket. At most WS_TICKETS_PER_TOKEN per token (role), so a press-token holder can't crowd out
 * admin tickets, and memory stays bounded.
 */
export class WsTickets {
  /** By digest; in the order made, which is the order they expire (one TTL for all). */
  private tickets = new Map<string, { role: Role; deadline: number }>();
  private readonly clock: () => number;
  readonly ttlMs: number;
  private readonly perToken: number;

  constructor(o: { ttlMs?: number; perToken?: number; clock?: () => number } = {}) {
    this.clock = o.clock ?? (() => performance.now());
    this.ttlMs = o.ttlMs ?? WS_TICKET_TTL_MS;
    this.perToken = Math.max(1, o.perToken ?? WS_TICKETS_PER_TOKEN);
  }

  mint(role: Role): WsTicket {
    this.prune();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(digest(ticket).toString('hex'), { role, deadline: this.clock() + this.ttlMs });
    let n = 0;
    for (const t of this.tickets.values()) if (t.role === role) n++;
    for (const [d, t] of this.tickets) {
      if (n <= this.perToken) break;
      if (t.role !== role) continue;
      this.tickets.delete(d);
      n--;
    }
    return { ticket, expiresInMs: this.ttlMs };
  }

  /** The role of a valid ticket, which is used up; undefined for an unknown, used or expired one. */
  redeem(ticket: string): Role | undefined {
    this.prune();
    if (!ticket || ticket.length > 256) return undefined;
    const d = digest(ticket).toString('hex');
    const t = this.tickets.get(d);
    if (!t) return undefined;
    this.tickets.delete(d);
    return t.role;
  }

  /** Tickets valid now. */
  get size(): number {
    this.prune();
    return this.tickets.size;
  }

  private prune() {
    const now = this.clock();
    for (const [d, t] of this.tickets) {
      if (t.deadline > now) break;
      this.tickets.delete(d);
    }
  }
}
