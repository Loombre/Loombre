// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Served-playlist maintenance (docs/PLAYBACK.md §9 / this step's binding
 * constraint 5). ffmpeg writes its own `media.m3u8` PER RUN, into that
 * run's own private directory (staging.ts/args.ts headers) — this module
 * is what turns a sequence of those per-run playlists into the ONE
 * `media.m3u8` Lane B actually serves at the session root: segment
 * entries concatenated in run order, an `#EXT-X-DISCONTINUITY` tag
 * inserted immediately before the first segment of every run AFTER the
 * first (every non-initial run exists BECAUSE of a seek-restart, docs/
 * PLAYBACK.md §9 — there is no other reason a second run ever starts), and
 * retention pruning (segments older than
 * apps/worker/src/transcode/config.ts's SEGMENT_RETENTION_SEC behind the
 * live edge are dropped from both the rendered playlist and disk).
 *
 * Everything in this file is PURE (no fs access) — the runtime (runner.ts)
 * owns reading each run's real `media.m3u8` off disk, calling into this
 * module to fold the parsed result into in-memory state, rendering the
 * result, and writing/deleting real files per what this module says to.
 * That split is what makes the folding/discontinuity/retention LOGIC unit
 * testable without a real ffmpeg process anywhere nearby.
 */

export interface ParsedSegment {
  /** The URI exactly as ffmpeg's own playlist wrote it (a bare filename —
   *  ffmpeg has no notion of this session's run-directory scheme). */
  uri: string;
  durationSec: number;
}

export interface ParsedFfmpegPlaylist {
  targetDurationSec: number;
  /** `#EXT-X-MAP:URI="..."` value, fmp4 only (undefined for mpegts —
   *  ts-hls segments are self-contained, no init segment). */
  initUri: string | undefined;
  segments: ParsedSegment[];
  /** True once ffmpeg has written `#EXT-X-ENDLIST` (its own run has
   *  reached the end of input / was told to stop cleanly) — informational
   *  only, this module never relies on it for anything load-bearing. */
  hasEndlist: boolean;
}

const EXTINF_RE = /^#EXTINF:([0-9.]+),/;
const TARGETDURATION_RE = /^#EXT-X-TARGETDURATION:(\d+)/;
const MAP_URI_RE = /^#EXT-X-MAP:URI="([^"]+)"/;

/** Parses ONE ffmpeg-produced per-run HLS playlist. Tolerant by design —
 *  a partially-flushed file mid-write (the runtime may read it while
 *  ffmpeg is still appending) parses whatever complete EXTINF/URI pairs
 *  are present and ignores a dangling trailing EXTINF with no URI line
 *  after it yet, rather than throwing. */
export function parseFfmpegPlaylist(text: string): ParsedFfmpegPlaylist {
  const lines = text.split(/\r?\n/);
  let targetDurationSec = 6;
  let initUri: string | undefined;
  let hasEndlist = false;
  const segments: ParsedSegment[] = [];
  let pendingDuration: number | undefined;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-TARGETDURATION")) {
      const m = TARGETDURATION_RE.exec(line);
      if (m?.[1]) targetDurationSec = Number.parseInt(m[1], 10);
      continue;
    }
    if (line.startsWith("#EXT-X-MAP")) {
      const m = MAP_URI_RE.exec(line);
      if (m?.[1]) initUri = m[1];
      continue;
    }
    if (line.startsWith("#EXT-X-ENDLIST")) {
      hasEndlist = true;
      continue;
    }
    if (line.startsWith("#EXTINF")) {
      const m = EXTINF_RE.exec(line);
      if (m?.[1]) pendingDuration = Number.parseFloat(m[1]);
      continue;
    }
    if (line.startsWith("#") || line.trim() === "") {
      continue;
    }
    // A non-comment, non-blank line following a parsed #EXTINF is the
    // segment URI.
    if (pendingDuration !== undefined) {
      segments.push({ uri: line.trim(), durationSec: pendingDuration });
      pendingDuration = undefined;
    }
  }

  return { targetDurationSec, initUri, segments, hasEndlist };
}

/** Extracts the absolute (globally-continuous, docs/PLAYBACK.md §9)
 *  segment index from a `sNNNNNN.{m4s,ts}` filename. Returns `undefined`
 *  for anything not matching that shape (defensive — should never happen
 *  against this session layer's own segment-filename convention, packages/
 *  playback-engine/src/args/builder.ts segment 9). */
export function segmentIndexFromUri(uri: string): number | undefined {
  const m = /^s(\d+)\.(m4s|ts)$/.exec(uri);
  if (!m?.[1]) return undefined;
  return Number.parseInt(m[1], 10);
}

export interface RunState {
  runIndex: number;
  /** Run-relative directory name, e.g. "run0" — segment/init URIs in the
   *  RENDERED served playlist are prefixed with this (`run0/s000000.m4s`),
   *  so Lane B's future file-serving handler resolves a requested relative
   *  path against the session's staging_dir with a simple, guardable
   *  join (this module's own header + this step's report documents the
   *  convention for Lane B). */
  runDirName: string;
  initUri: string | undefined;
  segments: ParsedSegment[];
}

export interface ServedPlaylistState {
  targetDurationSec: number;
  isFmp4: boolean;
  runs: RunState[];
}

export function emptyServedPlaylistState(targetDurationSec: number, isFmp4: boolean): ServedPlaylistState {
  return { targetDurationSec, isFmp4, runs: [] };
}

