// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/notices/notice-time.test.ts
//
// Pure-math coverage of NG3's clock-skew formula, isolated from React so
// the exact numbers are easy to eyeball. The component-level "skewed
// clock" test (SystemNoticeProvider.test.tsx) proves the same formula is
// actually wired up end-to-end; this file pins the formula itself.

import { describe, expect, it } from "vitest";
import { computeServerOffsetMs, correctedNowMs, remainingMs } from "./notice-time.js";

describe("computeServerOffsetMs", () => {
  it("is zero when the server and local clocks agree", () => {
    expect(computeServerOffsetMs(1_000_000, 1_000_000)).toBe(0);
  });

  it("is positive when the server clock runs AHEAD of local (server='later')", () => {
    // Local system clock lags the server by 10 minutes.
    const localNow = 1_000_000;
    const serverNow = localNow + 10 * 60_000;
    expect(computeServerOffsetMs(serverNow, localNow)).toBe(10 * 60_000);
  });

  it("is negative when the server clock runs BEHIND local", () => {
    const localNow = 1_000_000;
    const serverNow = localNow - 5000;
    expect(computeServerOffsetMs(serverNow, localNow)).toBe(-5000);
  });
});

describe("correctedNowMs", () => {
  it("adds the offset to the local clock", () => {
    expect(correctedNowMs(600_000, 1_000_000)).toBe(1_600_000);
    expect(correctedNowMs(-600_000, 1_000_000)).toBe(400_000);
    expect(correctedNowMs(0, 1_000_000)).toBe(1_000_000);
  });
});

describe("remainingMs", () => {
  it("computes the naive case (no skew) as target minus now", () => {
    expect(remainingMs(1_005_000, 0, 1_000_000)).toBe(5000);
  });

  it("SKEWED CLOCK: a client whose local clock lags 10 minutes still gets the TRUE remaining time", () => {
    // Server published a notice with effectiveAtMs = serverNow + 5min.
    // This client's own wall clock is 10 minutes BEHIND the server. A
    // client that used Date.now() alone would see target - localNow =
    // 15 minutes remaining — wrong. The offset-corrected formula must
    // recover the true 5 minutes.
    const localNow = 1_000_000;
    const serverNow = localNow + 10 * 60_000;
    const offset = computeServerOffsetMs(serverNow, localNow);
    const effectiveAtMs = serverNow + 5 * 60_000;
    expect(remainingMs(effectiveAtMs, offset, localNow)).toBe(5 * 60_000);
  });

  it("SKEWED CLOCK: a client whose local clock runs 10 minutes AHEAD also gets the TRUE remaining time", () => {
    const localNow = 1_000_000;
    const serverNow = localNow - 10 * 60_000;
    const offset = computeServerOffsetMs(serverNow, localNow);
    const effectiveAtMs = serverNow + 5 * 60_000;
    expect(remainingMs(effectiveAtMs, offset, localNow)).toBe(5 * 60_000);
  });

  it("ZERO-STATE: clamps to zero once the target has passed, never negative", () => {
    expect(remainingMs(999_000, 0, 1_000_000)).toBe(0);
    expect(remainingMs(1_000_000, 0, 1_000_000)).toBe(0);
  });
});
