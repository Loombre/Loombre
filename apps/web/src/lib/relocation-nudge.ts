// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/lib/relocation-nudge.ts
//
// V8 hard-seek discovery-latency fix (docs/PLAYBACK.md §9.1.9, 2026-08-20).
//
// After a hard seek's 202, the server side is FAST: the worker's control
// loop ticks every 250 ms, a video-copy restart writes its first segment in
// ~0.2 s, and the fold lands it in the served playlist on the next tick —
// well under a second end to end. The client was the slow half: hls.js
// re-reads a live playlist only on its own targetduration cadence, so run
// DISCOVERY alone cost up to ~6 s of the observed seek latency. While
// relocating, force a playlist re-read once per second instead.
//
// stopLoad()/startLoad(-1) is hls.js's own documented "reload now" lever —
// the exact pair its fatal-network-error recovery uses; startLoad(-1)
// resumes from the media element's current position. Aborting an in-flight
// fragment load mid-relocation is free: the pre-seek position's buffer is
// already abandoned. The nudge never fires synchronously (the restarted
// run cannot be in the playlist at 202 time), checks `isRelocating` per
// tick so a landing that raced the timer goes quiet immediately, and is
// stopped by clearLandingWatch (landing, timeout, re-seek, unmount).

/** The hls.js surface the nudge drives (structural, so tests need no
 *  hls.js instance): the stopLoad/startLoad reload lever plus the level
 *  list the gap-F4 ENDLIST re-open below acts on. */
export interface PlaylistReloader {
  stopLoad(): void;
  startLoad(startPosition?: number): void;
  levels: ReloaderLevel[];
}

/** Structural mirror of hls.js `Level` — only the field the ENDLIST
 *  re-open touches. `details` is hls.js's parsed playlist state; both it
 *  and its `live` flag are public in hls.js's own types. */
export interface ReloaderLevel {
  details?: ReloaderLevelDetails;
}

export interface ReloaderLevelDetails {
  /** hls.js `LevelDetails.live` — false once the parsed playlist carried
   *  `#EXT-X-ENDLIST`. */
  live: boolean;
}

/**
 * gap-F4 (§9.1.5 rule 5 / amendment A1): make an ENDLIST-frozen client
 * model reloadable again. hls.js's BasePlaylistController.
 * `shouldLoadPlaylist` refuses to reload any level whose details are VOD
 * (`!details || details.live` is its gate), so once a served playlist has
 * carried `#EXT-X-ENDLIST` BOTH reload levers — a bare `startLoad()` and
 * this module's stopLoad/startLoad pair — are inert. A post-ENDLIST hard
 * seek un-ends the playlist SERVER-side (new run, tag gone), but the
 * client would never re-read it: the landing watch could never fire and
 * the seek died into the 20 s timeout (the "swallowed hard seek" of the
 * 2026-08-20/21 QA report). Flipping `details.live` back to true is the
 * minimal public-property un-freeze: the next reload then merges the
 * un-ended playlist normally, and a reload that raced the worker restart
 * (still-ENDLIST) simply re-freezes until the next tick re-opens again.
 * Returns whether any level was re-opened.
 */
export function reopenEndedLevels(hls: Pick<PlaylistReloader, "levels">): boolean {
  let reopened = false;
  for (const level of hls.levels) {
    if (level.details && level.details.live === false) {
      level.details.live = true;
      reopened = true;
    }
  }
  return reopened;
}

/** Once per second: fast enough that discovery adds ≤1 s to a seek that
 *  the server completes in well under a second, slow enough that the tiny
 *  playlist GET (a few KB, same origin) is negligible even over the 20 s
 *  landing timeout's worst case (docs/PLAYBACK.md §9.1.9). */
export const HARD_SEEK_REFRESH_NUDGE_MS = 1_000;

/** Starts the relocation nudge loop. Returns the stop function. */
export function startRelocationNudge(
  getReloader: () => PlaylistReloader | null,
  isRelocating: () => boolean,
  intervalMs: number = HARD_SEEK_REFRESH_NUDGE_MS,
): () => void {
  const timer = setInterval(() => {
    if (!isRelocating()) return;
    const hls = getReloader();
    if (!hls) return;
    // EVERY tick, not just the first: a re-read that raced the worker
    // restart returns a still-ENDLIST playlist, which re-freezes the
    // level (parsed live:false) — see reopenEndedLevels above.
    reopenEndedLevels(hls);
    hls.stopLoad();
    hls.startLoad(-1);
  }, intervalMs);
  return () => clearInterval(timer);
}
