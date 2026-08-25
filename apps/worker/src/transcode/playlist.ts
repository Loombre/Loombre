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
   *  reached the end of input / was told to stop cleanly). LOAD-BEARING as
   *  of Wave C2 (§9.1.5 rule 4): folded onto the run's `RunState` and read
   *  by `servedPlaylistHasEnded`, which drives both the served playlist's
   *  own terminal `EXT-X-ENDLIST` and the retention prune-freeze. It was
   *  parsed-but-unused before that, which is precisely why a completed
   *  encode never produced an `ended` signal. */
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

/** A RunState segment: the parsed pair PLUS its start offset within its
 *  OWN run's output, computed at fold time (`applyRunUpdate`) from the
 *  complete per-run ffmpeg playlist — which §6 keeps append-only, so the
 *  cumulative sum is exact and, once computed, survives head-pruning
 *  without any pruned-head bookkeeping (§9.1.5 rule 7). */
export interface RunSegment extends ParsedSegment {
  startOffsetSec: number;
}

export interface RunState {
  runIndex: number;
  /** Whether THIS run's own ffmpeg playlist carried `#EXT-X-ENDLIST` —
   *  i.e. whether ffmpeg reached the end of its input (or was told to stop
   *  cleanly) rather than being killed mid-run. Consumed by
   *  `servedPlaylistHasEnded` (§9.1.5 rule 4), which reads it from the
   *  CURRENT run only. */
  hasEndlist: boolean;
  /** Run-relative directory name, e.g. "run0" — segment/init URIs in the
   *  RENDERED served playlist are prefixed with this (`run0/s000000.m4s`),
   *  so Lane B's future file-serving handler resolves a requested relative
   *  path against the session's staging_dir with a simple, guardable
   *  join (this module's own header + this step's report documents the
   *  convention for Lane B). */
  runDirName: string;
  /** Where this run starts on the SOURCE timeline (V8, §9.1.5 rule 7) —
   *  0 for run 0, the consumed seek target for a seek run, the §9.1.4
   *  continuation origin for a handoff run. Supplied by the runner from
   *  its own run registry (it spawned the run and wrote the
   *  transcode_runs row); NON-monotonic across runs (a backward seek
   *  starts a later run at an earlier origin). Feeds the per-segment
   *  `EXT-X-PROGRAM-DATE-TIME` emission in `renderServedPlaylist`. */
  sourceOriginMs: number;
  initUri: string | undefined;
  segments: RunSegment[];
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
 *  replaces it in place.
 *
 *  `sourceOriginMs` (V8, §9.1.5 rule 7): the run's source origin, from the
 *  runner's registry. Within-run segment offsets are computed HERE, from
 *  the complete (append-only) per-run playlist, so they stay exact after
 *  head-pruning removes earlier entries from the served state. */
export function applyRunUpdate(
  state: ServedPlaylistState,
  runIndex: number,
  runDirName: string,
  parsed: ParsedFfmpegPlaylist,
  sourceOriginMs: number,
): ServedPlaylistState {
  let cumulativeSec = 0;
  const segments: RunSegment[] = parsed.segments.map((seg) => {
    const enriched: RunSegment = { ...seg, startOffsetSec: cumulativeSec };
    cumulativeSec += seg.durationSec;
    return enriched;
  });
  const nextRun: RunState = {
    runIndex,
    runDirName,
    sourceOriginMs,
    initUri: parsed.initUri,
    segments,
    hasEndlist: parsed.hasEndlist,
  };
  const existingIdx = state.runs.findIndex((r) => r.runIndex === runIndex);
  const runs = existingIdx === -1 ? [...state.runs, nextRun] : state.runs.map((r, i) => (i === existingIdx ? nextRun : r));
  runs.sort((a, b) => a.runIndex - b.runIndex);
  return { ...state, targetDurationSec: Math.max(state.targetDurationSec, parsed.targetDurationSec), runs };
}

/**
 * Has the SERVED playlist ended? — the §9.1.5 rule-4 predicate, true when
 * the CURRENT run's own ffmpeg playlist carries `#EXT-X-ENDLIST`.
 *
 * "Current" is the LAST run in state order, and that qualifier is
 * load-bearing rather than pedantic: a seek or a rung switch kills the
 * in-flight run, and ffmpeg writes its ENDLIST on the way out. Reading
 * `hasEndlist` across all runs would therefore declare a still-live
 * playlist finished the moment its FIRST run was replaced — the exact
 * inverse of the defect this rule fixes.
 *
 * The runtime gates TWO things on this: appending the tag (below) and
 * FREEZING retention pruning (runner.ts). RFC 8216: a playlist that has
 * ended must not change, and pruning its head would change it. Disk stays
 * bounded anyway — at ENDLIST no new segments are produced either, so the
 * residual is at most one retention window, reclaimed at session teardown
 * exactly as always (§9.1.8).
 */
export function servedPlaylistHasEnded(state: ServedPlaylistState): boolean {
  const current = state.runs[state.runs.length - 1];
  return current?.hasEndlist === true;
}

/** Renders the WRAPPER playlist Lane B serves as `media.m3u8`: every run's
 *  segments concatenated in order, `#EXT-X-DISCONTINUITY` + a fresh
 *  `#EXT-X-MAP` before the first segment of every run after the first
 *  (binding constraint 5). Segment/init URIs are rewritten run-relative
 *  (`run0/s000000.m4s`) — see RunState's own doc comment.
 *
 * §9.1.5 (owner-decision V3) settled this playlist's TAG MODEL:
 *
 *   - NO `EXT-X-PLAYLIST-TYPE`, ever — neither EVENT nor VOD. The tag used
 *     to say EVENT, which RFC 8216 §4.3.3.5 defines as append-only, while
 *     `pruneRetention` below removed segments from the head: a real
 *     contradiction, not a nit. A type-LESS playlist is the RFC's sliding-
 *     window live shape, where head removal is legal as long as it is
 *     signalled — which `EXT-X-MEDIA-SEQUENCE` and (Wave C2)
 *     `EXT-X-DISCONTINUITY-SEQUENCE` do, both added at SERVE time by
 *     apps/server/src/common/served-playlist.ts.
 *   - A terminal `EXT-X-ENDLIST` once the current run has ended. Before
 *     this, a completed encode played out and then polled forever: no
 *     duration resolved and the media element never fired `ended`.
 *
 * SCOPE GUARD (§9.1.5, quoted because a future lane will be tempted to
 * "fix" it by analogy): this model governs the SERVED playlist ONLY.
 * ffmpeg's own per-run playlist KEEPS §6's `-hls_playlist_type event` —
 * within one run it genuinely IS append-only, ffmpeg never prunes it, and
 * that completeness is exactly what makes `producedMs` (and therefore
 * §9.1.4's handoff-origin arithmetic) exact even after the SERVED
 * playlist's head has been pruned away.
 */
export function renderServedPlaylist(state: ServedPlaylistState): string {
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(state.targetDurationSec)}`,
  ];

  state.runs.forEach((run, i) => {
    if (i > 0) lines.push("#EXT-X-DISCONTINUITY");
    if (state.isFmp4 && run.initUri) {
      lines.push(`#EXT-X-MAP:URI="${run.runDirName}/${run.initUri}"`);
    }
    for (const seg of run.segments) {
      // §9.1.5 rule 7 (V8): the source clock, in-band. Source time 0 IS
      // the Unix epoch (owner ruling Q1), so a client's
      // frag.programDateTime in ms IS the segment's source start. Emitted
      // per SEGMENT (not per run) so head-pruning needs no
      // first-listed-segment bookkeeping; placed BEFORE #EXTINF so the
      // EXTINF->URI adjacency serve-side parsers rely on is untouched.
      const sourceStartMs = Math.round(run.sourceOriginMs + seg.startOffsetSec * 1000);
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(sourceStartMs).toISOString()}`);
      lines.push(`#EXTINF:${seg.durationSec},`);
      lines.push(`${run.runDirName}/${seg.uri}`);
    }
  });

  if (servedPlaylistHasEnded(state)) lines.push("#EXT-X-ENDLIST");

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
 * PLAYBACK.md §9: "segments beyond 120s behind live edge deleted"), BUT
 * never a segment the viewer has not reached yet.
 * `currentRunIndex` is never directory-deleted even if it ends up with
 * zero surviving segments (it is still the run ffmpeg is actively writing
 * into — only a PAST run can be fully retired).
 *
 * ── THE VIEWER FLOOR (d3-f1, QA 2026-08-24 P1) ────────────────────────
 * `viewerSegmentIndex` is the highest ABSOLUTE segment index the session
 * has evidence the viewer actually reached (runner.ts watermarks it from
 * `playback_sessions.highest_served_segment` — migration 0045 / d4-f2 —
 * which apps/server writes ONLY when a segment GET is answered 200 with a
 * real file body); `undefined` means "no evidence at all — the client has
 * not been handed a single segment yet". A segment is prunable only when it
 * is BOTH behind the retention horizon AND strictly below that floor.
 *
 * The evidence column is deliberately not `requested_segment`: that one
 * records DEMAND (every GET, 503'd and speculative alike) because the
 * segment-ahead throttle must react to demand. d3-f1 originally
 * reconstructed progression from it, bounded by the produced edge, and a
 * forward probe landing below that edge was then indistinguishable from
 * consumption — enough to authorise deleting everything under an index
 * nobody had ever been served (d4-f2).
 *
 * Why the live edge alone is not a window: "120s behind the live edge" is
 * a sliding window AROUND THE VIEWER only while production runs at roughly
 * realtime. A copy-shape file breaks that assumption completely — the
 * remux reaches `#EXT-X-ENDLIST` in under a second, so the live edge IS
 * the end of the film and the retention window is "the last 20 segments of
 * the movie", nowhere near the viewer. Observed live, all on real media:
 * a fresh mount's first `media.m3u8` came back EXT-X-MEDIA-SEQUENCE 75 /
 * PDT 00:07:31 (playback could not start at 0:00 at all, and every GET of
 * a pruned index read as an implicit seek); 'Start over' spawned a run at
 * origin 0 whose head was deleted before the client re-read the playlist,
 * landing the viewer at 7:40; a seek's landing fragment could vanish
 * before it was ever fetched, so the client's landing watch never matched
 * and it raised its 20s "Seek timed out" toast.
 *
 * Disk stays bounded exactly as before. Production itself is bounded
 * ahead of the viewer by the segment-ahead throttle (throttle.ts: SIGSTOP
 * at ahead > 10, and a NULL `requested_segment` counts as 0, never as
 * "unbounded ahead is fine") and, on a COPY shape — the one case the
 * throttle's poll granularity cannot bind, because the whole remux can
 * finish inside one tick — by the produce-ahead cap config.ts pins into
 * the ffmpeg args (d4-f1), so the retained set is the retention window
 * behind the viewer plus the throttle's lead ahead of it — a window that
 * now slides WITH the viewer instead of with an edge the viewer may never
 * have reached. The one case where production genuinely outran the
 * throttle — a whole file remuxed inside one poll interval, whose output
 * the §9.1.5 rule-4 prune-freeze then kept to session teardown — is closed
 * at the source by d4-f1's produce-ahead cap: a copy-shape run is paced by
 * ffmpeg itself after an initial burst of one retention window, so the
 * staged set is bounded by that window rather than by the source's size.
 */
export function pruneRetention(
  state: ServedPlaylistState,
  retentionSec: number,
  currentRunIndex: number,
  viewerSegmentIndex: number | undefined,
): PruneResult {
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
    const survivors: RunSegment[] = [];
    for (const seg of run.segments) {
      runningEnd += seg.durationSec;
      // The viewer floor (d3-f1, this function's header). A segment the
      // viewer has not reached is never stale, however far behind the
      // produced edge it sits — and with no evidence at all, nothing is:
      // the very first thing that client will ask for is the head.
      // A URI whose index cannot be parsed is treated as unreached rather
      // than as reached — deleting it is the irreversible direction.
      const segmentIndex = segmentIndexFromUri(seg.uri);
      const belowViewer = viewerSegmentIndex !== undefined && segmentIndex !== undefined && segmentIndex < viewerSegmentIndex;
      if (runningEnd <= cutoffSec && belowViewer) {
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
