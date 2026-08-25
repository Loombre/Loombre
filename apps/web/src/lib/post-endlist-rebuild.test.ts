// SPDX-License-Identifier: AGPL-3.0-only

// d3-a2 (post-ENDLIST seek family): once an hls.js session has parsed an
// ENDLIST playlist, its MSE pipeline is POISONED for every later hard
// seek, in two independent ways the 2026-08-20/21 QA verify runs caught
// live:
//   1. `mediaSource.endOfStream()` truncated the MediaSource duration to
//      the buffered end, so the landing's `currentTime` assignment clamps
//      short of the seek-spawned run's presentation start and the stream
//      controller (parked in State.ENDED) never fetches the new run at
//      all (browser-player-F4-residual: requested stuck 28 vs produced
//      39; and the verify/gap-F4 99.5% seek that fired 'ended' with 0 s
//      watched).
//   2. hls.js's FragmentTracker keeps the COMPLETED run's tail as its
//      `endListFragments` entry forever (nothing removes it on an
//      un-ending merge), so a LATER seek whose new run also reaches
//      ENDLIST satisfies `isEndListAppended` via the STALE entity the
//      moment the new details merge — BUFFER_EOS fires after ONE new-run
//      segment and the element 'ended's ~20 s early with segments never
//      requested (verify/browser-player-F4: run3/s000067 consumed,
//      s000068-71 never fetched).
// Both live in hls.js-internal state the app cannot reach — the ONE
// public lever that clears both is a media re-attach (detachMedia →
// attachMedia rebuilds a fresh MediaSource AND runs the tracker's
// removeAllFragments), the same lever hls.js's own recoverMediaError()
// uses. This module owns that rebuild sequence; VideoPlayer triggers it
// on a hard-seek 202 when the session has parsed ENDLIST since the last
// rebuild.

import { describe, expect, it } from "vitest";
import {
  listedWindowEndSec,
  rebuildMsePipelineForHardSeek,
  type RebuildableHls,
  type RebuildableMedia,
} from "./post-endlist-rebuild.js";
import type { ListedFragment } from "./source-time.js";

function frag(startSec: number, durationSec: number): ListedFragment {
  return { programDateTimeMs: startSec * 1000, startSec, durationSec, relurl: `run0/s${startSec}.m4s` };
}

function makeHls(levels: RebuildableHls["levels"] = []): RebuildableHls & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    levels,
    detachMedia: () => calls.push("detachMedia"),
    attachMedia: () => calls.push("attachMedia"),
    startLoad: (pos?: number, skip?: boolean) => calls.push(`startLoad(${pos},${skip})`),
  };
}

function makeMedia(overrides: Partial<RebuildableMedia> = {}): RebuildableMedia & { plays: number } {
  const media = {
    plays: 0,
    paused: true,
    ended: false,
    currentTime: 0,
    play(): Promise<void> {
      media.plays += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
  return media;
}

describe("listedWindowEndSec", () => {
  it("is the last listed fragment's presentation end — where the seek-spawned run will append", () => {
    expect(listedWindowEndSec([frag(0, 6), frag(6, 6), frag(12, 2.5)])).toBe(14.5);
  });

  it("is null with no readable window (fresh attach, details missing) — callers fall back to the live edge", () => {
    expect(listedWindowEndSec(null)).toBeNull();
    expect(listedWindowEndSec([])).toBeNull();
  });
});

describe("rebuildMsePipelineForHardSeek", () => {
  it("detaches, re-attaches, re-opens ENDLIST-frozen levels, and restarts loading at the window tail WITHOUT the media-seek side effect", () => {
    const details = { live: false };
    const hls = makeHls([{ details }]);
    const media = makeMedia();
    rebuildMsePipelineForHardSeek(hls, media, 14.5);
    // Order is load-bearing: a startLoad against the torn-down attach is
    // dropped by hls.js, and attachMedia on a still-attached instance
    // warns and detaches internally.
    expect(hls.calls).toEqual(["detachMedia", "attachMedia", "startLoad(14.5,true)"]);
    // The frozen level must be re-opened or shouldLoadPlaylist refuses
    // every reload of the un-ended playlist (same rule as the nudge).
    expect(details.live).toBe(true);
    // skipSeekToStartPosition=true is REQUIRED: after a detach,
    // `_hasEnoughToStart` is false again, so a bare startLoad would arm
    // seekToStartPos and yank currentTime to the ABANDONED pre-seek
    // position on the first append, fighting the landing's assignment.
  });

  it("parks the element's default start position at the window tail so pre-landing loads happen where the new run appends", () => {
    const hls = makeHls();
    const media = makeMedia();
    rebuildMsePipelineForHardSeek(hls, media, 14.5);
    expect(media.currentTime).toBe(14.5);
  });

  it("falls back to the live edge (-1) when no window is readable, and leaves currentTime alone", () => {
    const hls = makeHls();
    const media = makeMedia({ currentTime: 7 });
    rebuildMsePipelineForHardSeek(hls, media, null);
    expect(hls.calls).toEqual(["detachMedia", "attachMedia", "startLoad(-1,true)"]);
    expect(media.currentTime).toBe(7);
  });

  it("a PLAYING viewer's intent is returned as resumePlay — the re-attach empties the element, so the caller re-issues play() at landing time", () => {
    const hls = makeHls();
    const media = makeMedia({ paused: false });
    expect(rebuildMsePipelineForHardSeek(hls, media, null)).toEqual({ resumePlay: true });
  });

  it("a seek from the fully-ENDED state reports resumePlay — the whole point of the residual finding is that this seek PLAYS", () => {
    const hls = makeHls();
    // Chrome's natural EOF: 'pause' fires before 'ended', so the element
    // reads paused=true AND ended=true.
    const media = makeMedia({ paused: true, ended: true });
    expect(rebuildMsePipelineForHardSeek(hls, media, null)).toEqual({ resumePlay: true });
  });

  it("a viewer who deliberately PAUSED mid-stream stays paused — same contract as a non-rebuilt hard seek", () => {
    const hls = makeHls();
    const media = makeMedia({ paused: true, ended: false });
    expect(rebuildMsePipelineForHardSeek(hls, media, null)).toEqual({ resumePlay: false });
  });

  it("the rebuild itself NEVER calls play() — a play issued here is aborted by the fresh attach's own load request (observed live: the landing sat paused)", () => {
    const hls = makeHls();
    const media = makeMedia({ paused: false, ended: false });
    rebuildMsePipelineForHardSeek(hls, media, 10);
    expect(media.plays).toBe(0);
  });
});
