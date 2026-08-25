// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/watchlist-id-store.ts
//
// THE module-level store behind useWatchlistIds() (lib/watchlist-sync.ts)
// — browser-items-F9. The watchlist id set is ONE piece of server state
// that cannot legitimately differ between two consumers in the same
// render, yet every consumer used to mount its OWN GET /watchlist?limit=200
// plus its own pair of events-socket subscriptions: a movie-detail load
// mounts three (desktop WatchlistToggle, mobile WatchlistToggle, Sidebar's
// derived count) and the audited build fired six identical requests
// (dev StrictMode re-invokes each effect). All consumers now share one
// in-flight/settled fetch, one snapshot, and one socket subscription pair
// — the same shared-loader discipline as restricted-zone-count.ts
// (AUD-A4v6-003), which this module deliberately mirrors line for line.
//
// Deliberately its OWN module rather than more exports on watchlist-sync.ts
// or api-client.ts: both of those are vi.mock'd wholesale by component
// tests (app/home/page.test.tsx replaces watchlist-sync's entire export
// surface with a factory), so growing their public API is how a mocked
// module silently loses a real export.
//
// Freshness, in order of authority:
//   1. the bounded GET /watchlist page seeds the set (see watchlist-sync.ts
//      for why bounded, and what `atCapacity` means);
//   2. this tab's own writes patch it optimistically the instant a
//      PUT/DELETE /watchlist/{itemId} resolves (markWatchlistIdAdded /
//      markWatchlistIdRemoved) — with one shared set, the toggle that ran
//      the write, its twin in the other responsive tree, and the sidebar
//      count all update together instead of waiting for the socket;
//   3. watchlist.added/watchlist.removed events (this user's OTHER
//      devices/tabs) apply through those same two functions, idempotently.
// Nothing is cached beyond the lifetime of the consumers: when the last
// one unmounts the store resets, so the next mount re-seeds from the
// server rather than trusting a page of unknown age (a sign-out unmounts
// the shell, so a user switch in the same tab can never inherit the
// previous session's ids).
//
// A FAILED seed is not permanent (d4-w1). That reset is the store's only
// re-seed trigger, and it needs the listener set to drain to 0 — which
// never happens while the Sidebar's watchlist count is mounted, i.e. for
// the whole session. So a rejected fetch is remembered (`lastLoadFailed`)
// and the next consumer to subscribe retries it; see subscribeWatchlistIds.

import { apiGet } from "./api-client.js";
import { getEventsSocket, type EventEnvelope } from "./events-socket.js";

interface WatchlistEventPayload {
  userId: string;
  itemId: string;
}

/** Generous bound for the "derived" id set — see watchlist-sync.ts's
 *  header for why the watchlist is read as one bounded page. */
const ID_FETCH_LIMIT = 200;

