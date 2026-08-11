// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/served-playlist.ts
//
// Pure reading of the served HLS playlist a transcode session's worker
// writes (apps/worker/src/transcode/playlist.ts's `renderServedPlaylist`),
// plus the two timeline conversions built on it:
//
//   segment index  -> SOURCE ms   (`deriveSegmentStartMs`, seek targets)
//   presentation ms -> SOURCE ms  (`presentationToSourceMs`, progress)
//
// WHY THIS LIVES IN common/ RATHER THAN playback/: the progress-ingestion
// path is `apps/server/src/catalog/progress.controller.ts`, and
// dependency-cruiser's `catalog-no-cross-module-import` rule (D2 — "modules
// share only IDs") forbids catalog importing anything under
// `apps/server/src/playback`. Both modules already depend on common/ for
// DbProvider and ViewerContextProvider, so the shared timeline arithmetic
// belongs here — one implementation, two callers, no boundary violation and
// no second copy to drift.
//
// Everything here is PURE: no I/O, no clock, no db handle. Callers supply
// the playlist text and the run rows.

/** One entry of the served playlist: its GLOBALLY-CONTINUOUS segment index
 *  (docs/PLAYBACK.md §9 — `{START_SEG}` continues the numbering across
 *  every seek-restart run, so an index is unique session-wide) and the
 *  duration ffmpeg really wrote for it. */
export interface ServedSegmentEntry {
  index: number;
  durationMs: number;
  /** Which run produced it, from the URI's own `runN/` prefix. A run's
   *  segment indices are contiguous, but its UPPER bound is not knowable
   *  from a single `transcode_runs` row (that row records where the run
   *  STARTS, not where the next one begins), so this is what makes "the
   *  segments belonging to THIS run" exactly decidable from the playlist
   *  alone. */
  runIndex: number;
}

/** The run-map shape this module consumes — structurally the fields of
 *  @loombre/db's `TranscodeRunRow` (migration 0043). Declared locally so
 *  this pure module needs no db import at all. */
export interface RunAnchor {
  runIndex: number;
  startSegment: number;
  sourceOriginMs: number;
}

/** `#EXTINF:<sec>,` immediately followed by a `runN/sNNNNNN.{m4s,ts}` URI —
 *  the exact two-line shape `renderServedPlaylist()` emits. Parsed here
 *  rather than imported because apps/server must not reach into
 *  apps/worker's internals across the process boundary the seam contract
 *  allows no channel across. */
const EXTINF_RE = /^#EXTINF:([0-9.]+),/;
const SERVED_SEGMENT_URI_RE = /^run(\d+)\/s(\d+)\.(?:m4s|ts)$/;

/** Tolerant by design (same posture as the worker's own parser): a playlist
 *  read mid-rewrite, a dangling `#EXTINF` with no URI after it yet, or an
 *  unrecognized line all degrade to "fewer entries", never a throw. Entries
 *  come back in playlist order, which is also increasing index order. */
export function parseServedSegmentDurations(playlistText: string): ServedSegmentEntry[] {
  const entries: ServedSegmentEntry[] = [];
  let pendingDurationMs: number | undefined;
  for (const rawLine of playlistText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#EXTINF")) {
      const m = EXTINF_RE.exec(line);
      const sec = m?.[1] === undefined ? Number.NaN : Number.parseFloat(m[1]);
      pendingDurationMs = Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
      continue;
    }
    if (line.startsWith("#") || line === "") continue;
    if (pendingDurationMs === undefined) continue;
    const uri = SERVED_SEGMENT_URI_RE.exec(line);
    if (uri?.[1] !== undefined && uri[2] !== undefined) {
      entries.push({
        runIndex: Number.parseInt(uri[1], 10),
        index: Number.parseInt(uri[2], 10),
        durationMs: pendingDurationMs,
      });
    }
    pendingDurationMs = undefined;
  }
  return entries;
}

function meanDurationMs(entries: readonly ServedSegmentEntry[], fallbackMs: number): number {
  if (entries.length === 0) return fallbackMs;
  let total = 0;
  for (const e of entries) total += e.durationMs;
  return total / entries.length;
}

