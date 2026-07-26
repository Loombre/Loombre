// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/backoff.spec.ts

import { describe, expect, it } from "vitest";
import { computeBackoffMs, isRetryDue } from "../../src/plugin-delivery/backoff.js";
import { LPP_DELIVERY_BACKOFF_BASE_MS, LPP_DELIVERY_BACKOFF_MAX_MS } from "../../src/plugin-delivery/constants.js";

describe("computeBackoffMs", () => {
  it("is 0 for zero (or negative) consecutive failures — no backoff needed", () => {
    expect(computeBackoffMs(0)).toBe(0);
    expect(computeBackoffMs(-1)).toBe(0);
  });

  it("grows monotonically with consecutive failures (at max jitter, random=1)", () => {
    const at = (n: number) => computeBackoffMs(n, () => 1);
    expect(at(1)).toBeLessThanOrEqual(at(2));
    expect(at(2)).toBeLessThanOrEqual(at(3));
    expect(at(3)).toBeLessThanOrEqual(at(4));
  });

  it("never exceeds LPP_DELIVERY_BACKOFF_MAX_MS even at absurd failure counts", () => {
    expect(computeBackoffMs(1000, () => 1)).toBeLessThanOrEqual(LPP_DELIVERY_BACKOFF_MAX_MS);
    expect(computeBackoffMs(1000, () => 0.999)).toBeLessThanOrEqual(LPP_DELIVERY_BACKOFF_MAX_MS);
  });

  it("first failure's max-jitter backoff equals the base delay", () => {
    expect(computeBackoffMs(1, () => 1)).toBe(LPP_DELIVERY_BACKOFF_BASE_MS);
  });

  it("full jitter: random()=0 always yields 0 backoff regardless of failure count", () => {
    expect(computeBackoffMs(1, () => 0)).toBe(0);
    expect(computeBackoffMs(10, () => 0)).toBe(0);
  });
});

describe("isRetryDue", () => {
  it("always due when there has been no prior attempt", () => {
    expect(isRetryDue(3, null, 1_000, () => 1)).toBe(true);
  });

  it("not due when elapsed time is less than the (max-jitter) backoff window", () => {
    const lastAttemptMs = 1_000;
    const nowMs = lastAttemptMs + LPP_DELIVERY_BACKOFF_BASE_MS - 1;
    expect(isRetryDue(1, lastAttemptMs, nowMs, () => 1)).toBe(false);
  });

  it("due once elapsed time reaches the (max-jitter) backoff window", () => {
    const lastAttemptMs = 1_000;
    const nowMs = lastAttemptMs + LPP_DELIVERY_BACKOFF_BASE_MS;
    expect(isRetryDue(1, lastAttemptMs, nowMs, () => 1)).toBe(true);
  });

  it("zero consecutive failures is always due regardless of elapsed time", () => {
    expect(isRetryDue(0, 999_999_999, 1_000_000_000, () => 1)).toBe(true);
  });
});
