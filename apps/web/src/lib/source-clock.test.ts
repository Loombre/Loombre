// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/source-clock.test.ts
//
// Pure tests for the browser-player-F6 source-clock authority model: the
// displayed position resolver that keeps VideoPlayer's clock on the
// source axis through the post-hard-seek windows where the current
// level's details are unreadable (ABR switch mid-refresh) or STALE
// (pre-seek PDTs still covering the position). The silent
// `sourceMs ?? currentTime * 1000` fallback these states used to hit is
// exactly what this module forbids.

import { describe, expect, it } from "vitest";
import type { ListedFragment } from "./source-time.js";
import {
  ANCHOR_EXTRAPOLATION_LIMIT_SEC,
  anchorAtExplicitPosition,
  anchorAtLanding,
  initialSourceClockState,
  resolveDisplayedSourceMs,
  type SourceClockState,
} from "./source-clock.js";

function frag(relurl: string, startSec: number, durationSec: number, programDateTimeMs: number | null): ListedFragment {
  return { relurl, startSec, durationSec, programDateTimeMs };
}

/** run0: presentation [0..12), source origin 3_600_000 (non-zero so the
 *  axes are visibly distinct everywhere). */
const RUN0_WINDOW: ListedFragment[] = [
  frag("run0/s000000.m4s", 0, 6, 3_600_000),
  frag("run0/s000001.m4s", 6, 6, 3_606_000),
];

/** The window after a hard seek to source 10_000 landed: run1 appended at
 *  the presentation tail. */
const LANDED_WINDOW: ListedFragment[] = [...RUN0_WINDOW, frag("run1/s000002.m4s", 12, 6, 10_000)];

const LANDING_FRAGMENT = LANDED_WINDOW[2] as ListedFragment;

describe("resolveDisplayedSourceMs", () => {
  it("keeps the presentation axis while the session has never shown a source clock (direct-play / native / pre-V8)", () => {
    const noWindow = resolveDisplayedSourceMs(initialSourceClockState(), null, 42.25);
    expect(noWindow.ms).toBe(42_250);
    expect(noWindow.axis).toBe("presentation");
    expect(noWindow.state.sawSourceClock).toBe(false);

    const clockless = resolveDisplayedSourceMs(initialSourceClockState(), [frag("s0.m4s", 0, 6, null)], 3);
    expect(clockless.ms).toBe(3_000);
    expect(clockless.axis).toBe("presentation");
  });

  it("maps through a trusted clocked window, refreshes the anchor, and raises the run floor", () => {
    const r = resolveDisplayedSourceMs(initialSourceClockState(), LANDED_WINDOW, 13.5);
    expect(r.ms).toBe(11_500);
    expect(r.axis).toBe("source-window");
    expect(r.state).toEqual({
      sawSourceClock: true,
      runFloor: 1,
      anchor: { presentationSec: 13.5, sourceMs: 11_500 },
    });
  });

  it("NEVER returns the presentation axis once a source clock has been seen — an unreadable window extrapolates from the anchor 1:1", () => {
    const mapped = resolveDisplayedSourceMs(initialSourceClockState(), LANDED_WINDOW, 13.5);
    // The ABR switch exposes a level with no details yet.
    const outage = resolveDisplayedSourceMs(mapped.state, null, 14.5);
    expect(outage.axis).toBe("source-anchor");
    expect(outage.ms).toBe(12_500); // 11_500 + (14.5 - 13.5) * 1000 — monotonic from the landed target
    // A small in-run rewind extrapolates too (the axes move 1:1 both ways).
    const rewind = resolveDisplayedSourceMs(mapped.state, null, 13.0);
    expect(rewind.ms).toBe(11_000);
  });

  it("rejects a STALE window (tops out below the run floor) even when its old-timeline PDTs cover the position", () => {
    const landed = anchorAtLanding(initialSourceClockState(), LANDING_FRAGMENT);
    // The switched-to level's details predate the seek: run0 only, whose
    // PDTs cover presentation 13.5 s with the OLD timeline. (Mapping it
    // would say 3_613_500 — the "1:04:22 on the old timeline" symptom.)
    const stale = [frag("run0/s000000.m4s", 0, 18, 3_600_000)];
    const r = resolveDisplayedSourceMs(landed, stale, 13.5);
    expect(r.axis).toBe("source-anchor");
    expect(r.ms).toBe(11_500); // landing anchor (12 s -> 10_000) + 1.5 s
    expect(r.state.runFloor).toBe(1); // the stale window never lowers the floor
  });

  it("HOLDS (ms null) rather than guess: clock seen but no anchor, or the anchor is too far to extrapolate", () => {
    // A clocked window that cannot map the position, before any anchor
    // exists: sticky flag set, nothing displayable — hold.
    const unmapped = resolveDisplayedSourceMs(initialSourceClockState(), RUN0_WINDOW, 500);
    expect(unmapped.ms).toBeNull();
    expect(unmapped.axis).toBeNull();
    expect(unmapped.state.sawSourceClock).toBe(true);

    // An anchor further than the extrapolation limit: hold, never ride it.
    const mapped = resolveDisplayedSourceMs(initialSourceClockState(), LANDED_WINDOW, 13.5);
    const far = resolveDisplayedSourceMs(mapped.state, null, 13.5 + ANCHOR_EXTRAPOLATION_LIMIT_SEC + 1);
    expect(far.ms).toBeNull();

    // ... and a later successful mapping recovers normally.
    const recovered = resolveDisplayedSourceMs(far.state, LANDED_WINDOW, 14);
    expect(recovered.ms).toBe(12_000);
    expect(recovered.axis).toBe("source-window");
  });

  it("a trusted mapping through a NEWER run raises the floor so older windows immediately become stale", () => {
    const afterRun2 = resolveDisplayedSourceMs(
      initialSourceClockState(),
      [frag("run2/s000005.m4s", 30, 6, 1_800_000)],
      31,
    );
    expect(afterRun2.state.runFloor).toBe(2);
    const throughOld = resolveDisplayedSourceMs(afterRun2.state, RUN0_WINDOW, 3);
    expect(throughOld.axis).toBe("source-anchor"); // never "source-window" through the stale run0 listing
  });
});

describe("anchorAtLanding", () => {
  it("anchors the landed fragment's own PDT/run origin and raises the floor to its run index", () => {
    const s = anchorAtLanding(initialSourceClockState(), LANDING_FRAGMENT);
    expect(s).toEqual({
      sawSourceClock: true,
      runFloor: 1,
      anchor: { presentationSec: 12, sourceMs: 10_000 },
    });
  });

  it("never lowers an already-higher floor, and ignores a fragment that cannot anchor (no PDT)", () => {
    const high: SourceClockState = { sawSourceClock: true, runFloor: 3, anchor: null };
    expect(anchorAtLanding(high, LANDING_FRAGMENT).runFloor).toBe(3);
    expect(anchorAtLanding(high, frag("run4/s9.m4s", 0, 6, null))).toEqual(high);
  });
});

describe("anchorAtExplicitPosition", () => {
  it("replaces the anchor with the soft-seek commit pair and keeps the floor", () => {
    const landed = anchorAtLanding(initialSourceClockState(), LANDING_FRAGMENT);
    const s = anchorAtExplicitPosition(landed, 4, 3_604_000);
    expect(s).toEqual({
      sawSourceClock: true,
      runFloor: 1,
      anchor: { presentationSec: 4, sourceMs: 3_604_000 },
    });
  });
});
