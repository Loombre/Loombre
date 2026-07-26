// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/rate-limit.spec.ts
//
// Pure unit tests for TokenBucket (deterministic, injectable clock — no
// real timers) + a thin test of acquire()'s wait-loop against a fake sleep.

import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_RATE_LIMITS, TokenBucket, acquire, type Clock } from '../../src/metadata/rate-limit.js';

class ManualClock implements Clock {
  private t = 0;
  nowMs(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

describe('TokenBucket', () => {
  it('starts full: capacity N allows N immediate acquisitions with no wait', () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 3, refillMs: 1000, clock });
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(0);
  });

  it('the (capacity+1)th immediate acquisition must wait', () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 1, refillMs: 1000, clock });
    expect(bucket.tryAcquire()).toBe(0);
    const wait = bucket.tryAcquire();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
  });

  it('does not consume a token when denying (wait > 0)', () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 1, refillMs: 1000, clock });
    bucket.tryAcquire(); // consumes the only token
    bucket.tryAcquire(); // denied
    bucket.tryAcquire(); // still denied — proves the denial above didn't leak a token back
    clock.advance(1000);
    expect(bucket.tryAcquire()).toBe(0); // exactly one token refilled
    expect(bucket.tryAcquire()).toBeGreaterThan(0);
  });

  it('refills exactly one token per refillMs elapsed, capped at capacity', () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 2, refillMs: 100, clock });
    bucket.tryAcquire();
    bucket.tryAcquire();
    expect(bucket.tryAcquire()).toBeGreaterThan(0);

    clock.advance(250); // 2 whole refill intervals elapsed
    expect(bucket.peek()).toBe(2); // capped at capacity, not 2.5
  });

  it('musicbrainz config (1 req/s) never bursts beyond 1', () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ ...PROVIDER_RATE_LIMITS.musicbrainz, clock });
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBeGreaterThan(0);
    clock.advance(999);
    expect(bucket.tryAcquire()).toBeGreaterThan(0);
    clock.advance(1);
    expect(bucket.tryAcquire()).toBe(0);
  });

  it('tmdb config allows a burst of 35 immediately', () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ ...PROVIDER_RATE_LIMITS.tmdb, clock });
    for (let i = 0; i < 35; i++) {
      expect(bucket.tryAcquire()).toBe(0);
    }
    expect(bucket.tryAcquire()).toBeGreaterThan(0);
  });

  it('tvdb config allows a burst of 10 immediately', () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ ...PROVIDER_RATE_LIMITS.tvdb, clock });
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryAcquire()).toBe(0);
    }
    expect(bucket.tryAcquire()).toBeGreaterThan(0);
  });

  it('rejects a non-positive capacity or refillMs', () => {
    expect(() => new TokenBucket({ capacity: 0, refillMs: 1000 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 1, refillMs: 0 })).toThrow(RangeError);
  });
});

describe('acquire', () => {
  it('resolves immediately when a token is available, without sleeping', async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 1, refillMs: 1000, clock });
    const sleep = vi.fn(async () => {});
    await acquire(bucket, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sleeps and retries until a token becomes available', async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket({ capacity: 1, refillMs: 100, clock });
    bucket.tryAcquire(); // drain the only token

    const sleep = vi.fn(async (ms: number) => {
      clock.advance(ms);
    });
    await acquire(bucket, sleep);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
