// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/duration-adoption.test.ts
//
// d3-a4 (A/gap-F10-adjacent, P2): the element-duration adoption rule,
// extracted pure. Live failure: on a relocated playlist (segment numbering
// continuing past nominal EOF) the element's duration is the served
// playlist's cumulative PRESENTATION extent — growth-only adoption took
// 1810859ms on the 586s Idol and persisted it via PUT /progress; worse,
// the adopted value was hls.js's float duration*1000, so every subsequent
// heartbeat 422'd and progress writes silently stopped. The rule is now:
// integer ms always, source-axis authority (sawSourceClock) wins, and
// non-direct-play growth is plausibility-bounded against the session's
// probed duration.

import { describe, expect, it } from "vitest";
import { adoptableDurationMs, DURATION_PLAUSIBILITY_SLACK_MS } from "./duration-adoption.js";

function ctx(overrides: Partial<Parameters<typeof adoptableDurationMs>[1]> = {}): Parameters<typeof adoptableDurationMs>[1] {
  return {
    currentMs: 600_000,
    isDirectPlay: false,
    sawSourceClock: false,
    probedDurationMs: 600_000,
    ...overrides,
  };
}

describe("adoptableDurationMs (d3-a4)", () => {
  it("a non-finite element duration is never adopted", () => {
    expect(adoptableDurationMs(Number.NaN, ctx())).toBeNull();
    expect(adoptableDurationMs(Number.POSITIVE_INFINITY, ctx())).toBeNull();
  });

  it("always yields INTEGER ms — the float that 422'd every later heartbeat", () => {
    // ~773.35s * 1000 is the observed live fractional shape (773347.5).
    expect(adoptableDurationMs(773.3477, ctx({ currentMs: 773_347, probedDurationMs: 773_347 }))).toBe(773_348);
    expect(adoptableDurationMs(500.2, ctx({ isDirectPlay: true }))).toBe(500_200);
  });

  it("direct-play adopts unconditionally — growth AND shrinkage (Opus Finding F preserved)", () => {
    expect(adoptableDurationMs(500, ctx({ isDirectPlay: true }))).toBe(500_000);
    expect(adoptableDurationMs(700, ctx({ isDirectPlay: true }))).toBe(700_000);
  });

  it("once the session has shown the V8 source clock, the presentation extent is never adopted (gap-F6 round 3 preserved)", () => {
    expect(adoptableDurationMs(700, ctx({ sawSourceClock: true }))).toBeNull();
  });

  it("non-direct-play stays growth-only — a partial event playlist extent never clobbers the probe", () => {
    expect(adoptableDurationMs(24, ctx())).toBeNull();
    expect(adoptableDurationMs(600, ctx())).toBeNull(); // equal is not growth
  });

  it("growth beyond the probed duration + slack is implausible — the relocated-playlist extent (1810.859s over a 600s probe)", () => {
    expect(adoptableDurationMs(1810.859, ctx())).toBeNull();
  });

  it("growth within the slack is legitimate (EXTINF rounding topping the probe by a fraction) and adopted as integer", () => {
    expect(adoptableDurationMs(600.7503, ctx())).toBe(600_750);
    // Boundary: exactly probe + slack is still plausible.
    expect(adoptableDurationMs((600_000 + DURATION_PLAUSIBILITY_SLACK_MS) / 1000, ctx())).toBe(600_000 + DURATION_PLAUSIBILITY_SLACK_MS);
    expect(adoptableDurationMs((600_000 + DURATION_PLAUSIBILITY_SLACK_MS + 1000) / 1000, ctx())).toBeNull();
  });

  it("with no probed duration there is no plausibility bound — growth governs (pre-V8 event playlist extending)", () => {
    expect(adoptableDurationMs(1810.859, ctx({ probedDurationMs: null }))).toBe(1_810_859);
    expect(adoptableDurationMs(1810.859, ctx({ probedDurationMs: null, currentMs: null }))).toBe(1_810_859);
  });
});
