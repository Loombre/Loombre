// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "./compute-backoff-ms.js";

describe("computeBackoffMs", () => {
  it("returns 0 for consecutiveFailures <= 0", () => {
    expect(computeBackoffMs(0)).toBe(0);
    expect(computeBackoffMs(-1)).toBe(0);
  });

  it("scales exponentially with full jitter (random=1 gives the deterministic ceiling)", () => {
    const alwaysOne = () => 1;
    expect(computeBackoffMs(1, alwaysOne)).toBe(1_000);
    expect(computeBackoffMs(2, alwaysOne)).toBe(2_000);
    expect(computeBackoffMs(3, alwaysOne)).toBe(4_000);
    expect(computeBackoffMs(4, alwaysOne)).toBe(8_000);
  });

  it("caps at 60_000ms regardless of how large consecutiveFailures gets", () => {
    const alwaysOne = () => 1;
    expect(computeBackoffMs(10, alwaysOne)).toBe(60_000);
    expect(computeBackoffMs(1000, alwaysOne)).toBe(60_000);
    expect(computeBackoffMs(Number.MAX_SAFE_INTEGER, alwaysOne)).toBe(60_000);
  });

  it("returns 0 when random() returns 0 (full jitter's floor)", () => {
    expect(computeBackoffMs(5, () => 0)).toBe(0);
  });

  it("defaults to Math.random when no random fn is given (stays within [0, cap])", () => {
    const result = computeBackoffMs(3);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(4_000);
  });
});
