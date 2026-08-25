// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/lib/endlist-eos-watch.ts
//
// d3-a2 follow-up (REOPEN round 1, QA verify 2026-08-25): the
// second-ENDLIST honest-end watch.
//
// Even with the post-ENDLIST MSE rebuild (lib/post-endlist-rebuild.ts)
// clearing hls.js's poisoned state at hard-seek time, a session's LATER
// live→VOD transition can still end dishonestly. The hole (hls.js
// 1.6.16): the FragmentTracker records "the closing fragment is
// appended" ONLY at append time, and only when the appended fragment
// object itself carried `endList` — a bit the m3u8 parser sets on the
// last fragment of a parse that carried #EXT-X-ENDLIST
// (fragment-tracker.ts `bufferedEnd`, m3u8-parser.ts:727). Playlist
// merges build NEW fragment objects each refresh (level-helper.ts
// `mergeDetails`) and never revisit the tracker. Stream end then hinges
// on `isEndListAppended` inside `_streamEnded`
// (base-stream-controller.ts:213, checked from stream-controller.ts
// doTickIdle:272) — the ONLY producer of BUFFER_EOS, which is the only
// path to `mediaSource.endOfStream()` (buffer-controller.ts
// `onBufferEos`:1066). Two failure polarities follow:
//
//   W — the never-ended wedge. The closing fragment is loaded+appended
//     from a refresh parsed BEFORE the ENDLIST refresh. That is exactly
//     where a short post-rebuild seek run puts the client: it chases the
//     live edge, so the last segment buffers within the refresh cadence
//     window while the worker writes ENDLIST one fold later. The tracker
//     entity never gets the endList bit, `isEndListAppended` is false
//     forever, endOfStream is never issued: the MSE duration is never
//     truncated, `currentTime` stalls a frame short of the buffered end,
//     and the element wedges "playing" at the EOF label with 'ended'
//     never fired — progress parks in-progress at ~EOF (verifier 2/2,
//     sessions 01a03903 run6 / 01a03912 run3; once on a first-ENDLIST
//     playout that happened to be at the edge).
//
//   E — the early 'ended'. The mirror image: during a post-rebuild
//     relocation, the nudge-driven reload can re-fetch the OLD run's
//     closing fragment from the still-ENDLIST playlist (parsed fresh,
//     endList=true), re-arming the tracker with a STALE entity the
//     rebuild had just cleared. When the seek run's own ENDLIST later
//     merges, `_streamEnded` passes immediately via that stale entity:
//     BUFFER_EOS fires with only part of the run buffered, 'ended' fires
//     early, and the rest of the run is never requested (live @426cf74,
//     session 01a0392c-ae6e: ended 9.5 s short of the listed edge, DB
//     requested_segment 58 < produced_segment 62).
//
// Neither polarity is preventable from the app (the tracker is not
// public API), so the player arms this watch at every ENDLIST parse
// (LEVEL_UPDATED with details.live === false) and repairs whichever
// polarity manifests:
//
//   W: once the element's buffered ranges cover the closing fragment's
//      midpoint (hls.js's own coverage idiom for end-of-stream parts)
//      and 'ended' has not fired, the caller injects the BUFFER_EOS that
//      hls.js provably cannot produce (`hls.trigger(Events.BUFFER_EOS,
//      {})`). BufferController queues endOfStream AFTER any pending
//      appends and is a no-op when EOS already happened, so a redundant
//      fire on the healthy path costs nothing.
//
//   E: if 'ended' is observed SHORT of the listed edge (beyond half the
//      closing fragment's duration — an honest EOS truncates within
//      frames of the edge; 66 ms observed live), the stream lied. The
//      caller repairs with the SAME detach→attach rebuild lever the hard
//      seek uses, resuming at the ended position: the fresh pipeline
//      re-fetches the missing tail from the CURRENT details, whose
//      closing fragment now carries endList, so the replayed end is
//      honest.
//
// The watch must be suppressed while a hard-seek relocation is in
// flight (a still-ENDLIST re-read mid-relocation re-arms it, and firing
// then would endOfStream the just-rebuilt pipeline at the ABANDONED
// edge), cancelled by any live (un-ended) refresh, by the hard-seek
// rebuild itself, and by teardown. VideoPlayer owns those hooks.

