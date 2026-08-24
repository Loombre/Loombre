// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/source-clock.ts
//
// browser-player-F6 (QA 2026-08-20/21, P2): the displayed source-time
// clock, made AUTHORITATIVE. VideoPlayer's `timeupdate` handler used to
// map the element's presentation position through the CURRENT hls.js
// level's listed fragments and silently fall back to the raw presentation
// axis whenever that mapping came back null — which happens transiently
// after every hard-seek restart while level details refresh and whenever
// ABR switches to a level whose details are stale. Live at HEAD the label
// rode the wrong axis for 5-40 s (off by 20-50 minutes), and a heartbeat
// tick landing in that window persisted the wrong axis into /progress.
//
// The model here (pure — no hls.js, no DOM, no clock): one small state
// record the player threads through every mapping decision.
//
//   - `sawSourceClock` is STICKY: once a listed window has carried the V8
//     source clock (docs/PLAYBACK.md §9.1.5 rule 7 PDT), this session's
//     positions are source-axis forever — a later unreadable/clockless
//     window must never flip the display back to presentation numbers.
//   - `runFloor` is the highest `runN` index known to exist (raised by
//     every hard-seek landing and every trusted mapping). A window whose
//     highest listed run sits BELOW the floor predates a restart the
//     player has already seen land — its PDTs describe the OLD timeline
//     at these presentation positions, so mapping through it is rejected
//     outright (the "1:04:22 on the old timeline" half of the finding).
//   - `anchor` is the last AUTHORITATIVE (presentation, source) pair —
//     refreshed by every trusted window mapping, by every hard-seek
//     landing (the landed fragment's own PDT/run origin), and by every
//     soft-seek commit. Within a run the two axes advance 1:1 (§9.1.6),
//     so while no trustworthy window exists the anchor extrapolates the
//     clock exactly — "monotonic from the landed target" — instead of
//     freezing or lying.
//
// When even the anchor cannot answer (never anchored, or the position has
// drifted implausibly far from it), the resolver returns `ms: null` and
// the caller HOLDS the last displayed value: a briefly-stale source time
// over a wrong-axis number, always.

import {
  hasSourceClock,
  maxListedRunIndex,
  presentationToSourceMs,
  runIndexOfRelurl,
  type ListedFragment,
} from "./source-time.js";

/** The last authoritative (presentation, source) pair. */
export interface SourceClockAnchor {
  presentationSec: number;
  sourceMs: number;
}

export interface SourceClockState {
  /** Sticky: a listed window carried the V8 source clock at least once. */
  sawSourceClock: boolean;
  /** Highest `runN` index known to exist; -1 before any run is seen.
   *  Windows topping out below it are stale — pre-restart PDTs. */
  runFloor: number;
  anchor: SourceClockAnchor | null;
}

export function initialSourceClockState(): SourceClockState {
  return { sawSourceClock: false, runFloor: -1, anchor: null };
}

/**
 * How far (presentation seconds, either direction) the anchor may
 * extrapolate before the resolver prefers HOLDING the display instead.
 * Within a run extrapolation is exact at any distance, but an anchor can
 * only be KNOWN to share the element's run near where it was minted —
 * every observed desync window (live: 5-40 s of stale/unreadable details
 * on a ~6 s refresh cadence) sits comfortably inside this; anything
 * beyond it means the mapping never recovered and a frozen honest clock
 * beats a possibly-wrong advancing one.
 */
export const ANCHOR_EXTRAPOLATION_LIMIT_SEC = 120;

/** Which authority produced a resolved position. */
export type SourceClockAxis = "source-window" | "source-anchor" | "presentation";

export interface ResolvedDisplayPosition {
  state: SourceClockState;
  /** The position to display (ms), or `null` = HOLD the last displayed
   *  value — no trustworthy mapping exists right now. */
  ms: number | null;
  axis: SourceClockAxis | null;
}

/**
 * A hard-seek landing names the seek-spawned run and its origin — the
 * moment the source mapping becomes authoritative (owner ruling on
 * browser-player-F6). The landed fragment's own PDT at its presentation
 * start is an exact axis pair, and its run index raises the floor that
 * invalidates every pre-seek window. A fragment without a PDT or run
 * prefix cannot anchor (findLandingFragment never yields one).
 */
export function anchorAtLanding(state: SourceClockState, landing: ListedFragment): SourceClockState {
  if (landing.programDateTimeMs === null) return state;
  const runIndex = runIndexOfRelurl(landing.relurl);
  return {
    sawSourceClock: true,
    runFloor: runIndex !== undefined && runIndex > state.runFloor ? runIndex : state.runFloor,
    anchor: { presentationSec: landing.startSec, sourceMs: landing.programDateTimeMs },
  };
}

/** A soft-seek commit is an exact axis pair too: the player chose the
 *  source target and computed its presentation position through a listed
 *  window (VideoPlayer's seek()). */
export function anchorAtExplicitPosition(
  state: SourceClockState,
  presentationSec: number,
  sourceMs: number,
): SourceClockState {
  return { ...state, sawSourceClock: true, anchor: { presentationSec, sourceMs } };
}

/**
 * Resolve the position to DISPLAY for the element's current presentation
 * position, in authority order:
 *
 *  1. A TRUSTED listed window (carries the clock, tops out at/after
 *     `runFloor`) mapping the position — authoritative; refreshes the
 *     anchor and may raise the floor.
 *  2. The presentation axis — but ONLY while the session has never shown
 *     a source clock (direct-play, native path, pre-V8 server), where the
 *     axes coincide by construction.
 *  3. The anchor, extrapolated 1:1 (§9.1.6) within its limit.
 *  4. `null` — HOLD whatever is displayed; never a wrong-axis number.
 */
export function resolveDisplayedSourceMs(
  state: SourceClockState,
  fragments: readonly ListedFragment[] | null,
  presentationSec: number,
): ResolvedDisplayPosition {
  const windowHasClock = fragments !== null && hasSourceClock(fragments);
  if (windowHasClock) {
    const maxRun = maxListedRunIndex(fragments);
    if (maxRun >= state.runFloor) {
      const mapped = presentationToSourceMs(fragments, presentationSec);
      if (mapped !== null) {
        return {
          state: {
            sawSourceClock: true,
            runFloor: maxRun > state.runFloor ? maxRun : state.runFloor,
            anchor: { presentationSec, sourceMs: mapped },
          },
          ms: mapped,
          axis: "source-window",
        };
      }
    }
  }
  if (!state.sawSourceClock && !windowHasClock) {
    return { state, ms: Math.round(presentationSec * 1000), axis: "presentation" };
  }
  const next = windowHasClock && !state.sawSourceClock ? { ...state, sawSourceClock: true } : state;
  const anchor = next.anchor;
  if (anchor !== null && Math.abs(presentationSec - anchor.presentationSec) <= ANCHOR_EXTRAPOLATION_LIMIT_SEC) {
    return {
      state: next,
      ms: Math.round(anchor.sourceMs + (presentationSec - anchor.presentationSec) * 1000),
      axis: "source-anchor",
    };
  }
  return { state: next, ms: null, axis: null };
}
