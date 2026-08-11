// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/served-playlist.spec.ts
//
// Pure tests for the two SERVE-TIME tags this layer adds on top of what the
// worker wrote: `EXT-X-MEDIA-SEQUENCE` (Wave A) and, new with Wave C2,
// `EXT-X-DISCONTINUITY-SEQUENCE` (docs/PLAYBACK.md §9.1.5 rule 3).
//
// Both exist for the same reason and fail the same way: retention prunes
// from the FRONT of the served playlist, and RFC 8216 reads BOTH absent tags
// as 0. Without the media-sequence tag every prune silently renumbers the
// playlist from the client's point of view; without the discontinuity-
// sequence tag, pruning a whole RUN out of the head desynchronizes hls.js's
// own discontinuity counter (`cc`), which it uses to decide whether a
// fragment belongs to the timeline it is currently buffering.

import { describe, expect, it } from "vitest";
import { clampSeekTargetMs, withPlaylistSequenceTags } from "./served-playlist.js";

/** Two runs, nothing pruned — exactly what the worker writes. */
const UNPRUNED = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:6",
  '#EXT-X-MAP:URI="run0/init.mp4"',
  "#EXTINF:6.000000,",
  "run0/s000000.m4s",
  "#EXTINF:6.000000,",
  "run0/s000001.m4s",
  "#EXT-X-DISCONTINUITY",
  '#EXT-X-MAP:URI="run1/init.mp4"',
  "#EXTINF:6.000000,",
  "run1/s000002.m4s",
  "",
].join("\n");

/** run0 has aged out entirely; the head is now run1's first segment. */
const RUN0_FULLY_PRUNED = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:6",
  '#EXT-X-MAP:URI="run1/init.mp4"',
  "#EXTINF:6.000000,",
  "run1/s000002.m4s",
  "#EXTINF:6.000000,",
  "run1/s000003.m4s",
  "",
].join("\n");

/** The head has been pruned WITHIN run 0 — segments are gone but no whole
 *  run is, so the discontinuity counter has not moved. */
const HEAD_PRUNED_SAME_RUN = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:6",
  '#EXT-X-MAP:URI="run0/init.mp4"',
  "#EXTINF:6.000000,",
  "run0/s000005.m4s",
  "",
].join("\n");

describe("withPlaylistSequenceTags: EXT-X-MEDIA-SEQUENCE (Wave A, unchanged)", () => {
  it("an UNPRUNED playlist is byte-identical to what the worker wrote", () => {
    expect(withPlaylistSequenceTags(UNPRUNED)).toBe(UNPRUNED);
  });

  it("emits the first surviving segment's own absolute index once the head is pruned", () => {
    expect(withPlaylistSequenceTags(HEAD_PRUNED_SAME_RUN)).toContain("#EXT-X-MEDIA-SEQUENCE:5");
  });

  it("never emits :0 — absent already means 0, and the tag would be pure noise", () => {
    expect(withPlaylistSequenceTags(UNPRUNED)).not.toContain("#EXT-X-MEDIA-SEQUENCE");
  });
});

