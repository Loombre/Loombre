// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/gapless.ts
//
// Pure dual-<audio>-element chaining state machine (P2.5 GAPLESS). The DOM
// side (components/music/MusicPlayerProvider.tsx) owns two real
// HTMLAudioElement refs, "A" and "B"; this module owns only the pure
// bookkeeping of which slot is active/preloading and when to flip — kept
// separate so the transition logic is unit-testable without jsdom media
// stubs (jsdom has no real <audio> playback to assert against).
//
// Sequence for one gapless handoff:
//   1. LOAD_ACTIVE(trackId)      -- current track assigned to the active slot
//   2. PRELOAD_NEXT(trackId)     -- called once playback crosses the
//                                   near-end threshold (see shouldPreload);
//                                   next track assigned to the OTHER slot
//   3. TRACK_ENDED                -- active track's 'ended' fired; the
//                                   machine flips `active` to the other slot
//                                   (which is already primed/playing per the
//                                   DOM layer's own 'ended' handler) and
//                                   clears the preload flag
//   4. PRELOAD_NEXT for the NEW next track, repeat from 2.
//
// If TRACK_ENDED fires before a preload was ever requested (e.g. queue
// advanced faster than the near-end threshold, or the next track wasn't
// resolved in time), the machine still flips `active` — the DOM layer is
// responsible for falling back to a fresh (non-gapless) load in that slot,
// which is a real, measured possibility (see the surprises section of the
// wave report for the observed gap in that fallback path vs. the primed
// path).

export type Slot = "A" | "B";

export interface GaplessState {
  active: Slot;
  /** Track id currently loaded into each slot, if known. */
  loaded: Partial<Record<Slot, string>>;
  preloadPending: boolean;
}

export const initialGaplessState: GaplessState = { active: "A", loaded: {}, preloadPending: false };

export function otherSlot(slot: Slot): Slot {
  return slot === "A" ? "B" : "A";
}

export type GaplessEvent =
  | { type: "LOAD_ACTIVE"; trackId: string }
  | { type: "PRELOAD_NEXT"; trackId: string }
  | { type: "TRACK_ENDED" }
  | { type: "CLEAR_PRELOAD" }
  | { type: "RESET" };

export function gaplessReducer(state: GaplessState, event: GaplessEvent): GaplessState {
  switch (event.type) {
    case "LOAD_ACTIVE":
      return { active: state.active, loaded: { [state.active]: event.trackId }, preloadPending: false };

    case "PRELOAD_NEXT": {
      const slot = otherSlot(state.active);
      return { ...state, loaded: { ...state.loaded, [slot]: event.trackId }, preloadPending: true };
    }

    case "TRACK_ENDED":
      return { active: otherSlot(state.active), loaded: state.loaded, preloadPending: false };

    case "CLEAR_PRELOAD": {
      const slot = otherSlot(state.active);
      const loaded = { ...state.loaded };
      delete loaded[slot];
      return { ...state, loaded, preloadPending: false };
    }

    case "RESET":
      return initialGaplessState;

    default:
      return state;
  }
}

/** True once remaining playback time on the active track drops under
 *  `thresholdMs` — the DOM layer calls this from its `timeupdate` handler
 *  to decide when to fire PRELOAD_NEXT. Defaults to 3s, comfortably inside
 *  typical network+decode latency for a same-LAN direct-play file. */
export function shouldPreload(currentTimeMs: number, durationMs: number | null, thresholdMs = 3000): boolean {
  if (durationMs === null || durationMs <= 0) return false;
  return durationMs - currentTimeMs <= thresholdMs && currentTimeMs > 0;
}