/**
 * SOURCE-timeline start of `segmentIndex`, in ms.
 *
 * WITH an owning run (`run`, from `getTranscodeRunForSegment`) this is
 * EXACT, and exact for every run — not just run 0:
 *
 *     source(N) = run.sourceOriginMs
 *               + sum of the REAL durations of the run's OWN segments
 *                 from run.startSegment up to N-1
 *
 * Inside a single run, playlist duration maps 1:1 to source time — neither
 * a stream copy nor a transcode changes the rate — so summing that run's
 * own `#EXTINF` values IS the source offset. Only segments of the SAME run
 * are summed: a previous run's durations describe a different region of the
 * source entirely, which is precisely the error the pre-0043 derivation
 * could not avoid. Segments of the run that retention has already pruned
 * out of the playlist are the one estimated term, and they extrapolate at
 * THAT RUN's own measured mean, never a cross-run one.
 *
 * WITHOUT a run (`run === undefined` — a session predating migration 0043,
 * or one whose pipeline never recorded a run) the pre-0043 chain stands
 * unchanged, and is deliberately NOT replaced by "assume origin 0":
 *   1. no entries at all -> `segmentIndex * nominalSegmentDurationMs`, the
 *      last resort, reached only when there is nothing measured to use;
 *   2. at or after some listed entry -> exact cumulative sum of the real
 *      durations before it, anchored at `firstListedIndex * mean`;
 *   3. before every listed entry -> `segmentIndex * mean`.
 *
 * Pure: no I/O, no clock.
 */
export function deriveSegmentStartMs(
  entries: readonly ServedSegmentEntry[],
  segmentIndex: number,
  nominalSegmentDurationMs: number,
  run?: RunAnchor,
): number {
  if (run !== undefined && run.startSegment <= segmentIndex) {
    // ONLY this run's own segments, selected by the run index the playlist
    // URIs carry. Filtering on `index >= run.startSegment` alone would sweep
    // in every LATER run's segments too — their durations describe a
    // different region of the source entirely, which is exactly the error
    // this per-run anchoring exists to remove.
    const ownAll = entries.filter((e) => e.runIndex === run.runIndex);
    const own = ownAll.filter((e) => e.index >= run.startSegment && e.index < segmentIndex);
    let offsetMs = 0;
    for (const e of own) offsetMs += e.durationMs;
    // Expected segment count between the run's start and the requested
    // index; anything missing was pruned (or not yet flushed) and is
    // estimated at THIS RUN's own measured mean, never a cross-run one.
    const missing = segmentIndex - run.startSegment - own.length;
    if (missing > 0) {
      offsetMs += missing * meanDurationMs(ownAll, meanDurationMs(entries, nominalSegmentDurationMs));
    }
    return run.sourceOriginMs + offsetMs;
  }

  if (entries.length === 0) return segmentIndex * nominalSegmentDurationMs;

  const meanMs = meanDurationMs(entries, nominalSegmentDurationMs);
  const firstIndex = entries[0]!.index;
  if (segmentIndex < firstIndex) return segmentIndex * meanMs;

  let cumulativeMs = firstIndex * meanMs;
  let lastCrossedIndex = firstIndex;
  for (const entry of entries) {
    if (entry.index === segmentIndex) return cumulativeMs;
    // A listed index PAST the requested one means `segmentIndex` sits in a
    // gap — stop and extrapolate forward from the last entry crossed.
    if (entry.index > segmentIndex) break;
    cumulativeMs += entry.durationMs;
    lastCrossedIndex = entry.index;
  }
  return cumulativeMs + (segmentIndex - lastCrossedIndex - 1) * meanMs;
}

/**
 * PRESENTATION ms (what a player's `currentTime` reports) -> SOURCE ms.
 *
 * The served playlist is one continuous presentation timeline: the player
 * sums `#EXTINF` values from the start of the playlist regardless of the
 * `EXT-X-DISCONTINUITY` between runs. The SOURCE timeline is not
 * continuous at all — each run restarts at its own `sourceOriginMs`. The
 * two therefore diverge by exactly the accumulated seek offsets, and
 * progress reported in presentation terms is wrong in source terms for
 * every run after the first.
 *
 * The conversion: walk the playlist accumulating presentation time to find
 * the segment containing `presentationMs`, then re-express that segment's
 * position in its OWN run:
 *
 *     source = owningRun.sourceOriginMs
 *            + offset of that segment within its run
 *            + how far into the segment the position sits
 *
 * The within-segment remainder is carried through unchanged for the same
 * reason the offsets are: inside a run, presentation and source advance at
 * the same rate.
 *
 * Returns `undefined` — never a guess — when the mapping cannot be made:
 * no playlist entries, no run rows, or a position past the end of the
 * playlist. Callers must fall back to the client-reported value, which is
 * already correct for every single-run session (run 0's origin is 0, so
 * the mapping is the identity there anyway).
 */
