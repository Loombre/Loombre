// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/watchlist-sync.ts
//
// Phosphor Wave 2 lane L3 — design/phosphor README.md's "State management"
// section: "Shared client state: watchlist (id -> bool) ... must sync
// across devices via the events socket". Mirrors lib/now-playing.ts's
// useNowPlayingItemIds() shape: seed from a real fetch, then keep live via
// getEventsSocket() subscriptions to the server's USER_ONLY_TYPES
// watchlist.added/watchlist.removed events (packages/db/src/query/
// events.ts, apps/server/src/gateway/ws-broadcaster.service.ts) — those
// events are delivered to every one of THIS signed-in user's own connected
// sockets (every device/tab), which is the entire cross-device sync
// mechanism; a DIFFERENT user's watchlist changes never arrive here at all
// (server-side gate, not a client-side filter).
//
// SHARED, not per-mount (browser-items-F9): the fetch, the snapshot and
// the socket subscriptions live in lib/watchlist-id-store.ts, and every
// consumer of useWatchlistIds() reads the same one through
// useSyncExternalStore. This hook used to fetch per mount, so the three
// consumers a movie-detail load mounts (desktop WatchlistToggle, mobile
// WatchlistToggle, Sidebar's count) meant three identical
// GET /watchlist?limit=200 — six with dev StrictMode's effect doubling.
// See that module's header for the store's freshness/reset rules.
//
// Bounded, not exhaustively paginated: there is no dedicated aggregate-count
// endpoint for the watchlist (unlike GET /restricted/count, which exists
// specifically because the zone needs one) — the sidebar count and the
// toggle's "is this item already watchlisted" check are both DERIVED from
// this same bounded page, matching the "counts are derived, never stored"
// rule (STATE.md's Home rows also derive user/restricted-profile counts
// rather than persisting them). The store's fetch limit is generous enough
// that a realistic watchlist never hits it; a watchlist that DOES exceed it
// shows "N+" (see `atCapacity` below) rather than silently under-counting.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { getEventsSocket } from "./events-socket.js";
import {
  getWatchlistIdsServerSnapshot,
  getWatchlistIdsSnapshot,
  markWatchlistIdAdded,
  markWatchlistIdRemoved,
  subscribeWatchlistIds,
} from "./watchlist-id-store.js";

interface WatchlistAddedPayload {
  userId: string;
  itemId: string;
}
interface WatchlistRemovedPayload {
  userId: string;
  itemId: string;
}

export interface UseWatchlistIdsResult {
  /** The live Set of itemIds currently in the caller's watchlist, per this
   *  client's view (seeded fetch + optimistic writes + socket deltas). */
  ids: ReadonlySet<string>;
  /** True until the shared initial GET /watchlist page resolves. */
  loading: boolean;
  /** True when the bounded fetch hit its limit with more pages left —
   *  `ids.size` (and any count derived from it) is a floor, not exact. */
  atCapacity: boolean;
  /** Optimistically marks an id present RIGHT NOW, without waiting for the
   *  watchlist.added event to round-trip back over the socket (that event
   *  still arrives and is a harmless idempotent no-op) — callers invoke
   *  this the instant their own PUT /watchlist/{itemId} resolves, so the
   *  UI that triggered the change never has to wait on the poll interval.
   *  It writes the SHARED set, so every other consumer (the twin toggle in
   *  the other responsive tree, the sidebar count) updates with it. */
  markAdded: (itemId: string) => void;
  /** Same optimistic-update rationale as markAdded, for the DELETE side. */
  markRemoved: (itemId: string) => void;
}

/** React hook: the shared "watchlist (id -> bool)" client state the README
 *  calls for. Every consumer (Sidebar's count, WatchlistToggle's initial
 *  state) reads ONE shared store — one in-flight/settled GET /watchlist and
 *  one socket subscription pair for the whole app, however many consumers
 *  are mounted (browser-items-F9; see lib/watchlist-id-store.ts). */
export function useWatchlistIds(): UseWatchlistIdsResult {
  const snapshot = useSyncExternalStore(
    subscribeWatchlistIds,
    getWatchlistIdsSnapshot,
    getWatchlistIdsServerSnapshot,
  );

  return {
    ids: snapshot.ids,
    loading: snapshot.loading,
    atCapacity: snapshot.atCapacity,
    markAdded: markWatchlistIdAdded,
    markRemoved: markWatchlistIdRemoved,
  };
}

/** Subscribes to both watchlist events purely to trigger a caller-supplied
 *  refetch — used by the /watchlist route and Home's "Your Watchlist" rail,
 *  which both need the FULL entry (title/poster), not just the id set
 *  useWatchlistIds() tracks, so they keep their own fetch and only need the
 *  "something changed, go re-fetch" signal from here. `onChange` is read via
 *  a ref (updated every render) so the socket subscription itself is
 *  established exactly once per mount without going stale against whichever
 *  render happened to be current when it first subscribed. */
export function useWatchlistChangeSignal(onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const socket = getEventsSocket();
    const unsubscribers = [
      socket.subscribe<WatchlistAddedPayload>("watchlist.added", () => onChangeRef.current()),
      socket.subscribe<WatchlistRemovedPayload>("watchlist.removed", () => onChangeRef.current()),
    ];
    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }, []);
}
