// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/queue.ts
//
// Pure music-queue state + reducer (P2.5). No DOM, no fetch — the
// MusicPlayerProvider (components/music/) owns the <audio> elements and
// session lifecycle; this module owns only "what track is where in the
// queue" so it is independently unit-testable (fake-timer-free, plain
// reducer tests).

export interface QueueTrack {
  /** Unique per queue ENTRY (not per track — the same track can be queued
   *  twice), so React keys and reorder/remove operations are unambiguous. */
  entryId: string;
  itemId: string;
  title: string;
  subtitle: string | null;
  albumId: string | null;
  durationMs: number | null;
  blurhash: string | null;
}

export interface QueueState {
  items: QueueTrack[];
  /** Index into `items`, or null when nothing is queued/current. */
  currentIndex: number | null;
}

export type QueueAction =
  | { type: "SET_QUEUE"; tracks: QueueTrack[]; startIndex?: number }
  | { type: "ENQUEUE"; track: QueueTrack }
  | { type: "PLAY_NOW"; track: QueueTrack }
  | { type: "REMOVE"; entryId: string }
  | { type: "REORDER"; from: number; to: number }
  | { type: "NEXT" }
  | { type: "PREV" }
  | { type: "JUMP_TO"; entryId: string }
  | { type: "CLEAR" };

export const initialQueueState: QueueState = { items: [], currentIndex: null };

export function currentTrack(state: QueueState): QueueTrack | null {
  return state.currentIndex === null ? null : (state.items[state.currentIndex] ?? null);
}

export function peekNextTrack(state: QueueState): QueueTrack | null {
  if (state.currentIndex === null) return null;
  return state.items[state.currentIndex + 1] ?? null;
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "SET_QUEUE": {
      const startIndex = action.startIndex ?? 0;
      if (action.tracks.length === 0) return { items: [], currentIndex: null };
      return {
        items: action.tracks,
        currentIndex: Math.min(Math.max(startIndex, 0), action.tracks.length - 1),
      };
    }

    case "ENQUEUE": {
      const items = [...state.items, action.track];
      return { items, currentIndex: state.currentIndex ?? items.length - 1 };
    }

    case "PLAY_NOW": {
      // Inserted immediately after the current track and made current, so
      // "play now" never loses the rest of the queue behind it.
      const insertAt = state.currentIndex === null ? 0 : state.currentIndex + 1;
      const items = [...state.items];
      items.splice(insertAt, 0, action.track);
      return { items, currentIndex: insertAt };
    }

    case "REMOVE": {
      const removeIndex = state.items.findIndex((t) => t.entryId === action.entryId);
      if (removeIndex === -1) return state;
      const items = state.items.filter((t) => t.entryId !== action.entryId);
      if (state.currentIndex === null) return { items, currentIndex: null };
      if (items.length === 0) return { items, currentIndex: null };
      let currentIndex = state.currentIndex;
      if (removeIndex < state.currentIndex) currentIndex -= 1;
      else if (removeIndex === state.currentIndex) currentIndex = Math.min(currentIndex, items.length - 1);
      return { items, currentIndex };
    }

    case "REORDER": {
      const { from, to } = action;
      if (from < 0 || from >= state.items.length || to < 0 || to >= state.items.length || from === to) {
        return state;
      }
      const items = [...state.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved!);

      let currentIndex = state.currentIndex;
      if (currentIndex !== null) {
        if (currentIndex === from) currentIndex = to;
        else if (from < currentIndex && to >= currentIndex) currentIndex -= 1;
        else if (from > currentIndex && to <= currentIndex) currentIndex += 1;
      }
      return { items, currentIndex };
    }

    case "NEXT": {
      if (state.currentIndex === null) return state;
      const nextIndex = state.currentIndex + 1;
      if (nextIndex >= state.items.length) return { ...state, currentIndex: null };
      return { ...state, currentIndex: nextIndex };
    }

    case "PREV": {
      if (state.currentIndex === null) return state;
      const prevIndex = Math.max(0, state.currentIndex - 1);
      return { ...state, currentIndex: prevIndex };
    }

    case "JUMP_TO": {
      const index = state.items.findIndex((t) => t.entryId === action.entryId);
      if (index === -1) return state;
      return { ...state, currentIndex: index };
    }

    case "CLEAR":
      return initialQueueState;

    default:
      return state;
  }
}
