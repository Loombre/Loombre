// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/playlist.spec.ts
//
// Pure tests for src/transcode/playlist.ts: ffmpeg-playlist parsing,
// served-wrapper rendering (discontinuity insertion), retention pruning,
// and produced-segment-index extraction. No I/O, no real ffmpeg.

import { describe, expect, it } from "vitest";
import {
  applyRunUpdate,
  emptyServedPlaylistState,
  highestProducedSegmentIndex,
  parseFfmpegPlaylist,
  pruneRetention,
  renderServedPlaylist,
  segmentIndexFromUri,
  servedPlaylistHasEnded,
} from "../../src/transcode/playlist.js";

const FMP4_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000000,
s000000.m4s
#EXTINF:6.000000,
s000001.m4s
`;

describe("parseFfmpegPlaylist", () => {
  it("parses target duration, init URI, and segments in order", () => {
    const parsed = parseFfmpegPlaylist(FMP4_PLAYLIST);
    expect(parsed.targetDurationSec).toBe(6);
    expect(parsed.initUri).toBe("init.mp4");
    expect(parsed.segments).toEqual([
      { uri: "s000000.m4s", durationSec: 6 },
      { uri: "s000001.m4s", durationSec: 6 },
    ]);
    expect(parsed.hasEndlist).toBe(false);
  });

  it("recognizes #EXT-X-ENDLIST", () => {
    const parsed = parseFfmpegPlaylist(FMP4_PLAYLIST + "#EXT-X-ENDLIST\n");
    expect(parsed.hasEndlist).toBe(true);
  });

  it("tolerates a dangling EXTINF with no URI yet (mid-write read)", () => {
    const torn = FMP4_PLAYLIST + "#EXTINF:6.000000,\n";
    const parsed = parseFfmpegPlaylist(torn);
    expect(parsed.segments).toHaveLength(2); // the dangling one is not counted
  });

  it("empty/no-segments file parses cleanly", () => {
    const parsed = parseFfmpegPlaylist("#EXTM3U\n#EXT-X-TARGETDURATION:6\n");
    expect(parsed.segments).toEqual([]);
    expect(parsed.initUri).toBeUndefined();
  });

  it("mpegts playlist has no init URI", () => {
    const tsPlaylist = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000000,\ns000000.ts\n`;
    const parsed = parseFfmpegPlaylist(tsPlaylist);
    expect(parsed.initUri).toBeUndefined();
    expect(parsed.segments[0]?.uri).toBe("s000000.ts");
  });
});

describe("segmentIndexFromUri", () => {
  it("extracts the absolute index from fmp4/ts filenames", () => {
    expect(segmentIndexFromUri("s000000.m4s")).toBe(0);
    expect(segmentIndexFromUri("s000043.m4s")).toBe(43);
    expect(segmentIndexFromUri("s000007.ts")).toBe(7);
  });
  it("returns undefined for anything else", () => {
    expect(segmentIndexFromUri("init.mp4")).toBeUndefined();
    expect(segmentIndexFromUri("media.m3u8")).toBeUndefined();
  });
});

