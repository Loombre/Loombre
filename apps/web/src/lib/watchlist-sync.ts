// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/watchlist-sync.ts
//
// Phosphor Wave 2 lane L3 — design/phosphor README.md's "State management"
// section: "Shared client state: watchlist (id -> bool) ... must sync
// across devices via the events socket". Mirrors lib/now-playing.ts's
// useNowPlayingItemIds() shape exactly: seed from a real fetch, then keep
// live via getEventsSocket() subscriptions to the server's USER_ONLY_TYPES
// watchlist.added/watchlist.removed events (packages/db/src/query/
// events.ts, apps/server/src/gateway/ws-broadcaster.service.ts) — those
// events are delivered to every one of THIS signed-in user's own connected
// sockets (every device/tab), which is the entire cross-device sync
// mechanism; a DIFFERENT user's watchlist changes never arrive here at all
// (server-side gate, not a client-side filter).
//
// Bounded, not exhaustively paginated: there is no dedicated aggregate-count
// endpoint for the watchlist (unlike GET /restricted/count, which exists
// specifically because the zone needs one) — the sidebar count and the
// toggle's "is this item already watchlisted" check are both DERIVED from
// this same bounded page, matching the "counts are derived, never stored"
// rule (STATE.md's Home rows also derive user/restricted-profile counts
// rather than persisting them). ID_FETCH_LIMIT is generous enough that a
// realistic watchlist never hits it; a watchlist that DOES exceed it shows
// "N+" (see useWatchlistIds' `atCapacity` flag) rather than silently
// under-counting.

import { useEffect, useRef, useState } from "react";
import { apiGet } from "./api-client.js";
import { getEventsSocket, type EventEnvelope } from "./events-socket.js";

interface WatchlistAddedPayload {
  userId: string;
  itemId: string;
}
interface WatchlistRemovedPayload {
  userId: string;
  itemId: string;
}

/** Generous bound for the "derived" id set (sidebar count, toggle initial
 *  state) — see this module's header. */
const ID_FETCH_LIMIT = 200;

export interface UseWatchlistIdsResult {
  /** The live Set of itemIds currently in the caller's watchlist, per this
   *  client's view (seeded fetch + live socket deltas). */
  ids: ReadonlySet<string>;
  /** True until the initial GET /watchlist page resolves. */
  loading: boolean;
  /** True when the bounded fetch hit ID_FETCH_LIMIT with more pages left —
   *  `ids.size` (and any count derived from it) is a floor, not exact. */
  atCapacity: boolean;
  /** Optimistically marks an id present RIGHT NOW, without waiting for the
   *  watchlist.added event to round-trip back over the socket (that event
   *  still arrives and is a harmless idempotent no-op) — callers invoke
   *  this the instant their own PUT /watchlist/{itemId} resolves, so the
   *  UI that triggered the change never has to wait on the poll interval. */
  markAdded: (itemId: string) => void;
  /** Same optimistic-update rationale as markAdded, for the DELETE side. */
  markRemoved: (itemId: string) => void;
}

/** React hook: the shared "watchlist (id -> bool)" client state the README
 *  calls for. Every consumer (Sidebar's count, WatchlistToggle's initial
 *  state) mounts its own instance — consistent with this codebase's
 *  existing per-route-remount posture (Sidebar/AppShell are NOT persisted
 *  across navigation, see AppProviders.tsx's header), not a singleton
 *  cache. */
export function useWatchlistIds(): UseWatchlistIdsResult {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [atCapacity, setAtCapacity] = useState(false);

  useEffect(() => {
    let cancelled = false;

    apiGet("/watchlist", { params: { query: { limit: ID_FETCH_LIMIT } } })
      .then((page) => {
        if (cancelled) return;
        setIds(new Set(page.items.map((entry) => entry.item.id)));
        setAtCapacity(page.nextCursor !== null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    const socket = getEventsSocket();
    const unsubscribers = [
      socket.subscribe<WatchlistAddedPayload>("watchlist.added", (e: EventEnvelope<WatchlistAddedPayload>) => {
        setIds((prev) => (prev.has(e.payload.itemId) ? prev : new Set(prev).add(e.payload.itemId)));
      }),
      socket.subscribe<WatchlistRemovedPayload>("watchlist.removed", (e: EventEnvelope<WatchlistRemovedPayload>) => {
        setIds((prev) => {
          if (!prev.has(e.payload.itemId)) return prev;
          const next = new Set(prev);
          next.delete(e.payload.itemId);
          return next;
        });
      }),
    ];

    return () => {
      cancelled = true;
      for (const unsub of unsubscribers) unsub();
    };
  }, []);

  return {
    ids,
    loading,
    atCapacity,
    markAdded: (itemId: string) => setIds((prev) => (prev.has(itemId) ? prev : new Set(prev).add(itemId))),
    markRemoved: (itemId: string) =>
      setIds((prev) => {
        if (!prev.has(itemId)) return prev;
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      }),
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
