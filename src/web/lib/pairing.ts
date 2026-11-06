/**
 * Pairing: a token from a link, a pasted one, or one traded for a pairing code. A new token is
 * tried on the host before it replaces the one this device has: a typo'd link (or a link for
 * another host) must not cost a working pairing.
 */
import type { OriginRefusal, PairResponse, Role } from '../../core/protocol.ts';

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
/** A pairing code is exactly this many digits (the host makes no other kind). */
export const CODE_LEN = 6;

/** Digits as the host prints a code: "123 456" (a shorter start as far as it goes: "12", "123 4"). */
export const formatCode = (digits: string) => (digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);

/** Where the caret goes in `shown` to sit right after its `n`-th digit. */
function afterDigit(shown: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < shown.length; i++) if (/\d/.test(shown[i]!) && ++seen === n) return i + 1;
  return shown.length;
}

/** The code field after one edit: what it shows, where the caret goes. */
export interface CodeEdit {
  value: string;
  caret: number;
  /** The edit would have made more than CODE_LEN digits: refused, the field is as it was. */
  over: boolean;
  /** Still `fresh` (see editCode): only a refused edit leaves it so. */
  fresh: boolean;
}

/**
 * One edit of the pairing-code field. `prev` is what it showed, `raw` what the browser made of the
 * edit, `caret` where the caret is in `raw`, `deleting` whether the edit was a delete. Only digits
 * count (spaces, dashes, dots are ignored), shown as "123 456", and never more than CODE_LEN: an edit
 * that would make more is refused whole (QA: typed into the middle of a code, "640169616" showed as
 * "640 1696", and a wrong code went to the host). `fresh`: the code shown just failed, so this edit
 * starts a new one wherever the caret is (a tap on the field moved it into the old digits): what it
 * typed or pasted replaces the code, a delete clears it. `sel`: what the edit replaced in `prev`
 * (the selection at `beforeinput`), to tell exactly what it put in.
 */
export function editCode(prev: string, raw: string, caret: number, deleting: boolean, fresh = false, sel?: { start: number; end: number }): CodeEdit {
  const refuse = (): CodeEdit => ({ value: prev, caret: Math.min(prev.length, Math.max(0, caret - (raw.length - prev.length))), over: true, fresh });
  if (fresh) {
    if (deleting) return { value: '', caret: 0, over: false, fresh: false };
    // What this edit put in: `raw` without what it kept of `prev` — around the selection it replaced
    // or, not knowing that, their common start and end (a new code pasted over the old one that
    // starts with the same digits would lose them that way).
    let a = 0;
    let b = 0;
    if (sel && sel.start >= 0 && sel.start <= sel.end && sel.end <= prev.length && raw.length - (prev.length - sel.end) >= sel.start) {
      a = sel.start;
      b = prev.length - sel.end;
    } else {
      while (a < prev.length && a < raw.length && prev[a] === raw[a]) a++;
      while (b < prev.length - a && b < raw.length - a && prev[prev.length - 1 - b] === raw[raw.length - 1 - b]) b++;
    }
    const typed = codeDigits(raw.slice(a, raw.length - b));
    if (typed.length > CODE_LEN) return refuse();
    // Something that isn't a digit (a letter, a space): nothing to start a code with yet.
    if (!typed) return { value: prev, caret: prev.length, over: false, fresh };
    const value = formatCode(typed);
    return { value, caret: value.length, over: false, fresh: false };
  }
  let digits = codeDigits(raw);
  let before = codeDigits(raw.slice(0, caret)).length;
  // A backspace that took only the space between the groups takes the digit before it too.
  if (deleting && raw.length < prev.length && digits === codeDigits(prev) && before > 0) {
    digits = digits.slice(0, before - 1) + digits.slice(before);
    before--;
  }
  if (digits.length > CODE_LEN) return refuse();
  const value = formatCode(digits);
  return { value, caret: afterDigit(value, before), over: false, fresh: false };
}

/**
 * Text typed into the pairing-link box that is a pairing code instead ("123 456" from the host's
 * screen): its digits; null when it isn't digits (spaces, dashes and dots aside). A token is never
 * all digits (43 random base64url characters); a numeric one can still come as a link (`#token=`).
 */
export function asCode(s: string): string | null {
  const t = s.trim();
  return /^[\d\s.-]+$/.test(t) && /\d/.test(t) ? codeDigits(t) : null;
}

export type PairOutcome =
  | { ok: true; token: string; role: Role }
  /**
   * bad: wrong, expired or used. limited: too many tries (`retryAfter` s). old: the host has no
   * pairing codes. origin: the host turns this page's address away (a proxy it wasn't told about);
   * `allowOrigin`, the exact `--allow-origin` value that would let it in, as the host says it.
   */
  | { ok: false; why: 'bad' | 'limited' | 'unreachable' | 'old' | 'origin'; retryAfter?: number; allowOrigin?: string };

/** A 403's `OriginRefusal` body (core/protocol.ts): the `--allow-origin` value that would let this page in, if the host says. */
export async function allowOriginOf(r: Response): Promise<string | undefined> {
  const j = (await r.json().catch(() => null)) as Partial<OriginRefusal> | null;
  return typeof j?.allowOrigin === 'string' && /^https?:\/\/\S+$/.test(j.allowOrigin) ? j.allowOrigin : undefined;
}

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
  if (r.status === 403) {
    const allowOrigin = await allowOriginOf(r);
    return { ok: false, why: 'origin', ...(allowOrigin ? { allowOrigin } : {}) };
  }
  if (r.status === 401 || r.status === 400) return { ok: false, why: 'bad' };
  if (r.status === 429 || r.status === 503) return { ok: false, why: 'limited', ...(retryAfter ? { retryAfter } : {}) };
  if (r.status === 404 || r.status === 405) return { ok: false, why: 'old' };
  if (!r.ok) return { ok: false, why: 'unreachable' };
  const j = (await r.json().catch(() => null)) as Partial<PairResponse> | null;
  if (!j || typeof j.token !== 'string' || !j.token || (j.role !== 'press' && j.role !== 'admin')) return { ok: false, why: 'unreachable' };
  return { ok: true, token: j.token, role: j.role };
}

/** The pairing-link fragment: `#pair` (the code entry), or `#pair=123456` (the code with it). */
export function readPairHash(hash = location.hash): { code: string } | null {
  let h = hash.trim();
  try {
    // "#pair=123%20456": a space typed into the address bar.
    h = decodeURIComponent(h);
  } catch {
    /* not percent-encoded after all */
  }
  const m = /^#pair(?:=([\d\s.-]*))?$/i.exec(h);
  return m ? { code: codeDigits(m[1] ?? '') } : null;
}

/** Strips `#pair…` from the address bar (a reload doesn't ask again). */
export function clearPairHash(): void {
  if (readPairHash()) history.replaceState(null, '', location.pathname + location.search);
}