export function presentationToSourceMs(
  entries: readonly ServedSegmentEntry[],
  runs: readonly RunAnchor[],
  presentationMs: number,
): number | undefined {
  if (entries.length === 0 || runs.length === 0) return undefined;
  if (!Number.isFinite(presentationMs) || presentationMs < 0) return undefined;

  // Which segment contains this presentation position?
  let elapsedMs = 0;
  let containing: ServedSegmentEntry | undefined;
  let intoSegmentMs = 0;
  for (const entry of entries) {
    if (presentationMs < elapsedMs + entry.durationMs) {
      containing = entry;
      intoSegmentMs = presentationMs - elapsedMs;
      break;
    }
    elapsedMs += entry.durationMs;
  }
  if (!containing) return undefined;

  // Its owning run — greatest startSegment at or below the index. Ordering
  // is on startSegment and NEVER on sourceOriginMs: a backward seek starts
  // a later run at an earlier source position, so the clock is not
  // monotonic across runs and the segment counter is the only key that is.
  let owner: RunAnchor | undefined;
  for (const run of runs) {
    if (run.startSegment <= containing.index && (owner === undefined || run.startSegment > owner.startSegment)) {
      owner = run;
    }
  }
  if (!owner) return undefined;

  const offsetMs = deriveSegmentStartMs(entries, containing.index, containing.durationMs, owner) - owner.sourceOriginMs;
  return Math.round(owner.sourceOriginMs + offsetMs + intoSegmentMs);
}

/**
 * Adds the two SERVE-TIME sequence tags a retention-pruned playlist needs —
 * `#EXT-X-MEDIA-SEQUENCE` (Wave A) and `#EXT-X-DISCONTINUITY-SEQUENCE`
 * (Wave C2, docs/PLAYBACK.md §9.1.5 rule 3) — to whatever the worker wrote.
 *
 * They are two instances of ONE bug shape, which is why they are computed
 * in one pass here. Retention deletes segments from the FRONT of the served
 * playlist, and RFC 8216 reads BOTH tags, when absent, as 0:
 *
 *   - §4.3.3.2, media sequence: an absent tag means "the first segment
 *     listed is segment number 0", so every prune silently renumbers the
 *     playlist from the client's point of view. hls.js derives each
 *     fragment's `sn` — and the media-time offset it maps a seek to — from
 *     that base, so after a prune its already-buffered fragments stop
 *     lining up with the ones the server is naming.
 *   - §4.3.3.3, discontinuity sequence: removing a discontinuity from the
 *     head without incrementing this counter desynchronizes the client's
 *     own discontinuity counter (hls.js's `cc`), which it uses to decide
 *     whether a fragment belongs to the timeline it is currently
 *     buffering. Wave C2 found this while spec'ing ABR: it is not an ABR
 *     defect at all, it has been reachable since retention landed, and a
 *     rung switch merely makes whole-run pruning routine rather than rare.
 *
 * Both values are DERIVABLE and exact, not estimates. This layer numbers
 * segments absolutely and continuously across every run, so the first
 * surviving segment's own index IS the media sequence number; and because
 * retention prunes from the front while runs are sequential, wholly-pruned
 * runs always form a PREFIX, so that same segment's own `runN` index IS the
 * count of discontinuities the client can no longer see.
 *
 * Each tag is added ONLY when its value is > 0: absent already means 0, and
 * emitting `:0` would be pure noise. An unpruned playlist therefore comes
 * back BYTE-IDENTICAL to what the worker wrote, including its terminal
 * `#EXT-X-ENDLIST` (§9.1.5 rule 4) — this function only ever inserts header
 * lines, never rewrites or reorders the body.
 *
 * Degrades to the input, never throws: an unparseable or empty playlist
 * simply comes back untouched. This runs on the manifest-serving path, and
 * a playlist we cannot tag is still a playlist a client can play.
 */
export function withPlaylistSequenceTags(playlistText: string): string {
  const entries = parseServedSegmentDurations(playlistText);
  const first = entries[0];
  if (first === undefined) return playlistText;

  const tags: string[] = [];
  if (first.index > 0 && !/^#EXT-X-MEDIA-SEQUENCE:/m.test(playlistText)) {
    tags.push(`#EXT-X-MEDIA-SEQUENCE:${first.index}`);
  }
  if (first.runIndex > 0 && !/^#EXT-X-DISCONTINUITY-SEQUENCE:/m.test(playlistText)) {
    tags.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${first.runIndex}`);
  }
  if (tags.length === 0) return playlistText;

  const lines = playlistText.split("\n");
  let insertAfter = lines.findIndex((l) => l.startsWith("#EXT-X-VERSION"));
  if (insertAfter === -1) insertAfter = lines.findIndex((l) => l.startsWith("#EXTM3U"));
  if (insertAfter === -1) return playlistText;

  lines.splice(insertAfter + 1, 0, ...tags);
  return lines.join("\n");
}

/** `[0, durationMs]`. `durationMs` null/non-positive (an unprobed file)
 *  leaves only the lower bound — better an un-ceilinged seek than a seek
 *  clamped to a duration nobody measured. */
export function clampSeekTargetMs(targetMs: number, durationMs: number | null): number {
  const lower = Number.isFinite(targetMs) ? Math.max(0, targetMs) : 0;
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return Math.round(lower);
  return Math.round(Math.min(lower, durationMs));
}
