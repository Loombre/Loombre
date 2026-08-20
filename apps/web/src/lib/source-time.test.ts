// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/source-time.test.ts
//
// Pure tests for the V8 two-timeline model (docs/PLAYBACK.md §9.1.9;
// STATE.md "Seek model V8"). The fixture below mirrors a real served
// playlist mid-session: run0 (origin 0) partially pruned, a backward-seek
// run1 whose origin is EARLIER than run0's tail — presentation strictly
// increasing, source non-monotonic.

import { describe, expect, it } from "vitest";
import {
  armLandingWatch,
  bufferedRangesToSource,
  findLandingFragment,
  hasSourceClock,
  landingWatchExpired,
  HARD_SEEK_LANDING_TIMEOUT_MS,
  maxListedRunIndex,
  presentationToSourceMs,
  runIndexOfRelurl,
  sourceToPresentationSec,
  type ListedFragment,
} from "./source-time.js";

function frag(relurl: string, startSec: number, durationSec: number, programDateTimeMs: number | null): ListedFragment {
  return { relurl, startSec, durationSec, programDateTimeMs };
}

// Presentation [60..78): run0's surviving tail, source 60_000..78_000.
// Presentation [78..90): run1 — a BACKWARD seek to source 12_000.
const WINDOW: ListedFragment[] = [
  frag("run0/s000010.m4s", 60, 6, 60_000),
  frag("run0/s000011.m4s", 66, 6, 66_000),
  frag("run0/s000012.m4s", 72, 6, 72_000),
  frag("run1/s000013.m4s", 78, 6, 12_000),
  frag("run1/s000014.m4s", 84, 6, 18_000),
];

describe("runIndexOfRelurl / maxListedRunIndex / hasSourceClock", () => {
  it("extracts the runN prefix, including nested/relative forms", () => {
    expect(runIndexOfRelurl("run0/s000010.m4s")).toBe(0);
    expect(runIndexOfRelurl("v2/run17/s000099.m4s")).toBe(17);
    expect(runIndexOfRelurl("init.mp4")).toBeUndefined();
    expect(runIndexOfRelurl(null)).toBeUndefined();
  });
  it("maxListedRunIndex is the window's highest run; -1 when nothing matches", () => {
    expect(maxListedRunIndex(WINDOW)).toBe(1);
    expect(maxListedRunIndex([frag("x.m4s", 0, 6, null)])).toBe(-1);
    expect(maxListedRunIndex([])).toBe(-1);
  });
  it("hasSourceClock is the PDT gate", () => {
    expect(hasSourceClock(WINDOW)).toBe(true);
    expect(hasSourceClock([frag("run0/s000000.m4s", 0, 6, null)])).toBe(false);
    expect(hasSourceClock([])).toBe(false);
  });
});

describe("presentationToSourceMs (display + heartbeat mapping)", () => {
  it("maps within a fragment with the intra-fragment remainder carried through", () => {
    expect(presentationToSourceMs(WINDOW, 60)).toBe(60_000);
    expect(presentationToSourceMs(WINDOW, 63.5)).toBe(63_500);
  });
  it("maps across the discontinuity into the backward-seek run — source goes BACKWARD while presentation goes forward", () => {
    expect(presentationToSourceMs(WINDOW, 79)).toBe(13_000);
    expect(presentationToSourceMs(WINDOW, 89)).toBe(23_000);
  });
  it("the last fragment's inclusive end maps; outside the window is null, never a guess", () => {
    expect(presentationToSourceMs(WINDOW, 90)).toBe(24_000);
    expect(presentationToSourceMs(WINDOW, 59.9)).toBeNull();
    expect(presentationToSourceMs(WINDOW, 91)).toBeNull();
  });
  it("a fragment without PDT yields null (pre-V8 server)", () => {
    expect(presentationToSourceMs([frag("run0/s000000.m4s", 0, 6, null)], 3)).toBeNull();
  });
});

describe("sourceToPresentationSec (the SOFT-seek mapping — A2: LISTED, not loaded)", () => {
  it("maps a listed source position to its presentation second", () => {
    expect(sourceToPresentationSec(WINDOW, 66_000)).toBe(66);
    // 1:1 rate within a run (§9.1.6): +3s of source is +3s of presentation.
    expect(sourceToPresentationSec(WINDOW, 69_000)).toBe(69);
  });
  it("A2 design pin — listed-but-UNBUFFERED is still a soft seek: the mapping consults the LISTED window only (no buffer input exists to consult)", () => {
    // The fixture models fragments the playlist lists but nothing has
    // downloaded — this module has no buffer concept AT ALL, so a listed
    // target maps (soft) regardless. Classifying it hard would burn a
    // Tier-0 ffmpeg restart for a position already on disk.
    expect(sourceToPresentationSec(WINDOW, 13_000)).toBe(79);
  });
  it("a backward-seek run's source range maps to its LATER presentation position", () => {
    // Source 12_000 lives at presentation 78 — reaching 'earlier' content
    // means moving FORWARD in currentTime; that is the whole point.
    expect(sourceToPresentationSec(WINDOW, 12_000)).toBe(78);
  });
  it("an unlisted source position is null — the HARD-seek trigger (both directions)", () => {
    expect(sourceToPresentationSec(WINDOW, 0)).toBeNull(); // pruned head
    expect(sourceToPresentationSec(WINDOW, 30_000)).toBeNull(); // gap between runs' coverage
    expect(sourceToPresentationSec(WINDOW, 500_000)).toBeNull(); // beyond live edge
  });
});

