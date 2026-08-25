// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/watchlist-rail.ts
//
// The Home "Your Watchlist" rail's own bounded GET /watchlist page — d4-w2.
//
// Why this is NOT the shared id store: lib/watchlist-id-store.ts holds an
// id SET read as one generous page (limit 200) for the toggles and the
// sidebar count; this rail renders ENTRIES (title, poster, blurhash) and
// only the most recent handful of them (limit 20). Two different queries
// against the same endpoint, so they cannot share a snapshot — but they can
// and must share the same request discipline, which is what this module
// adds. browser-items-F9 coalesced the id fetch and left this one issuing
// `apiGet` straight from Home's bootstrap effect, so /home still fired two
// identical GET /watchlist?limit=20 per mount in dev: React StrictMode
// invokes that effect twice, and its `cancelled` flag only suppresses the
// first run's setState, never its request.
//
// Nothing is cached. The shared promise lives exactly as long as the
// request is in flight, so the two StrictMode invocations (same commit,
// both before any await settles) adopt ONE request, while a later /home
// mount always re-seeds from the server rather than rendering a rail page
// of unknown age. Same rule as the id store's "keep the in-flight request,
// discard the settled page" reset.

import { apiGet } from "./api-client.js";

/** Bounded — Home's rail shows the most recently added handful, same
 *  posture as Continue Watching/Recently Added (L3's rail, wired into
 *  L9's page at Wave-2 landing per both lanes' documented seam). */
export const WATCHLIST_RAIL_LIMIT = 20;

function request(): ReturnType<typeof apiGet<"/watchlist">> {
  return apiGet("/watchlist", { params: { query: { limit: WATCHLIST_RAIL_LIMIT } } });
}

/** The generated page shape for GET /watchlist — derived from the SDK
 *  through apiGet rather than restated, so a contract change lands here as
 *  a type error instead of a silent drift. */
export type WatchlistRailPage = Awaited<ReturnType<typeof request>>;

let inFlight: Promise<WatchlistRailPage> | null = null;

/** Seeds the rail. Concurrent callers — i.e. the two invocations of Home's
 *  bootstrap effect that dev StrictMode produces for one mount — get the
 *  SAME in-flight request instead of two identical ones. */
export function loadWatchlistRailPage(): Promise<WatchlistRailPage> {
  if (inFlight) return inFlight;
  const pending = request().finally(() => {
    if (inFlight === pending) inFlight = null;
  });
  inFlight = pending;
  return pending;
}

/** A deliberate REFRESH after a watchlist.added/watchlist.removed event
 *  from another of this user's sessions. Never adopts an in-flight page:
 *  that page may already have been read by the server BEFORE the change
 *  that triggered this call, which is exactly the staleness the event
 *  exists to repair. */
export function refetchWatchlistRailPage(): Promise<WatchlistRailPage> {
  return request();
}

/** Test-only escape hatch (same convention as watchlist-id-store.ts's
 *  __resetWatchlistIdStoreForTests): drop any pending share so one test's
 *  unsettled request cannot be adopted by the next. */
export function __resetWatchlistRailForTests(): void {
  inFlight = null;
}
