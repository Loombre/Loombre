// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/rate-limiter.spec.ts
//
// Pure unit tests (STATE.md P2.1/P2.12) for the hand-rolled in-memory
// token-bucket rate limiter — no HTTP, no Nest DI, no real sleeps. A fake
// clock is injected directly into the bucket so refill can be asserted
// deterministically (mirrors apps/worker/src/metadata/rate-limit.ts's
// pattern, reimplemented standalone here since apps/server must never
// import from apps/worker — separate deployable, no declared dependency,
// D2 module boundaries).

import { describe, expect, it } from "vitest";
import { KeyedRateLimiter, TokenBucket, type Clock } from "./rate-limiter.js";

class FakeClock implements Clock {
  private ms: number;
  constructor(startMs = 0) {
    this.ms = startMs;
  }
  nowMs(): number {
    return this.ms;
  }
  advance(byMs: number): void {
    this.ms += byMs;
  }
}

describe("TokenBucket", () => {
  it("allows up to `capacity` immediate acquisitions, then blocks", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillMs: 1000, clock });

    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(0);

    const waitMs = bucket.tryAcquire();
    expect(waitMs).toBeGreaterThan(0);
  });

  it("refills after the fake clock advances past refillMs — no real sleeps", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 1, refillMs: 1000, clock });

    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBeGreaterThan(0); // exhausted

    clock.advance(1000);
    expect(bucket.tryAcquire()).toBe(0); // refilled exactly one token
    expect(bucket.tryAcquire()).toBeGreaterThan(0); // exhausted again
  });

  it("never exceeds capacity even after a very long idle period", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillMs: 100, clock });
    clock.advance(1_000_000);
    expect(bucket.peek()).toBe(2);
  });

  it("rejects non-positive capacity/refillMs", () => {
    expect(() => new TokenBucket({ capacity: 0, refillMs: 1000 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillMs: 0 })).toThrow();
  });
});

describe("KeyedRateLimiter", () => {
  it("trips the limit for a key after `capacity` attempts, and a DIFFERENT key is unaffected", () => {
    const clock = new FakeClock();
    const limiter = new KeyedRateLimiter({ capacity: 2, refillMs: 1000, clock });

    expect(limiter.attempt("1.2.3.4").allowed).toBe(true);
    expect(limiter.attempt("1.2.3.4").allowed).toBe(true);
    const tripped = limiter.attempt("1.2.3.4");
    expect(tripped.allowed).toBe(false);
    expect(tripped.retryAfterMs).toBeGreaterThan(0);

    // A different key (different IP/user) has its own independent bucket.
    expect(limiter.attempt("9.9.9.9").allowed).toBe(true);
  });

  it("trip then refill allows again — fake clock, no real sleeps", () => {
    const clock = new FakeClock();
    const limiter = new KeyedRateLimiter({ capacity: 1, refillMs: 500, clock });

    expect(limiter.attempt("user-1").allowed).toBe(true);
    const blocked = limiter.attempt("user-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    clock.advance(500);
    const refilled = limiter.attempt("user-1");
    expect(refilled.allowed).toBe(true);
  });
});
