// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/seek-target.spec.ts
//
// Unit pin for the playable seek ceiling (browser-player-F4) — the e2e
// half (the endpoint echoing the clamped value) lives in
// test/playback-seek.e2e.spec.ts; this pins the pure arithmetic and the
// degrade cases beside the module, same pattern as resolve-caps.spec.ts.

import { describe, expect, it } from "vitest";
import { clampSeekTargetToPlayableMs, EOF_SEEK_MARGIN_MS } from "./seek-target.js";

describe("clampSeekTargetToPlayableMs — [0, durationMs − one nominal segment]", () => {
  it("passes a mid-stream target through untouched", () => {
    expect(clampSeekTargetToPlayableMs(100_000, 6_480_000)).toBe(100_000);
  });

  it("backs an at-EOF target off one nominal segment (the F4 wedge input)", () => {
    expect(clampSeekTargetToPlayableMs(6_480_000, 6_480_000)).toBe(6_480_000 - EOF_SEEK_MARGIN_MS);
  });

  it("backs a past-EOF target off the same way", () => {
    expect(clampSeekTargetToPlayableMs(99_999_999_999, 6_480_000)).toBe(6_480_000 - EOF_SEEK_MARGIN_MS);
  });

  it("a target exactly at the ceiling is untouched", () => {
    expect(clampSeekTargetToPlayableMs(6_474_000, 6_480_000)).toBe(6_474_000);
  });

  it("a clip shorter than one segment clamps to 0 — restart from the top IS its final segment", () => {
    expect(clampSeekTargetToPlayableMs(2_500, 3_000)).toBe(0);
  });

  it("keeps the lower bound only for an unprobed file, like clampSeekTargetMs", () => {
    expect(clampSeekTargetToPlayableMs(999_999_999, null)).toBe(999_999_999);
    expect(clampSeekTargetToPlayableMs(-10, null)).toBe(0);
    expect(clampSeekTargetToPlayableMs(5_000, Number.NaN)).toBe(5_000);
    expect(clampSeekTargetToPlayableMs(5_000, 0)).toBe(5_000);
  });

  it("still floors negatives/NaN at 0 through the base clamp", () => {
    expect(clampSeekTargetToPlayableMs(-500, 6_480_000)).toBe(0);
    expect(clampSeekTargetToPlayableMs(Number.NaN, 6_480_000)).toBe(0);
  });
});