/** Folds a freshly-(re)parsed per-run playlist into the served state,
 *  replacing whatever this run's OWN segment list was previously (ffmpeg's
 *  own file is authoritative for what that run has actually finished
 *  writing — this is the ENTIRE point of never trusting a second, stale
 *  snapshot). Runs are appended to `state.runs` in increasing `runIndex`
 *  order the first time they're seen; an update to an existing run
 *  replaces it in place. */
export function applyRunUpdate(state: ServedPlaylistState, runIndex: number, runDirName: string, parsed: ParsedFfmpegPlaylist): ServedPlaylistState {
  const nextRun: RunState = { runIndex, runDirName, initUri: parsed.initUri, segments: parsed.segments };
  const existingIdx = state.runs.findIndex((r) => r.runIndex === runIndex);
  const runs = existingIdx === -1 ? [...state.runs, nextRun] : state.runs.map((r, i) => (i === existingIdx ? nextRun : r));
  runs.sort((a, b) => a.runIndex - b.runIndex);
  return { ...state, targetDurationSec: Math.max(state.targetDurationSec, parsed.targetDurationSec), runs };
}

/** Renders the WRAPPER playlist Lane B serves as `media.m3u8`: every run's
 *  segments concatenated in order, `#EXT-X-DISCONTINUITY` + a fresh
 *  `#EXT-X-MAP` before the first segment of every run after the first
 *  (binding constraint 5). Segment/init URIs are rewritten run-relative
 *  (`run0/s000000.m4s`) — see RunState's own doc comment. */
export function renderServedPlaylist(state: ServedPlaylistState): string {
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(state.targetDurationSec)}`,
    "#EXT-X-PLAYLIST-TYPE:EVENT",
  ];

  state.runs.forEach((run, i) => {
    if (i > 0) lines.push("#EXT-X-DISCONTINUITY");
    if (state.isFmp4 && run.initUri) {
      lines.push(`#EXT-X-MAP:URI="${run.runDirName}/${run.initUri}"`);
    }
    for (const seg of run.segments) {
      lines.push(`#EXTINF:${seg.durationSec},`);
      lines.push(`${run.runDirName}/${seg.uri}`);
    }
  });

  return lines.join("\n") + "\n";
}

export interface PruneResult {
  nextState: ServedPlaylistState;
  /** Files to actually unlink, run-directory-relative. */
  segmentsToDelete: { runDirName: string; uri: string }[];
  /** Runs whose ENTIRE directory is now safe to remove (every one of its
   *  segments was pruned) — excludes `currentRunIndex` unconditionally,
   *  even if it happens to have zero surviving segments, since that run
   *  is still being actively written to. */
  runDirsToDelete: string[];
}

/**
 * Drops segments more than `retentionSec` behind the live edge (the END
 * time of the most recently produced segment across every run — docs/
 * PLAYBACK.md §9: "segments beyond 120s behind live edge deleted").
 * `currentRunIndex` is never directory-deleted even if it ends up with
 * zero surviving segments (it is still the run ffmpeg is actively writing
 * into — only a PAST run can be fully retired).
 */
export function pruneRetention(state: ServedPlaylistState, retentionSec: number, currentRunIndex: number): PruneResult {
  const allSegmentsInOrder = state.runs.flatMap((run) =>
    run.segments.map((seg) => ({ run, seg, endSec: 0 })),
  );
  let cumulative = 0;
  for (const entry of allSegmentsInOrder) {
    cumulative += entry.seg.durationSec;
    entry.endSec = cumulative;
  }
  const liveEdgeSec = allSegmentsInOrder.length > 0 ? allSegmentsInOrder[allSegmentsInOrder.length - 1]!.endSec : 0;
  const cutoffSec = liveEdgeSec - retentionSec;

  const segmentsToDelete: { runDirName: string; uri: string }[] = [];
  const runDirsToDelete: string[] = [];

  const nextRuns: RunState[] = [];
  let runningEnd = 0;
  for (const run of state.runs) {
    const survivors: ParsedSegment[] = [];
    for (const seg of run.segments) {
      runningEnd += seg.durationSec;
      if (runningEnd <= cutoffSec) {
        segmentsToDelete.push({ runDirName: run.runDirName, uri: seg.uri });
      } else {
        survivors.push(seg);
      }
    }
    if (survivors.length === 0 && run.segments.length > 0 && run.runIndex !== currentRunIndex) {
      runDirsToDelete.push(run.runDirName);
      // Fully-retired run drops out of state entirely — nothing left to
      // render for it.
      continue;
    }
    nextRuns.push({ ...run, segments: survivors });
  }

  return {
    nextState: { ...state, runs: nextRuns },
    segmentsToDelete,
    runDirsToDelete,
  };
}

/** The highest absolute segment index across every run's surviving
 *  segments — the worker's `produced_segment` value (docs/PLAYBACK.md §9 /
 *  migrations/0012_transcode_sessions.sql). `undefined` when nothing has
 *  been produced yet. */
export function highestProducedSegmentIndex(state: ServedPlaylistState): number | undefined {
  let max: number | undefined;
  for (const run of state.runs) {
    for (const seg of run.segments) {
      const idx = segmentIndexFromUri(seg.uri);
      if (idx !== undefined && (max === undefined || idx > max)) max = idx;
    }
  }
  return max;
}
