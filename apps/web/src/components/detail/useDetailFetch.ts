// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/detail/useDetailFetch.ts
//
// Shared not-found/load-error handling for the single-entity detail
// screens (movie/series/episode/artist/track — components/music/
// AlbumDetailScreen.tsx is a sibling lane's file and keeps its own copy of
// this pattern). Before this hook, every one of these screens fetched its
// primary entity with a bare `.then()` and gated its only render branch on
// `entity === null` — a 404'd id (deleted, mistyped, or restricted-
// without-clearance, see STATE.md) or a dropped connection left the
// loading skeleton up forever, with none of the "not found"/retry feedback
// app/people/[id]/page.tsx already had. This generalizes that page's
// hand-rolled 404 catch, plus a load-error branch with a retry (the one
// piece people/[id] didn't need since it has no reachable transient-
// failure regression test).

import { useEffect, useRef, useState } from "react";
import { LoombreApiError } from "../../lib/api-client.js";
import { subscribeCatalogInvalidation } from "../../lib/catalog-invalidation.js";

export interface DetailFetchResult<T> {
  entity: T | null;
  notFound: boolean;
  /** Non-null on any non-404 failure — an `err.message` from the server
   *  when available, else useCursorFeed.ts's own generic fallback copy. */
  error: string | null;
  retry: () => void;
}

/** `id` resets entity/notFound/error and re-fetches; `retry()` re-fetches
 *  the same id without the caller needing its own reload-key state. */
export function useDetailFetch<T>(fetchEntity: () => Promise<T>, id: string): DetailFetchResult<T> {
  const [entity, setEntity] = useState<T | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Ref, not a dep — components/browse/useCursorFeed.ts's fetchPageRef
  // convention: the effect below re-runs only on `id`/`attempt`, never
  // merely because the caller re-created its fetch closure this render.
  const fetchRef = useRef(fetchEntity);
  fetchRef.current = fetchEntity;

  useEffect(() => {
    let cancelled = false;
    setEntity(null);
    setNotFound(false);
    setError(null);
    fetchRef
      .current()
      .then((e) => {
        if (!cancelled) setEntity(e);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof LoombreApiError && err.status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof LoombreApiError ? err.message : "Failed to load.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  // d3-d8 (verify/restricted-lock-leaves-stale-content): tapping the header
  // lock while unlocked answers 204 and flips the indicator, but a
  // restricted detail already on screen kept rendering in full — the fetch
  // above ran once per id and nothing told it the viewer's clearance had
  // changed underneath it. RestrictedProvider emits catalog invalidation on
  // every confirmed lock<->unlock transition; re-entering through the same
  // `attempt` counter `retry()` uses means the effect's own reset runs too,
  // so the stale entity is CLEARED first and the screen cannot keep showing
  // content the server is about to 404. (The unlock direction matters as
  // much: a detail that 404'd while locked becomes real without a reload.)
  useEffect(() => subscribeCatalogInvalidation(() => setAttempt((a) => a + 1)), []);

  return { entity, notFound, error, retry: () => setAttempt((a) => a + 1) };
}
