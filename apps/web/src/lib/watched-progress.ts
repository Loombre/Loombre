// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/watched-progress.ts
//
// gap-F6 (QA 2026-08-20/21, P1): progress writes need REAL playback
// advancement, never a relocated origin. A fresh, untouched direct-stream
// session self-relocated server-side (run0→run7 implicit-seek churn); the
// element sat wedged at presentation 0 / readyState 1, but presentation 0
// mapped through the RELOCATED run's PDT origin to source ~7:31 — and the
// heartbeat wrote that as progress for content never watched, which then
// silently seeded the NEXT session's resume point.
//
// The player therefore keeps a WATCHED position — the last position backed
// by evidence the viewer actually got there — separate from the DISPLAYED
// position (which legitimately tracks the mapped element position at all
// times). Only the watched position is ever written to /progress. It is
// updated by exactly two things:
//   1. real playback advancement (this module's predicate), observed
//      between consecutive `timeupdate` samples; and
//   2. an explicit user seek (the player's own seek funnel — deliberate
//      intent needs no advancement first; a paused user who drags to
//      30:00 and leaves DID choose that resume point).
// A session in which neither ever happens writes NOTHING — no phantom
// rows for content never watched.

/** HTMLMediaElement.readyState HAVE_CURRENT_DATA — below this the element
 *  has never displayed the current position, so it cannot be "watching". */
const HAVE_CURRENT_DATA = 2;

/**
 * The largest presentation-time step between two consecutive `timeupdate`
 * samples that can still be ordinary playback. `timeupdate` fires every
 * 15–250ms in a foreground tab (WHATWG) and roughly every second in a
 * throttled background tab; even at 2x playbackRate that is ~2s of media
 * per sample. Anything larger is a discontinuity — a seek (the funnel
 * records those as intent) or a RELOCATION (hls.js/MSE moving the
 * element's position under a playlist whose runs moved on), which is
 * exactly what must never count as watching.
 */
export const MAX_REAL_ADVANCEMENT_STEP_SEC = 3;

/**
 * Did the element genuinely play forward between two consecutive
 * `timeupdate` samples?
 *
 * - `previousSec === null`: first sample after (re)attach — a baseline,
 *   never advancement (a single sample proves presence, not motion).
 * - backward / frozen: not advancement (the gap-F6 wedge sat frozen at 0).
 * - a step larger than `MAX_REAL_ADVANCEMENT_STEP_SEC`: a discontinuity,
 *   not playback (see above).
 * - `paused`: a paused element's clock only moves by seeks/assignments,
 *   which are intent, not advancement — the seek funnel handles those.
 * - `readyState < HAVE_CURRENT_DATA`: nothing is displayed at this
 *   position, so nobody is watching it (readyState 1 was precisely the
 *   observed wedge state).
 */
export function isRealPlaybackAdvancement(
  previousSec: number | null,
  currentSec: number,
  readyState: number,
  paused: boolean,
): boolean {
  if (previousSec === null) return false;
  if (paused) return false;
  if (readyState < HAVE_CURRENT_DATA) return false;
  const stepSec = currentSec - previousSec;
  return stepSec > 0 && stepSec <= MAX_REAL_ADVANCEMENT_STEP_SEC;
}

/**
 * How far (ms, source axis) an advancement-driven watched-position update
 * may sit from the last watched position (or, before anything was watched,
 * from the position the viewer INTENDED to start at — resume point,
 * deep-link offset, or 0). Comfortably above the presentation-step cap so
 * ordinary playback (which moves both axes together, a few hundred ms per
 * sample) always passes, and far below any relocation.
 */
export const MAX_SOURCE_STEP_MS = 10_000;

/**
 * Second half of the gap-F6 gate — observed live: the element can be
 * GENUINELY advancing (playing out its buffer) while the playlist has
 * relocated underneath it, so the presentation→source MAPPING of those
 * positions is a lie (presentation ~12s mapped to source ~6:50 through
 * the relocated run's PDT origin). Presentation-axis advancement alone
 * would launder that lie into a progress row. A mapped position may only
 * become the watched position when it is CONTINUOUS with what was already
 * watched (or with the intended start) on the SOURCE axis too.
 *
 * Deliberate failure mode: after a large un-asked-for source jump, the
 * watched position FREEZES (conservatively stale) until real continuity
 * returns or the user seeks (the seek funnel re-anchors) — a slightly-old
 * resume point over a phantom one, always.
 */
export function isSourceContinuous(watchedMs: number | null, candidateMs: number, intendedStartMs: number): boolean {
  const anchorMs = watchedMs ?? intendedStartMs;
  return Math.abs(candidateMs - anchorMs) <= MAX_SOURCE_STEP_MS;
}