export interface WatchlistIdsSnapshot {
  /** The live Set of itemIds currently in the caller's watchlist, per this
   *  client's view (seeded fetch + optimistic writes + socket deltas). */
  ids: ReadonlySet<string>;
  /** True until the shared GET /watchlist page resolves (or fails). */
  loading: boolean;
  /** True when the bounded fetch hit ID_FETCH_LIMIT with more pages left. */
  atCapacity: boolean;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const INITIAL: WatchlistIdsSnapshot = { ids: EMPTY_IDS, loading: true, atCapacity: false };

let snapshot: WatchlistIdsSnapshot = INITIAL;
const listeners = new Set<() => void>();
/** Bumped on every load AND on reset, so a response that was superseded
 *  (or landed after a reset) is discarded — the shared-store equivalent of
 *  the old per-mount `cancelled` flag. */
let fetchSeq = 0;
let inFlight = false;
/** True while the last settled attempt REJECTED (d4-w1). The failure is
 *  fail-soft — see the catch below — but it must not be permanent: the
 *  reset that normally re-seeds the store runs only when the listener set
 *  drains to 0, and the Sidebar's watchlist count is mounted for the whole
 *  session, so with it subscribed that never happens. Cleared by the next
 *  successful load and by reset(). */
let lastLoadFailed = false;
let socketUnsubscribers: Array<() => void> = [];

function emit(next: WatchlistIdsSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function reset(): void {
  fetchSeq++;
  inFlight = false;
  lastLoadFailed = false;
  snapshot = INITIAL;
}

function load(): void {
  const seq = ++fetchSeq;
  inFlight = true;
  // A RETRY (the cold start is already `loading`): re-enter loading so no
  // consumer presents the failed snapshot as settled truth while the second
  // attempt is out — the Sidebar count blanks instead of rendering a wrong
  // 0, and WatchlistToggle stays disabled instead of offering "Watchlist"
  // for an item that may well already be on it.
  if (!snapshot.loading) {
    emit({ ids: snapshot.ids, loading: true, atCapacity: snapshot.atCapacity });
  }
  apiGet("/watchlist", { params: { query: { limit: ID_FETCH_LIMIT } } })
    .then((page) => {
      if (seq !== fetchSeq) return;
      inFlight = false;
      lastLoadFailed = false;
      // Landed after the last consumer went away (the remount never came):
      // discard it rather than keep a page nobody is watching live.
      if (listeners.size === 0) {
        reset();
        return;
      }
      emit({
        ids: new Set(page.items.map((entry) => entry.item.id)),
        loading: false,
        atCapacity: page.nextCursor !== null,
      });
    })
    .catch(() => {
      if (seq !== fetchSeq) return;
      inFlight = false;
      if (listeners.size === 0) {
        reset();
        return;
      }
      // Same fail-soft as the per-mount version: stop loading, keep
      // whatever the set already held (an empty set on a cold start), so
      // the toggle becomes usable instead of spinning forever. Flagged as
      // failed so the next consumer to arrive retries (d4-w1).
      lastLoadFailed = true;
      emit({ ids: snapshot.ids, loading: false, atCapacity: snapshot.atCapacity });
    });
}

function attachSocket(): void {
  if (socketUnsubscribers.length > 0) return;
  const socket = getEventsSocket();
  socketUnsubscribers = [
    socket.subscribe<WatchlistEventPayload>("watchlist.added", (e: EventEnvelope<WatchlistEventPayload>) => {
      markWatchlistIdAdded(e.payload.itemId);
    }),
    socket.subscribe<WatchlistEventPayload>("watchlist.removed", (e: EventEnvelope<WatchlistEventPayload>) => {
      markWatchlistIdRemoved(e.payload.itemId);
    }),
  ];
}

function detachSocket(): void {
  for (const unsub of socketUnsubscribers) unsub();
  socketUnsubscribers = [];
}

/** Subscribe semantics for useSyncExternalStore: the FIRST consumer starts
 *  the one shared fetch and the one shared socket subscription; every later
 *  consumer joins the same snapshot. */
export function subscribeWatchlistIds(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    attachSocket();
    // Idle -> start THE fetch. Already in flight -> adopt it: a
    // teardown-then-resubscribe inside one commit (StrictMode's
    // double-invoke, or a route swap that remounts the toggles) must never
    // become a second identical request.
    if (!inFlight && snapshot.loading) load();
  } else if (lastLoadFailed && !inFlight) {
    // d4-w1: the store is holding a FAILED snapshot and, because something
    // stayed subscribed throughout, the drain-to-0 reset never ran. A newly
    // arriving consumer is the retry trigger: it is user-driven (a route
    // change, a detail screen mounting its toggles), it is exactly the
    // moment the stale set becomes visible again, and it is naturally
    // bounded — concurrent arrivals in one commit see `inFlight` and adopt
    // the same retry rather than stacking requests. Success clears the flag,
    // so this cannot become a poll on a healthy store.
    load();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    detachSocket();
    // A still-pending request is left alone: an immediate remount adopts
    // it, and if none comes its own handler resets the store.
    if (inFlight) return;
    reset();
  };
}

export function getWatchlistIdsSnapshot(): WatchlistIdsSnapshot {
  return snapshot;
}

/** SSR/hydration: never the client cache — the server render has no
 *  viewer-specific watchlist page. */
export function getWatchlistIdsServerSnapshot(): WatchlistIdsSnapshot {
  return INITIAL;
}

/** Optimistically marks an id present RIGHT NOW — invoked by the writer
 *  (WatchlistToggle) the instant its own PUT /watchlist/{itemId} resolves,
 *  and by the watchlist.added socket event, which is then a harmless
 *  idempotent no-op. Every consumer sees it in the same render. */
export function markWatchlistIdAdded(itemId: string): void {
  if (snapshot.ids.has(itemId)) return;
  const next = new Set(snapshot.ids);
  next.add(itemId);
  emit({ ids: next, loading: snapshot.loading, atCapacity: snapshot.atCapacity });
}

/** Same optimistic-write rationale as markWatchlistIdAdded, for the
 *  DELETE side. */
export function markWatchlistIdRemoved(itemId: string): void {
  if (!snapshot.ids.has(itemId)) return;
  const next = new Set(snapshot.ids);
  next.delete(itemId);
  emit({ ids: next, loading: snapshot.loading, atCapacity: snapshot.atCapacity });
}

/** Test-only escape hatch (same convention as events-socket.ts's
 *  __setEventsSocketForTests): drop every listener/subscription and return
 *  the module to its idle state between tests. */
export function __resetWatchlistIdStoreForTests(): void {
  listeners.clear();
  detachSocket();
  reset();
}