describe("bufferedRangesToSource", () => {
  it("maps endpoints and drops ranges that don't map", () => {
    const ranges = [
      { startMs: 60_000, endMs: 66_000 }, // presentation 60..66 -> source 60_000..66_000
      { startMs: 100_000, endMs: 110_000 }, // outside the window -> dropped
    ];
    expect(bufferedRangesToSource(WINDOW, ranges)).toEqual([{ startMs: 60_000, endMs: 66_000 }]);
  });
});

describe("landing watch (hard seek, §9.1.9)", () => {
  it("arms against the window's current max run and finds ONLY a strictly-newer run whose PDT matches the clamped target", () => {
    const watch = armLandingWatch(WINDOW, 12_000, 1_000);
    // run1 covers source 12_000 but predates the watch (run index 1 is the
    // armed max) — it must NOT land, even with a perfect PDT match.
    expect(findLandingFragment(WINDOW, watch)).toBeNull();

    const afterRestart = [...WINDOW, frag("run2/s000015.m4s", 90, 6, 12_000)];
    const landed = findLandingFragment(afterRestart, watch);
    expect(landed?.relurl).toBe("run2/s000015.m4s");
    expect(landed?.startSec).toBe(90);
  });

  it("PDT alone is not enough — a newer run OUTSIDE the match window (a §9.1.4 handoff at the live edge) never lands the seek", () => {
    const watch = armLandingWatch(WINDOW, 12_000, 1_000);
    // A rung-switch handoff run continues at the live edge (source ~24s) —
    // newer run index, wrong PDT.
    const afterHandoff = [...WINDOW, frag("run2/s000015.m4s", 90, 6, 24_000)];
    expect(findLandingFragment(afterHandoff, watch)).toBeNull();
  });

  it("the keyframe-snap tolerance accepts an origin up to one GOP BEHIND the target and a rounding hair ahead", () => {
    const watch = armLandingWatch(WINDOW, 12_000, 1_000);
    const snapBehind = [...WINDOW, frag("run2/s000015.m4s", 90, 6, 12_000 - 5_500)];
    expect(findLandingFragment(snapBehind, watch)?.relurl).toBe("run2/s000015.m4s");
    const tooFarBehind = [...WINDOW, frag("run2/s000015.m4s", 90, 6, 12_000 - 7_000)];
    expect(findLandingFragment(tooFarBehind, watch)).toBeNull();
  });

  it("lands on the EARLIEST matching fragment in presentation order", () => {
    const watch = armLandingWatch(WINDOW, 12_000, 1_000);
    const twoNew = [
      ...WINDOW,
      frag("run2/s000015.m4s", 90, 6, 12_000),
      frag("run2/s000016.m4s", 96, 6, 18_000 - 6_000), // also within window via behind-tolerance
    ];
    expect(findLandingFragment(twoNew, watch)?.startSec).toBe(90);
  });

  it("re-arming replaces the watch: the newest clamped target and the CURRENT max run win (a re-seek before landing)", () => {
    const watch1 = armLandingWatch(WINDOW, 12_000, 1_000);
    // First seek's run appears…
    const afterFirst = [...WINDOW, frag("run2/s000015.m4s", 90, 6, 12_000)];
    // …but the user has already re-sought to 200_000; re-arm against the
    // CURRENT window (which now includes run2).
    const watch2 = armLandingWatch(afterFirst, 200_000, 2_000);
    // run2 (the first seek's dead run) never lands the new watch.
    expect(findLandingFragment(afterFirst, watch2)).toBeNull();
    const afterSecond = [...afterFirst, frag("run3/s000016.m4s", 96, 6, 200_000)];
    expect(findLandingFragment(afterSecond, watch2)?.relurl).toBe("run3/s000016.m4s");
    // The stale watch1 would have matched run2 — proving the re-arm is
    // what keeps the newest intent authoritative.
    expect(findLandingFragment(afterFirst, watch1)?.relurl).toBe("run2/s000015.m4s");
  });

  it("expiry is the named constant, not config", () => {
    const watch = armLandingWatch(WINDOW, 12_000, 10_000);
    expect(landingWatchExpired(watch, 10_000 + HARD_SEEK_LANDING_TIMEOUT_MS - 1)).toBe(false);
    expect(landingWatchExpired(watch, 10_000 + HARD_SEEK_LANDING_TIMEOUT_MS)).toBe(true);
  });
});
