// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/watched-progress.test.ts
//
// gap-F6: the pure predicate behind the player's watched-position gate —
// progress writes need real playback advancement, not a relocated origin.
// The component-level halves (heartbeat/unload flushes actually suppressed,
// user seeks still writing) live in VideoPlayer.test.tsx's "phantom
// heartbeat progress (gap-F6)" describe.

import { describe, expect, it } from "vitest";
import { isRealPlaybackAdvancement, isSourceContinuous, MAX_REAL_ADVANCEMENT_STEP_SEC, MAX_SOURCE_STEP_MS } from "./watched-progress.js";

describe("isRealPlaybackAdvancement (gap-F6)", () => {
  it("a small forward step while playing with displayable data IS advancement", () => {
    expect(isRealPlaybackAdvancement(5.75, 6.0, 4, false)).toBe(true);
  });

  it("the first sample is a baseline, never advancement", () => {
    expect(isRealPlaybackAdvancement(null, 42, 4, false)).toBe(false);
  });

  it("a frozen clock is not advancement — the observed wedge sat at 0 forever", () => {
    expect(isRealPlaybackAdvancement(0, 0, 4, false)).toBe(false);
  });

  it("a backward step is not advancement", () => {
    expect(isRealPlaybackAdvancement(6.0, 5.75, 4, false)).toBe(false);
  });

  it("a discontinuity-sized jump is not advancement — that is a seek or a relocation", () => {
    expect(isRealPlaybackAdvancement(0, MAX_REAL_ADVANCEMENT_STEP_SEC + 0.01, 4, false)).toBe(false);
    expect(isRealPlaybackAdvancement(0, 451, 4, false)).toBe(false);
  });

  it("a step at exactly the cap still counts (boundary inclusive)", () => {
    expect(isRealPlaybackAdvancement(10, 10 + MAX_REAL_ADVANCEMENT_STEP_SEC, 4, false)).toBe(true);
  });

  it("readyState below HAVE_CURRENT_DATA is not advancement — nothing is displayed (the wedge's readyState 1)", () => {
    expect(isRealPlaybackAdvancement(5.75, 6.0, 1, false)).toBe(false);
    expect(isRealPlaybackAdvancement(5.75, 6.0, 0, false)).toBe(false);
  });

  it("HAVE_CURRENT_DATA (2) is enough — playback can momentarily dip to it", () => {
    expect(isRealPlaybackAdvancement(5.75, 6.0, 2, false)).toBe(true);
  });

  it("a paused element's clock movement is not advancement — that is a seek/assignment, handled as intent", () => {
    expect(isRealPlaybackAdvancement(5.75, 6.0, 4, true)).toBe(false);
  });
});

describe("isSourceContinuous (gap-F6, second phantom flavor)", () => {
  it("ordinary playback is continuous with the last watched position", () => {
    expect(isSourceContinuous(12_000, 12_250, 0)).toBe(true);
  });

  it("bootstraps from the intended start when nothing was watched yet", () => {
    expect(isSourceContinuous(null, 500, 0)).toBe(true);
    expect(isSourceContinuous(null, 120_400, 120_000)).toBe(true);
  });

  it("a relocated mapping is NOT continuous — genuine advancement of mis-mapped positions must not launder into progress", () => {
    // Observed live: presentation ~12s of actually-buffered content mapped
    // through a relocated run's PDT origin to source ~412s.
    expect(isSourceContinuous(12_000, 412_000, 0)).toBe(false);
    expect(isSourceContinuous(null, 412_000, 0)).toBe(false);
  });

  it("the tolerance is MAX_SOURCE_STEP_MS, inclusive, in both directions", () => {
    expect(isSourceContinuous(100_000, 100_000 + MAX_SOURCE_STEP_MS, 0)).toBe(true);
    expect(isSourceContinuous(100_000, 100_000 - MAX_SOURCE_STEP_MS, 0)).toBe(true);
    expect(isSourceContinuous(100_000, 100_000 + MAX_SOURCE_STEP_MS + 1, 0)).toBe(false);
  });
});