describe("applyRunUpdate + renderServedPlaylist", () => {
  it("a single run renders with EXT-X-MAP and no discontinuity", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", parseFfmpegPlaylist(FMP4_PLAYLIST), 0);
    const rendered = renderServedPlaylist(state);
    expect(rendered).toContain("#EXT-X-MAP:URI=\"run0/init.mp4\"");
    expect(rendered).toContain("run0/s000000.m4s");
    expect(rendered).toContain("run0/s000001.m4s");
    expect(rendered).not.toContain("#EXT-X-DISCONTINUITY");
  });

  it("a second run (post-seek) inserts EXT-X-DISCONTINUITY before its first segment", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", parseFfmpegPlaylist(FMP4_PLAYLIST), 0);
    const run1Playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.000000,\ns000043.m4s\n`;
    state = applyRunUpdate(state, 1, "run1", parseFfmpegPlaylist(run1Playlist), 0);
    const rendered = renderServedPlaylist(state);

    const discontinuityIdx = rendered.indexOf("#EXT-X-DISCONTINUITY");
    const run1SegIdx = rendered.indexOf("run1/s000043.m4s");
    expect(discontinuityIdx).toBeGreaterThan(-1);
    expect(discontinuityIdx).toBeLessThan(run1SegIdx);
    // run0's segments still precede the discontinuity marker.
    expect(rendered.indexOf("run0/s000000.m4s")).toBeLessThan(discontinuityIdx);
  });

  it("updating an existing run REPLACES its segment list wholesale (ffmpeg's own file is authoritative)", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", parseFfmpegPlaylist(FMP4_PLAYLIST), 0);
    const grown = FMP4_PLAYLIST + "#EXTINF:6.000000,\ns000002.m4s\n";
    state = applyRunUpdate(state, 0, "run0", parseFfmpegPlaylist(grown), 0);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]!.segments).toHaveLength(3);
  });
});

describe("renderServedPlaylist: §9.1.5 rule 7 EXT-X-PROGRAM-DATE-TIME (V8 source clock)", () => {
  // Source time IS the PDT epoch (owner ruling Q1): source 0 ==
  // 1970-01-01T00:00:00.000Z, so a client's frag.programDateTime in ms IS
  // the segment's source start. Values below are run.sourceOriginMs + the
  // run's OWN cumulative prior #EXTINF — computed at fold time, so they
  // survive head-pruning without any pruned-head bookkeeping.
  const runPlaylist = (segs: [string, number][]): ReturnType<typeof parseFfmpegPlaylist> => ({
    targetDurationSec: 6,
    initUri: "init.mp4",
    hasEndlist: false,
    segments: segs.map(([uri, durationSec]) => ({ uri, durationSec })),
  });

  function pdtLineAbove(rendered: string, uriLine: string): string | undefined {
    const lines = rendered.trimEnd().split("\n");
    const idx = lines.indexOf(uriLine);
    if (idx < 2) return undefined;
    // Layout per segment is PDT, then #EXTINF, then the URI.
    return lines[idx - 2];
  }

  it("origin-0 run: every segment carries PDT = epoch + cumulative prior EXTINF of its OWN run", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", runPlaylist([
      ["s000000.m4s", 6.006],
      ["s000001.m4s", 6.006],
      ["s000002.m4s", 5.988],
    ]), 0);
    const rendered = renderServedPlaylist(state);
    expect(pdtLineAbove(rendered, "run0/s000000.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:00.000Z");
    expect(pdtLineAbove(rendered, "run0/s000001.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:06.006Z");
    expect(pdtLineAbove(rendered, "run0/s000002.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:12.012Z");
  });

  it("multi-run: PDT restarts at each run's own origin, and origins are NON-monotonic across a backward seek", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", runPlaylist([["s000000.m4s", 6]]), 0);
    state = applyRunUpdate(state, 1, "run1", runPlaylist([["s000001.m4s", 6]]), 60_000);
    state = applyRunUpdate(state, 2, "run2", runPlaylist([["s000002.m4s", 6]]), 3_000); // backward seek
    const rendered = renderServedPlaylist(state);
    expect(pdtLineAbove(rendered, "run0/s000000.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:00.000Z");
    expect(pdtLineAbove(rendered, "run1/s000001.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:01:00.000Z");
    expect(pdtLineAbove(rendered, "run2/s000002.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:03.000Z");
  });

  it("pruned head: a surviving mid-run segment keeps its FULL within-run offset (fold-time offsets survive pruning)", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", runPlaylist([
      ["s000000.m4s", 6],
      ["s000001.m4s", 6],
      ["s000002.m4s", 6],
      ["s000003.m4s", 6],
      ["s000004.m4s", 6],
    ]), 0);
    // Live edge 30s, retention 12s -> cutoff 18s: s0..s2 pruned (the viewer
    // is at the live edge, so nothing is held back by the d3-f1 floor).
    const { nextState } = pruneRetention(state, 12, 0, 4);
    const rendered = renderServedPlaylist(nextState);
    expect(rendered).not.toContain("run0/s000000.m4s");
    expect(pdtLineAbove(rendered, "run0/s000003.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:18.000Z");
    expect(pdtLineAbove(rendered, "run0/s000004.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:24.000Z");
  });

  it("an ENDLIST-bearing playlist keeps its PDTs and the terminal tag stays last", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", { ...runPlaylist([["s000000.m4s", 6]]), hasEndlist: true }, 0);
    const rendered = renderServedPlaylist(state);
    expect(pdtLineAbove(rendered, "run0/s000000.m4s")).toBe("#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:00.000Z");
    expect(rendered.trimEnd().split("\n").at(-1)).toBe("#EXT-X-ENDLIST");
  });

  it("PDT precedes #EXTINF — the EXTINF->URI adjacency the serve-side parser relies on is never broken", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", runPlaylist([["s000000.m4s", 6], ["s000001.m4s", 6]]), 0);
    state = applyRunUpdate(state, 1, "run1", runPlaylist([["s000002.m4s", 6]]), 12_000);
    const lines = renderServedPlaylist(state).trimEnd().split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith("#EXTINF")) {
        expect(lines[i + 1]!.startsWith("#")).toBe(false);
      }
    }
  });
});

describe("highestProducedSegmentIndex", () => {
  it("undefined when nothing produced yet", () => {
    expect(highestProducedSegmentIndex(emptyServedPlaylistState(6, true))).toBeUndefined();
  });
  it("the max absolute index across all runs", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", parseFfmpegPlaylist(FMP4_PLAYLIST), 0);
    expect(highestProducedSegmentIndex(state)).toBe(1);
  });
});

describe("pruneRetention", () => {
  function segState(count: number, durationSec = 6): ReturnType<typeof emptyServedPlaylistState> {
    let state = emptyServedPlaylistState(durationSec, true);
    const segments = Array.from({ length: count }, (_, i) => ({
      uri: `s${String(i).padStart(6, "0")}.m4s`,
      durationSec,
    }));
    state = applyRunUpdate(state, 0, "run0", { targetDurationSec: durationSec, initUri: "init.mp4", segments, hasEndlist: false }, 0);
    return state;
  }

  it("keeps everything when total content is within the retention window", () => {
    const state = segState(5); // 30s of content, well under 120s
    const result = pruneRetention(state, 120, 0, 4);
    expect(result.segmentsToDelete).toEqual([]);
    expect(result.runDirsToDelete).toEqual([]);
    expect(result.nextState.runs[0]!.segments).toHaveLength(5);
  });

  it("drops segments older than the retention window behind the live edge", () => {
    // 30 segments * 6s = 180s of content; retention 120s -> live edge 180,
    // cutoff 60 -> segments whose END time <= 60 (indices 0..9, ending at
    // 6..60) are pruned; index 9 ends exactly at 60 (<=60, pruned), index
    // 10 ends at 66 (> 60, survives).
    //
    // d3-f1: the viewer floor is the LIVE EDGE here (the client has
    // consumed everything produced), which is the only state in which the
    // pure retention-behind-live-edge arithmetic decides on its own.
    const state = segState(30);
    const result = pruneRetention(state, 120, 0, 29);
    expect(result.segmentsToDelete).toHaveLength(10);
    expect(result.segmentsToDelete[0]!.uri).toBe("s000000.m4s");
    expect(result.nextState.runs[0]!.segments).toHaveLength(20);
    expect(result.nextState.runs[0]!.segments[0]!.uri).toBe("s000010.m4s");
    expect(result.runDirsToDelete).toEqual([]); // run0 still has survivors
  });

  it("fully retires a PAST run once every one of its segments ages out, but never the CURRENT run", () => {
    let state = emptyServedPlaylistState(6, true);
    // run0: 5 old segments (30s) — will be fully pruned once far enough behind.
    state = applyRunUpdate(state, 0, "run0", {
      targetDurationSec: 6,
      initUri: "init.mp4",
      segments: Array.from({ length: 5 }, (_, i) => ({ uri: `s${String(i).padStart(6, "0")}.m4s`, durationSec: 6 })),
      hasEndlist: false,
    }, 0);
    // run1 (current): 25 fresh segments (150s) after the discontinuity.
    state = applyRunUpdate(state, 1, "run1", {
      targetDurationSec: 6,
      initUri: "init.mp4",
      segments: Array.from({ length: 25 }, (_, i) => ({ uri: `s${String(i + 5).padStart(6, "0")}.m4s`, durationSec: 6 })),
      hasEndlist: false,
    }, 0);

    const result = pruneRetention(state, 120, 1, 29);
    expect(result.runDirsToDelete).toEqual(["run0"]);
    expect(result.nextState.runs.find((r) => r.runDirName === "run0")).toBeUndefined();
    // run1 is current — even if some of its own early segments also aged
    // out, its directory is never in runDirsToDelete.
    expect(result.runDirsToDelete).not.toContain("run1");
  });

  // ── d3-f1: THE PRUNE FLOOR IS VIEWER EVIDENCE, NOT THE PRODUCED EDGE ──
  //
  // QA 2026-08-24 (P1, five merged observations): retention is defined
  // relative to the LIVE EDGE, which on a copy-shape file races to the end
  // of the film in under a second — so the "120s window" was 120s behind
  // the END, not behind the viewer. A fresh mount's first playlist came
  // back EXT-X-MEDIA-SEQUENCE 75 / PDT 00:07:31 (the head it needed had
  // already been deleted), 'Start over' relocated to 7:40, and every seek's
  // landing fragment was pruned before the client could fetch it. The fix
  // is to make the prune floor the viewer's own evidenced position: a
  // segment is prunable only when it is BOTH behind the retention horizon
  // AND below the highest index the viewer has actually reached.
  it("d3-f1: a fast-completing encode with NO viewer evidence yet keeps its whole head", () => {
    // The gap-F6/gap-F10 shape: 180s produced inside one poll tick, client
    // has not requested a single segment. Nothing may be deleted — the
    // first thing that client will ask for is s000000.
    const result = pruneRetention(segState(30), 120, 0, undefined);
    expect(result.segmentsToDelete, "pruned the head before the viewer had fetched anything").toEqual([]);
    expect(result.runDirsToDelete).toEqual([]);
    expect(result.nextState.runs[0]!.segments[0]!.uri).toBe("s000000.m4s");
  });

  it("d3-f1: prunes only BELOW the viewer's evidenced position, never ahead of it", () => {
    // Viewer at s000004 on the same 180s-in-one-tick encode: retention says
    // indices 0..9 are stale, but 4..9 are content the viewer has not
    // reached. Only 0..3 may go.
    const result = pruneRetention(segState(30), 120, 0, 4);
    expect(result.segmentsToDelete.map((s) => s.uri)).toEqual([
      "s000000.m4s",
      "s000001.m4s",
      "s000002.m4s",
      "s000003.m4s",
    ]);
    expect(result.nextState.runs[0]!.segments[0]!.uri).toBe("s000004.m4s");
  });

  it("d3-f1: a seek's landing run survives until the viewer has fetched it", () => {
    // run0 = the pre-seek run (indices 0..20); run1 = the run a backward
    // seek just spawned, numbered forward from the produced edge (21..25)
    // and sitting at source origin 0. The viewer is still down at s000010
    // — it has not re-read the playlist yet — so run1's head is exactly
    // what it is about to ask for. Retention (12s behind a 156s live edge)
    // would otherwise delete run0 entirely AND run1's first three
    // segments: the landing fragment, gone before it was ever served.
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", {
      targetDurationSec: 6,
      initUri: "init.mp4",
      segments: Array.from({ length: 21 }, (_, i) => ({ uri: `s${String(i).padStart(6, "0")}.m4s`, durationSec: 6 })),
      hasEndlist: false,
    }, 0);
    state = applyRunUpdate(state, 1, "run1", {
      targetDurationSec: 6,
      initUri: "init.mp4",
      segments: Array.from({ length: 5 }, (_, i) => ({ uri: `s${String(21 + i).padStart(6, "0")}.m4s`, durationSec: 6 })),
      hasEndlist: false,
    }, 0);

    const result = pruneRetention(state, 12, 1, 10);
    expect(result.nextState.runs.find((r) => r.runIndex === 1)!.segments, "the landing run was pruned before it was fetched").toHaveLength(5);
    expect(result.segmentsToDelete.map((s) => s.uri)).toEqual(
      Array.from({ length: 10 }, (_, i) => `s${String(i).padStart(6, "0")}.m4s`),
    );
    expect(result.segmentsToDelete.every((s) => s.runDirName === "run0")).toBe(true);
  });

  it("d3-f1: disk stays bounded on a genuinely long session — the window slides WITH the viewer", () => {
    // 60 segments (360s) produced, viewer at s000050: everything more than
    // one retention window behind the live edge AND below the viewer goes,
    // so the residual is bounded by the retention window, not by the
    // session's length.
    const result = pruneRetention(segState(60), 120, 0, 50);
    expect(result.segmentsToDelete).toHaveLength(40); // indices 0..39 (end <= 240)
    expect(result.nextState.runs[0]!.segments).toHaveLength(20);
    expect(result.nextState.runs[0]!.segments[0]!.uri).toBe("s000040.m4s");
  });
});

// ---------------------------------------------------------------------------
// Wave C2 / owner-decision V3 (docs/PLAYBACK.md §9.1.5): the SERVED
// playlist's tag model. It closes a real RFC 8216 contradiction — the served
// wrapper declared `EXT-X-PLAYLIST-TYPE:EVENT` (append-only per §4.3.3.5)
// while retention pruned its head — and a real defect: a completed encode
// never got `EXT-X-ENDLIST` at all, so a finished stream played out and then
// polled forever with no duration and no `ended` event.
//
// SCOPE GUARD, restated here because it is the one thing a build lane could
// plausibly "fix" by analogy and must not: this governs the SERVED playlist
// only. ffmpeg's own PER-RUN playlist keeps §6's `-hls_playlist_type event`
// — within one run it genuinely IS append-only, and that completeness is
// exactly what makes `producedMs` (and §9.1.4's handoff origin) exact.
// ---------------------------------------------------------------------------

describe("renderServedPlaylist: the §9.1.5 tag model", () => {
  function stateWith(hasEndlist: boolean): ReturnType<typeof emptyServedPlaylistState> {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", { ...parseFfmpegPlaylist(FMP4_PLAYLIST), hasEndlist }, 0);
    return state;
  }

  it("NEVER emits EXT-X-PLAYLIST-TYPE — neither EVENT nor VOD (rule 1)", () => {
    // A type-less playlist is the RFC's sliding-window live shape: clients
    // may not assume append-only, and head removal is legal when signalled
    // (which EXT-X-MEDIA-SEQUENCE / EXT-X-DISCONTINUITY-SEQUENCE do).
    expect(renderServedPlaylist(stateWith(false))).not.toContain("#EXT-X-PLAYLIST-TYPE");
    expect(renderServedPlaylist(stateWith(true))).not.toContain("#EXT-X-PLAYLIST-TYPE");
  });

  it("appends EXT-X-ENDLIST once the CURRENT run's own ffmpeg playlist carries it (rule 4)", () => {
    const rendered = renderServedPlaylist(stateWith(true));
    expect(rendered.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });

  it("does NOT append ENDLIST while the current run is still producing", () => {
    expect(renderServedPlaylist(stateWith(false))).not.toContain("#EXT-X-ENDLIST");
  });

  it("reads ENDLIST from the CURRENT run only — a finished PAST run must not end a live playlist", () => {
    let state = emptyServedPlaylistState(6, true);
    // run0 ended (the seek killed it after ffmpeg wrote its ENDLIST);
    // run1 is the live one and is still producing.
    state = applyRunUpdate(state, 0, "run0", { ...parseFfmpegPlaylist(FMP4_PLAYLIST), hasEndlist: true }, 0);
    state = applyRunUpdate(state, 1, "run1", {
      targetDurationSec: 6,
      initUri: "init.mp4",
      segments: [{ uri: "s000043.m4s", durationSec: 6 }],
      hasEndlist: false,
    }, 0);
    expect(renderServedPlaylist(state)).not.toContain("#EXT-X-ENDLIST");
  });

  it("a post-ENDLIST seek/switch UN-ends the playlist (rule 5 — the new run is live again)", () => {
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", { ...parseFfmpegPlaylist(FMP4_PLAYLIST), hasEndlist: true }, 0);
    expect(renderServedPlaylist(state)).toContain("#EXT-X-ENDLIST");
    state = applyRunUpdate(state, 1, "run1", {
      targetDurationSec: 6,
      initUri: "init.mp4",
      segments: [{ uri: "s000043.m4s", durationSec: 6 }],
      hasEndlist: false,
    }, 0);
    expect(renderServedPlaylist(state)).not.toContain("#EXT-X-ENDLIST");
  });

  it("an empty state renders a valid, ENDLIST-free playlist", () => {
    expect(renderServedPlaylist(emptyServedPlaylistState(6, true))).toContain("#EXTM3U");
    expect(renderServedPlaylist(emptyServedPlaylistState(6, true))).not.toContain("#EXT-X-ENDLIST");
  });
});

describe("servedPlaylistHasEnded (the §9.1.5 rule-4 PRUNE-FREEZE predicate)", () => {
  it("is true exactly when the current run has ended", () => {
    let live = emptyServedPlaylistState(6, true);
    live = applyRunUpdate(live, 0, "run0", parseFfmpegPlaylist(FMP4_PLAYLIST), 0);
    expect(servedPlaylistHasEnded(live)).toBe(false);

    let ended = emptyServedPlaylistState(6, true);
    ended = applyRunUpdate(ended, 0, "run0", { ...parseFfmpegPlaylist(FMP4_PLAYLIST), hasEndlist: true }, 0);
    expect(servedPlaylistHasEnded(ended)).toBe(true);
  });

  it("an empty state has not ended (nothing has been produced to end)", () => {
    expect(servedPlaylistHasEnded(emptyServedPlaylistState(6, true))).toBe(false);
  });

  it("PRUNE-FREEZE: the runtime must stop pruning once ended — RFC: an ended playlist must not change", () => {
    // Disk stays bounded without pruning because at ENDLIST no new segments
    // are produced either: the residual is at most one retention window,
    // reclaimed at session teardown as always (§9.1.8).
    let state = emptyServedPlaylistState(6, true);
    state = applyRunUpdate(state, 0, "run0", {
      targetDurationSec: 6,
      initUri: "init.mp4",
      segments: Array.from({ length: 30 }, (_, i) => ({ uri: `s${String(i).padStart(6, "0")}.m4s`, durationSec: 6 })),
      hasEndlist: true,
    }, 0);
    // The predicate is what the runtime gates pruneRetention on; pruning
    // this state WOULD drop 10 segments, which is exactly what must not
    // happen after the playlist has ended.
    expect(servedPlaylistHasEnded(state)).toBe(true);
    expect(pruneRetention(state, 120, 0, 29).segmentsToDelete).toHaveLength(10);
  });
});