/** Structural TimeRanges (jsdom/tests need no real element). */
export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/** The element surface one tick reads. */
export interface EosWatchMedia {
  readonly ended: boolean;
  readonly currentTime: number;
  readonly buffered: TimeRangesLike;
}

/** 250 ms mirrors hls.js's own stream-controller tick — the watch reacts
 *  on the same cadence the missing check would have. Three property
 *  reads per tick; negligible even over a long armed window. */
export const ENDLIST_EOS_WATCH_INTERVAL_MS = 250;

/** Polarity E's dishonesty threshold: half the closing fragment, floored
 *  at 1 s. An honest EOS lands within frames of the listed edge (66 ms
 *  observed); a truncated stream is short by at least most of a
 *  fragment. */
export function eosShortfallThresholdSec(closingFragmentDurationSec: number): number {
  return Math.max(1, closingFragmentDurationSec / 2);
}

/** hls.js's BufferHelper.isBuffered idiom: inside any range,
 *  end-exclusive. */
export function isBufferedAtSec(buffered: TimeRangesLike, positionSec: number): boolean {
  for (let i = 0; i < buffered.length; i++) {
    if (positionSec >= buffered.start(i) && positionSec < buffered.end(i)) return true;
  }
  return false;
}

export interface EndlistEosWatchOptions {
  /** The element, live per tick (`null` skips the tick). */
  getMedia(): EosWatchMedia | null;
  /** True while a hard-seek relocation owns the pipeline — the tick is
   *  inert (no fire, no stop): the watch acts once the landing settles. */
  isSuppressed(): boolean;
  /** The ENDLIST window's presentation end (listedWindowEndSec of the
   *  parse that armed this watch). */
  edgeSec: number;
  closingFragmentDurationSec: number;
  /** Polarity W: inject BUFFER_EOS. At most once per watch. */
  fireEos(): void;
  /** Polarity E: 'ended' observed short of the edge; receives the ended
   *  position. At most once per watch — the watch stops itself first. */
  repairShortfall(endedAtSec: number): void;
  intervalMs?: number;
}

/** Starts the watch; returns the stop function (idempotent). */
export function startEndlistEosWatch(options: EndlistEosWatchOptions): () => void {
  const { getMedia, isSuppressed, edgeSec, closingFragmentDurationSec, fireEos, repairShortfall } = options;
  const midpointSec = edgeSec - closingFragmentDurationSec / 2;
  const thresholdSec = eosShortfallThresholdSec(closingFragmentDurationSec);
  let eosFired = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  timer = setInterval(() => {
    const media = getMedia();
    if (!media || isSuppressed()) return;
    if (media.ended) {
      // The stream concluded. Honest (within frames of the edge): done.
      // Short of the edge: polarity E — stop first so the repair's own
      // rebuild can re-arm a fresh watch without this one interfering.
      const endedAtSec = media.currentTime;
      stop();
      if (edgeSec - endedAtSec > thresholdSec) repairShortfall(endedAtSec);
      return;
    }
    if (!eosFired && isBufferedAtSec(media.buffered, midpointSec)) {
      // Polarity W: everything the playlist listed is appended and hls.js
      // still hasn't concluded — inject the missing EOS. Keep watching:
      // the resulting 'ended' lands at the truncated duration (honest) and
      // the ended branch above retires the watch.
      eosFired = true;
      fireEos();
    }
  }, options.intervalMs ?? ENDLIST_EOS_WATCH_INTERVAL_MS);
  return stop;
}
