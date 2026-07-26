// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/rate-limit.ts
//
// Per-provider token-bucket rate limiting (P1.6). The bucket itself is a
// pure state machine driven entirely by an injected clock — no timers, no
// I/O — so its refill/acquire arithmetic is unit-testable deterministically.
// `acquire()` is the only place a real `setTimeout`-based sleep appears, and
// even that accepts an injectable sleep function for tests that want to
// assert on wait durations without actually waiting.

export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

export interface TokenBucketOptions {
  /** Maximum tokens the bucket can hold (burst size). */
  capacity: number;
  /** Milliseconds to accrue one additional token. */
  refillMs: number;
  clock?: Clock;
}

/**
 * Continuous-refill token bucket. `tryAcquire()` is pure and synchronous: it
 * either consumes a token and returns 0, or leaves the bucket untouched and
 * returns the number of milliseconds until the next token would be
 * available.
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillMs: number;
  private readonly clock: Clock;
  private tokens: number;
  private lastRefillAtMs: number;

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity <= 0) {
      throw new RangeError('TokenBucket: capacity must be > 0');
    }
    if (opts.refillMs <= 0) {
      throw new RangeError('TokenBucket: refillMs must be > 0');
    }
    this.capacity = opts.capacity;
    this.refillMs = opts.refillMs;
    this.clock = opts.clock ?? systemClock;
    this.tokens = opts.capacity;
    this.lastRefillAtMs = this.clock.nowMs();
  }

  private refill(): void {
    const now = this.clock.nowMs();
    const elapsed = now - this.lastRefillAtMs;
    if (elapsed < this.refillMs) return;
    const wholeTokens = Math.floor(elapsed / this.refillMs);
    if (wholeTokens <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + wholeTokens);
    this.lastRefillAtMs += wholeTokens * this.refillMs;
  }

  /** Returns 0 and consumes a token if one is available now; otherwise
   *  returns the ms to wait before retrying, without consuming anything. */
  tryAcquire(): number {
    this.refill();
    if (this.tokens > 0) {
      this.tokens -= 1;
      return 0;
    }
    const now = this.clock.nowMs();
    const elapsedSinceRefill = now - this.lastRefillAtMs;
    return Math.max(1, this.refillMs - elapsedSinceRefill);
  }

  /** Current token count — test/introspection only. */
  peek(): number {
    this.refill();
    return this.tokens;
  }
}

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Blocks (via `sleep`) until `bucket` yields a token, then consumes it. */
export async function acquire(bucket: TokenBucket, sleep: Sleep = defaultSleep): Promise<void> {
  for (;;) {
    const waitMs = bucket.tryAcquire();
    if (waitMs === 0) return;
    await sleep(waitMs);
  }
}

/**
 * Per-provider rate-limit configs (P1.6):
 *   - MusicBrainz: 1 req/s is their documented hard rule — capacity 1 means
 *     this provider never bursts, matching the letter of that rule exactly.
 *   - TMDB: 35 req/10s per their documented limit — modeled as a bucket of
 *     capacity 35 that refills fully over 10s (a burst-then-cooldown
 *     approximation of their sliding window, conservative in our favor).
 *   - TVDB: no official published number as of writing; 10 req/s is this
 *     project's own conservative ceiling.
 */
export const PROVIDER_RATE_LIMITS = {
  musicbrainz: { capacity: 1, refillMs: 1_000 },
  tmdb: { capacity: 35, refillMs: 10_000 / 35 },
  tvdb: { capacity: 10, refillMs: 1_000 / 10 },
} as const satisfies Record<string, TokenBucketOptions>;
