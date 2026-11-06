/**
 * One-time pairing codes: how a phone becomes an admin (or press) device without typing a
 * 43-character token. The host prints one at startup (`--no-pair-code`: not); an admin device can
 * make more (POST /api/pair-code). Another device trades one for a token (POST /api/pair).
 *
 * A code is 6 random digits, valid 10 minutes, used once; at most MAX_PAIR_CODES are valid at a
 * time. Guesses are rate limited per client address and over all addresses together, and every
 * code is compared (in constant time) on every attempt. Why those numbers: docs/DESIGN.md, Pairing.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Role } from '../core/protocol.ts';
import { BucketMap, ThrottledLog, TokenBucket } from './limits.ts';

export const PAIR_CODE_DIGITS = 6;
export const PAIR_CODE_TTL_MS = 10 * 60_000;
/** Codes valid at once: each one more target for a guess. Making one more drops the oldest. */
export const MAX_PAIR_CODES = 3;

/** Attempts (right or wrong): per client address, and over all of them together. */
export interface PairLimits {
  addressBurst: number;
  addressPerMin: number;
  burst: number;
  perMin: number;
}
export const PAIR_LIMITS: PairLimits = { addressBurst: 5, addressPerMin: 5, burst: 10, perMin: 20 };

/** A code as POST /api/pair-code answers it. `expiresAt`: host clock, epoch ms. */
export interface PairCode {
  code: string;
  role: Role;
  expiresAt: number;
}

export type PairResult = { ok: true; role: Role } | { ok: false; why: 'wrong' } | { ok: false; why: 'limited'; retryAfterSec: number };

/** "123 456": how people read a code out and type it. */
export const formatCode = (code: string) => code.replace(/^(\d{3})(\d{3})$/, '$1 $2');

/** The digits someone typed: "123 456", "123-456" and "123.456" are all 123456. */
const normalize = (input: string) => input.slice(0, 64).replace(/[\s\-.·]/g, '');
const digest = (s: string) => createHash('sha256').update(s).digest();

export interface PairingOptions {
  /** Epoch ms (expiresAt as clients show it). */
  now?: () => number;
  /** Monotonic ms (expiry, rate limits): setting the clock neither extends nor ends a code. */
  clock?: () => number;
  ttlMs?: number;
  limits?: Partial<PairLimits>;
  log?: (msg: string) => void;
}

export class Pairing {
  private codes: { digest: Buffer; role: Role; expiresAt: number; deadline: number }[] = [];
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly limits: PairLimits;
  private readonly all: TokenBucket;
  private readonly perAddress: BucketMap;
  private readonly wrongLog: ThrottledLog;
  private readonly limitedLog: ThrottledLog;

  constructor(private readonly opts: PairingOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.clock = opts.clock ?? (() => performance.now());
    this.ttlMs = opts.ttlMs ?? PAIR_CODE_TTL_MS;
    this.limits = { ...PAIR_LIMITS, ...opts.limits };
    this.all = new TokenBucket(this.limits.burst, this.limits.perMin / 60, this.clock);
    this.perAddress = new BucketMap(() => new TokenBucket(this.limits.addressBurst, this.limits.addressPerMin / 60, this.clock));
    const log = (m: string) => this.opts.log?.(m);
    this.wrongLog = new ThrottledLog(log, this.clock);
    this.limitedLog = new ThrottledLog(log, this.clock);
  }

  /** A new code for `role`. The oldest valid one goes if MAX_PAIR_CODES are out already. */
  mint(role: Role = 'admin'): PairCode {
    this.prune();
    let code: string;
    do code = String(randomInt(0, 10 ** PAIR_CODE_DIGITS)).padStart(PAIR_CODE_DIGITS, '0');
    while (this.codes.some((c) => timingSafeEqual(c.digest, digest(code))));
    const expiresAt = this.now() + this.ttlMs;
    this.codes.push({ digest: digest(code), role, expiresAt, deadline: this.clock() + this.ttlMs });
    while (this.codes.length > MAX_PAIR_CODES) this.codes.shift();
    return { code, role, expiresAt };
  }

  /**
   * Trade `input` for a role: right → the code is gone (used once); wrong, used or expired →
   * `wrong` (which one is not said); too many attempts from `address`, or from everyone → `limited`
   * (nothing compared).
   */
  redeem(input: string, address: string): PairResult {
    this.prune();
    const mine = this.perAddress.get(address);
    if (!mine.available() || !this.all.available()) {
      this.limitedLog.note(
        `refusing pairing attempts${mine.available() ? '' : ` from ${address}`}: too many (at most ${this.limits.addressPerMin} a minute per device, ${this.limits.perMin} a minute from all)`,
      );
      // Whole ms first: 1 / (5/60) is 12.000000000000002 s.
      return { ok: false, why: 'limited', retryAfterSec: Math.max(1, Math.ceil(Math.round(Math.max(mine.waitMs(), this.all.waitMs())) / 1000)) };
    }
    mine.take();
    this.all.take();
    // Every code is compared, the right one or not, so the time taken says nothing about any of them.
    const d = digest(normalize(input));
    let hit = -1;
    this.codes.forEach((c, i) => {
      if (timingSafeEqual(c.digest, d)) hit = i;
    });
    if (hit < 0) {
      this.wrongLog.note(`wrong pairing code from ${address}`);
      return { ok: false, why: 'wrong' };
    }
    const [used] = this.codes.splice(hit, 1);
    this.opts.log?.(`paired a device as ${used!.role} with a pairing code (from ${address})`);
    return { ok: true, role: used!.role };
  }

  /** Codes valid now. */
  get size(): number {
    this.prune();
    return this.codes.length;
  }

  close() {
    this.wrongLog.close();
    this.limitedLog.close();
  }

  private prune() {
    const t = this.clock();
    this.codes = this.codes.filter((c) => c.deadline > t);
  }
}
