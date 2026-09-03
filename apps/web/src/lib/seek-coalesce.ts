// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/lib/seek-coalesce.ts
//
// SPF-5: rapid hard seeks (a scrubber drag, or a user mashing the seek
// buttons) each POST /playback/sessions/{id}/seek — every POST is a real
// worker restart (docs/PLAYBACK.md §9.1.9), so N hard seeks issued a few
// milliseconds apart used to spawn N restarts, most of them thrown away
// before their first segment ever encoded. This module is the PURE
// decision rule only: given when the previous hard seek was actually
// DISPATCHED and the current time, should this call dispatch immediately
// or wait? It knows nothing about POSTs, epochs, or the UI — the caller
// (VideoPlayer's hardSeek) owns the trailing timer and "newest wins"
// target replacement.
//
// Policy: the LEADING edge always dispatches immediately (so a single,
// isolated hard seek behaves exactly as before — zero added latency). A
// hard seek issued within HARD_SEEK_COALESCE_MS of the previous
// DISPATCH is deferred; the caller collapses any further seeks that
// arrive before the deferred one fires into a single trailing dispatch
// carrying the newest target.

/** Coalescing window, in milliseconds. Small enough that a deliberate
 *  second seek (a user releasing a drag, then dragging again) never feels
 *  delayed, large enough to collapse the handful of rapid-fire calls a
 *  single scrubber gesture or a mashed seek button produces. */
export const HARD_SEEK_COALESCE_MS = 150;

export type HardSeekDispatchDecision = { immediate: true } | { immediate: false; deferMs: number };

/**
 * Decides whether a hard seek issued at `nowMs` should dispatch right
 * away or be deferred, given `lastDispatchAtMs` — the time the PREVIOUS
 * hard seek actually dispatched (not merely when it was requested; a
 * deferred seek's own eventual dispatch becomes the new baseline).
 * `null` (nothing has dispatched yet) always dispatches immediately.
 */
export function decideHardSeekDispatch(lastDispatchAtMs: number | null, nowMs: number): HardSeekDispatchDecision {
  if (lastDispatchAtMs === null) return { immediate: true };
  const elapsedMs = nowMs - lastDispatchAtMs;
  if (elapsedMs >= HARD_SEEK_COALESCE_MS) return { immediate: true };
  return { immediate: false, deferMs: HARD_SEEK_COALESCE_MS - elapsedMs };
}