describe("withPlaylistSequenceTags: EXT-X-DISCONTINUITY-SEQUENCE (§9.1.5 rule 3)", () => {
  it("emits the first listed segment's OWN run index once a whole run has been pruned", () => {
    // Wholly-pruned runs always form a PREFIX (retention prunes from the
    // front and runs are sequential), so the count of discontinuities the
    // client can no longer see IS the first surviving segment's run index.
    expect(withPlaylistSequenceTags(RUN0_FULLY_PRUNED)).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:1");
  });

  it("is ABSENT while the first listed segment still belongs to run 0", () => {
    expect(withPlaylistSequenceTags(HEAD_PRUNED_SAME_RUN)).not.toContain("#EXT-X-DISCONTINUITY-SEQUENCE");
    expect(withPlaylistSequenceTags(UNPRUNED)).not.toContain("#EXT-X-DISCONTINUITY-SEQUENCE");
  });

  it("both tags appear together when the head is pruned across a run boundary", () => {
    const out = withPlaylistSequenceTags(RUN0_FULLY_PRUNED);
    expect(out).toContain("#EXT-X-MEDIA-SEQUENCE:2");
    expect(out).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:1");
  });

  it("counts multiple wholly-pruned runs, not just one", () => {
    const runsPruned = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:6",
      '#EXT-X-MAP:URI="run4/init.mp4"',
      "#EXTINF:6.000000,",
      "run4/s000100.m4s",
      "",
    ].join("\n");
    expect(withPlaylistSequenceTags(runsPruned)).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:4");
  });

  it("inserts both tags into the HEADER, before any segment line", () => {
    const out = withPlaylistSequenceTags(RUN0_FULLY_PRUNED);
    const firstSegment = out.indexOf("run1/s000002.m4s");
    expect(out.indexOf("#EXT-X-MEDIA-SEQUENCE")).toBeLessThan(firstSegment);
    expect(out.indexOf("#EXT-X-DISCONTINUITY-SEQUENCE")).toBeLessThan(firstSegment);
  });

  it("is idempotent — re-tagging an already-tagged playlist changes nothing", () => {
    const once = withPlaylistSequenceTags(RUN0_FULLY_PRUNED);
    expect(withPlaylistSequenceTags(once)).toBe(once);
  });

  it("preserves the terminal EXT-X-ENDLIST the worker wrote (§9.1.5 rule 4)", () => {
    const ended = `${RUN0_FULLY_PRUNED}#EXT-X-ENDLIST\n`;
    const out = withPlaylistSequenceTags(ended);
    expect(out.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
    expect(out).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:1");
  });

  it("degrades to the input on an unparseable playlist rather than throwing", () => {
    expect(withPlaylistSequenceTags("")).toBe("");
    expect(withPlaylistSequenceTags("not a playlist")).toBe("not a playlist");
  });
});

// D-1b (R1 coverage note): clampSeekTargetMs was pinned only at the e2e layer.
// A pure unit pin for the [0, durationMs] clamp itself, so the boundary math
// can't silently drift without an e2e round-trip catching it.
describe("clampSeekTargetMs: [0, durationMs]", () => {
  it("passes an in-range target through, rounded to a whole millisecond", () => {
    expect(clampSeekTargetMs(1234.6, 60_000)).toBe(1235);
  });

  it("clamps a negative target up to the lower bound 0", () => {
    expect(clampSeekTargetMs(-500, 60_000)).toBe(0);
  });

  it("clamps a target past the end down to durationMs (the upper bound)", () => {
    expect(clampSeekTargetMs(75_000, 60_000)).toBe(60_000);
    expect(clampSeekTargetMs(60_000, 60_000)).toBe(60_000); // the boundary itself is allowed
  });

  it("applies ONLY the lower bound when durationMs is null (an unprobed file) — no ceiling to a duration nobody measured", () => {
    expect(clampSeekTargetMs(999_999_999, null)).toBe(999_999_999);
    expect(clampSeekTargetMs(-10, null)).toBe(0);
  });

  it("treats a non-positive or non-finite durationMs the same as null (lower bound only)", () => {
    expect(clampSeekTargetMs(5_000, 0)).toBe(5_000);
    expect(clampSeekTargetMs(5_000, -1)).toBe(5_000);
    expect(clampSeekTargetMs(5_000, Number.POSITIVE_INFINITY)).toBe(5_000);
    expect(clampSeekTargetMs(5_000, Number.NaN)).toBe(5_000);
  });

  it("a non-finite target collapses to 0 rather than propagating NaN/Infinity into the clamp", () => {
    expect(clampSeekTargetMs(Number.NaN, 60_000)).toBe(0);
    expect(clampSeekTargetMs(Number.POSITIVE_INFINITY, 60_000)).toBe(0);
  });
});
