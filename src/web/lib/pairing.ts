/**
 * Pairing: a token from a link, a pasted one, or one traded for a pairing code. A new token is
 * tried on the host before it replaces the one this device has: a typo'd link (or a link for
 * another host) must not cost a working pairing.
 */
import type { PairResponse, Role } from '../../core/protocol.ts';

/** ok: the host takes it. rejected: 401/403. unreachable: no answer, or not one a ButtonPad host gives. */
export type Probe = 'ok' | 'rejected' | 'unreachable';

const PROBE_TIMEOUT = 4000;
const PAIR_TIMEOUT = 8000;

async function fetchWithin(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, cache: 'no-store', signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Does the host take `token`? (GET /api/state, which any valid token may read.) */
export async function probeToken(token: string, origin = location.origin): Promise<Probe> {
  try {
    const r = await fetchWithin(`${origin}/api/state`, { headers: { authorization: `Bearer ${token}` } }, PROBE_TIMEOUT);
    if (r.status === 401 || r.status === 403) return 'rejected';
    return r.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** The digits of a pairing code as typed or pasted ("123 456", "123-456"). */
export const codeDigits = (s: string) => s.replace(/\D/g, '');
/** Codes are short numbers; anything outside this isn't one. */
export const CODE_MIN = 4;
export const CODE_MAX = 12;

export type PairOutcome =
  | { ok: true; token: string; role: Role }
  /** bad: wrong, expired or used. limited: too many tries (`retryAfter` s). old: the host has no pairing codes. */
  | { ok: false; why: 'bad' | 'limited' | 'unreachable' | 'old'; retryAfter?: number };

/** POST /api/pair {code} → {token, role}: a one-time code (the host printed it, or an admin showed it) for a token. */
export async function pairWithCode(code: string, origin = location.origin): Promise<PairOutcome> {
  let r: Response;
  try {
    r = await fetchWithin(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }, PAIR_TIMEOUT);
  } catch {
    return { ok: false, why: 'unreachable' };
  }
  const retry = Number(r.headers.get('retry-after'));
  const retryAfter = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined;
  if (r.status === 401 || r.status === 403 || r.status === 400) return { ok: false, why: 'bad' };
  if (r.status === 429 || r.status === 503) return { ok: false, why: 'limited', ...(retryAfter ? { retryAfter } : {}) };
  if (r.status === 404 || r.status === 405) return { ok: false, why: 'old' };
  if (!r.ok) return { ok: false, why: 'unreachable' };
  const j = (await r.json().catch(() => null)) as Partial<PairResponse> | null;
  if (!j || typeof j.token !== 'string' || !j.token || (j.role !== 'press' && j.role !== 'admin')) return { ok: false, why: 'unreachable' };
  return { ok: true, token: j.token, role: j.role };
}

/** The pairing-link fragment: `#pair` (the code entry), or `#pair=123456` (the code with it). */
export function readPairHash(hash = location.hash): { code: string } | null {
  const m = /^#pair(?:=([\d\s-]*))?$/i.exec(hash.trim());
  return m ? { code: codeDigits(m[1] ?? '') } : null;
}

/** Strips `#pair…` from the address bar (a reload doesn't ask again). */
export function clearPairHash(): void {
  if (readPairHash()) history.replaceState(null, '', location.pathname + location.search);
}
