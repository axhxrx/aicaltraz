/** Rate limiting for presses, and operator log lines for conditions that can repeat thousands of times. */

/** `take()` succeeds `burst` times at once, then at `perSec` on average. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly burst: number,
    readonly perSec: number,
    private readonly clock: () => number,
  ) {
    this.tokens = burst;
    this.last = clock();
  }

  private refill() {
    const now = this.clock();
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.last) / 1000) * this.perSec);
    this.last = now;
  }

  /** Whether a `take()` would succeed now. */
  available(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  /** Refilled completely: nothing left to remember about this source. */
  full(): boolean {
    this.refill();
    return this.tokens >= this.burst;
  }
}

/**
 * Where presses come from, for the rate limits: a press takes a token from each of `buckets` (it
 * needs one in all). A WebSocket connection has its own bucket and its address's; an HTTP client,
 * its address's (the same one, so a device can't get more by opening more connections).
 */
export interface PressSource {
  /** For log lines, e.g. "ws 192.168.1.20". */
  readonly label: string;
  readonly buckets: readonly TokenBucket[];
}

/** Buckets by key (client address), forgetting the ones that refilled when there are too many. */
export class BucketMap {
  private map = new Map<string, TokenBucket>();

  constructor(
    private readonly make: () => TokenBucket,
    private readonly max = 1024,
  ) {}

  get(key: string): TokenBucket {
    let b = this.map.get(key);
    if (b) return b;
    if (this.map.size >= this.max) {
      for (const [k, v] of this.map) if (v.full()) this.map.delete(k);
      // Still too many busy ones: forget the oldest (a Map iterates in insertion order).
      for (const k of this.map.keys()) {
        if (this.map.size < this.max) break;
        this.map.delete(k);
      }
    }
    b = this.make();
    this.map.set(key, b);
    return b;
  }

  get size() {
    return this.map.size;
  }
}

/**
 * Logs a condition that can repeat (refused presses, refused connections) at most once per
 * `windowMs`: the first time at once, then — if it went on — one line at the end of the window
 * with how many more times it happened.
 */
export class ThrottledLog {
  private until = -Infinity;
  private more = 0;
  private latest = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly log: (msg: string) => void,
    private readonly clock: () => number,
    readonly windowMs = 10_000,
  ) {}

  note(msg: string) {
    this.latest = msg;
    const now = this.clock();
    if (now >= this.until) {
      this.close();
      const more = this.more;
      this.more = 0;
      this.until = now + this.windowMs;
      this.log(more ? `${msg} (${more} more since the last report)` : msg);
      return;
    }
    this.more++;
    if (this.timer) return;
    this.timer = setTimeout(() => this.report(), Math.max(0, this.until - now));
    this.timer.unref?.();
  }

  private report() {
    this.timer = undefined;
    if (!this.more) return;
    const more = this.more;
    this.more = 0;
    this.until = this.clock() + this.windowMs;
    this.log(`${this.latest} (${more} more in the last ${Math.round(this.windowMs / 1000)} s)`);
  }

  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
