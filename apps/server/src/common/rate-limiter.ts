// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/rate-limiter.ts
//
// Hand-rolled in-memory token-bucket rate limiter (STATE.md P2.1/P2.12/
// P4.15, docs/PLAN.md §10 "per-IP and per-user rate limits"). NO new
// dependency — a pure, injectable-clock state machine, same shape as
// apps/worker/src/metadata/rate-limit.ts's provider rate limiter, but
// reimplemented standalone: apps/server must never import from apps/worker
// (separate deployable app, no declared package dependency between them,
// and D2's module-boundary spirit extends to not reaching across apps/).
//
// RELOCATED from apps/server/src/session/ to common/ in Phase 4 lane G1's
// P4.15 rate-limit sweep: the sweep's surfaces span all three modules
// (catalog's images.controller.ts + data-freedom.controller.ts, playback's
// hls-file/session-file/subtitle-file controllers, session's own
// auth/restricted controllers) — dependency-cruiser's module-boundary
// rules (catalog/playback/session may only share IDs, never import one
// another, CLAUDE.md invariant / D2) make it structurally impossible for
// this to keep living in session/ once catalog and playback controllers
// need it too. common/ is the established escape valve for exactly this
// kind of cross-cutting infra (DbProvider, HashService, ViewerContextProvider
// already live there for the same reason). Zero behavior change — every
// export is byte-identical to before the move; only the file's address
// changed, and every import site was updated in the same change.
//
// `KeyedRateLimiter` fans a single (capacity, refillMs) policy out across
// independent per-key buckets (key = source IP for login/refresh, userId
// for restricted-unlock, per-token identity for media GETs, ...) — first
// attempt for a new key lazily allocates a fresh, full bucket. Buckets live
// only in process memory; a restart resets every counter, which is an
// accepted tradeoff for a self-hosted single-process server (no Redis
// dependency, matching D5's Tier-0 posture).

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
 * Continuous-refill token bucket. `tryAcquire()` is pure and synchronous:
 * it either consumes a token and returns 0, or leaves the bucket untouched
 * and returns the number of milliseconds until the next token would be
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
      throw new RangeError("TokenBucket: capacity must be > 0");
    }
    if (opts.refillMs <= 0) {
      throw new RangeError("TokenBucket: refillMs must be > 0");
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

export interface RateLimitResult {
  allowed: boolean;
  /** 0 when allowed; otherwise ms until the next token is available. */
  retryAfterMs: number;
}

/** One (capacity, refillMs) policy, fanned out across independent
 *  per-key buckets (per-IP or per-user) allocated lazily on first use.
 *
 *  Security review L1 (bucket-Map growth): the Map is BOUNDED by
 *  opportunistic eviction. A bucket that has refilled to full capacity is
 *  byte-for-byte indistinguishable from the fresh bucket a returning key
 *  would lazily get anyway, so dropping it can never change any caller's
 *  observable rate-limit state — eviction is behavior-neutral by
 *  construction. attempt() sweeps at most once per `capacity * refillMs`
 *  (the time a fully-drained bucket needs to refill completely — sweeping
 *  more often could never evict anything a fresh bucket wouldn't equal),
 *  so steady-state memory is bounded by the number of DISTINCT keys seen
 *  within one refill window, not by lifetime key churn. */
export class KeyedRateLimiter {
  private opts: TokenBucketOptions;
  private buckets = new Map<string, TokenBucket>();
  private lastSweepAtMs: number;

  constructor(opts: TokenBucketOptions) {
    this.opts = opts;
    this.lastSweepAtMs = (opts.clock ?? systemClock).nowMs();
  }

  /** Ms for a drained bucket to refill fully — the eviction horizon. */
  private get sweepIntervalMs(): number {
    return this.opts.capacity * this.opts.refillMs;
  }

  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweepAtMs < this.sweepIntervalMs) return;
    this.lastSweepAtMs = nowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.peek() === bucket.capacity) {
        this.buckets.delete(key);
      }
    }
  }

  attempt(key: string): RateLimitResult {
    this.sweep((this.opts.clock ?? systemClock).nowMs());
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.opts);
      this.buckets.set(key, bucket);
    }
    const waitMs = bucket.tryAcquire();
    return { allowed: waitMs === 0, retryAfterMs: waitMs };
  }

  /** Number of tracked per-key buckets — test/introspection only. */
  get size(): number {
    return this.buckets.size;
  }

  /** Current (capacity, refillMs) policy — test/introspection only. */
  get policy(): Readonly<TokenBucketOptions> {
    return this.opts;
  }

  /**
   * Addendum A, lane S3 (STATE.md, A3/AD1 hot-reload): applies a new
   * (capacity, refillMs) policy for every FUTURE bucket check, dropping
   * every currently-tracked per-key bucket so the next `attempt()` for any
   * key lazily allocates a fresh bucket under the new policy — "applies to
   * the next bucket check", never retroactively (an in-flight caller mid-
   * burst just gets a full-capacity bucket again, never a mid-window
   * capacity change that could strand it above the new cap forever). No-op
   * if the policy is unchanged (avoids discarding live buckets — and every
   * caller's accrued burst budget — on an irrelevant settings reload for a
   * DIFFERENT key). */
  updatePolicy(opts: TokenBucketOptions): void {
    if (opts.capacity === this.opts.capacity && opts.refillMs === this.opts.refillMs) return;
    this.opts = opts;
    this.buckets = new Map();
  }
}
