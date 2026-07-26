// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/useCursorFeed.ts
//
// Generic cursor-paginated feed used by the browse grid and search results:
// `fetchPage(cursor)` returns one page (contract shape: {items, nextCursor}
// per MoviePage/SeriesPage/.../SearchResultPage — every list endpoint in
// packages/contract/openapi.yaml follows this exact shape); `resetKey`
// changing (a different library, or a new search query) restarts the feed
// from cursor null. Guards stale-response races the same way
// app/home/page.tsx's inline effects do (a `cancelled` flag per fetch),
// generalized here since both browse and search need it.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface UseCursorFeedResult<T> {
  items: T[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
}

export function useCursorFeed<T>(
  fetchPage: (cursor: string | null) => Promise<CursorPage<T>>,
  resetKey: string | null,
): UseCursorFeedResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;
  const inFlight = useRef(false);

  useEffect(() => {
    if (resetKey === null) return;
    let cancelled = false;
    setItems([]);
    setCursor(null);
    setHasMore(true);
    setLoading(true);
    setError(null);
    inFlight.current = true;

    fetchPageRef
      .current(null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load.");
      })
      .finally(() => {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resetKey]);

  const loadMore = useCallback(() => {
    if (inFlight.current || !hasMore || loading) return;
    inFlight.current = true;
    setLoadingMore(true);
    fetchPageRef
      .current(cursor)
      .then((page) => {
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load more.");
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingMore(false);
      });
  }, [cursor, hasMore, loading]);

  return { items, hasMore, loading, loadingMore, error, loadMore };
}
