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

/** The two hls.js methods the nudge drives (structural, so tests need no
 *  hls.js instance). */
export interface PlaylistReloader {
  stopLoad(): void;
  startLoad(startPosition?: number): void;
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
    hls.stopLoad();
    hls.startLoad(-1);
  }, intervalMs);
  return () => clearInterval(timer);
}
