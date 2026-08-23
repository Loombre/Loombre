// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/watchlist/page.tsx
//
// /watchlist (Phosphor Wave 2 lane L3, README route table "NEW"). Poster
// grid of saved titles with inline REMOVE, empty state inviting the first
// save (README's Watchlist screen + Interactions & behavior → Watchlist).
// Cursor-paginated via GET /watchlist (packages/contract/openapi.yaml) —
// non-virtualized (components/detail/ChildPosterGrid.tsx's precedent: a
// watchlist is never a 50k-item surface the way Browse can be, so a plain
// "Load more" button is honest pagination without VirtualPosterGrid's
// windowing overhead).
//
// Cross-device sync: useWatchlistChangeSignal (lib/watchlist-sync.ts)
// re-runs the feed from cursor null whenever this user's OTHER device/tab
// adds or removes something (the watchlist.added/watchlist.removed
// websocket events, USER_ONLY_TYPES delivery) — a full refetch rather than
// a delta merge, since the feed is keyset-paginated and a delta insert
// could land out of order relative to already-loaded pages.

import { useCallback, useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../components/shell/AppShell.js";
import { WatchlistPosterCard } from "../../components/watchlist/WatchlistPosterCard.js";
import { Skeleton } from "../../components/skeleton/Skeleton.js";
import { useCursorFeed, type CursorPage } from "../../components/browse/useCursorFeed.js";
import { useWatchlistChangeSignal } from "../../lib/watchlist-sync.js";
import { apiDelete, apiGet } from "../../lib/api-client.js";
import { getAuthStore } from "../../lib/auth-store.js";
import styles from "./page.module.css";

type WatchlistEntry = components["schemas"]["WatchlistEntry"];
type ImageDescriptor = components["schemas"]["ImageDescriptor"];

interface WatchlistCard {
  id: string;
  title: string;
  subtitle?: string | undefined;
  blurhash: string | null;
  href: string;
  entityType: string;
  hasPoster: boolean;
}

const PAGE_LIMIT = 100;

function posterBlurhash(images: ImageDescriptor[] | undefined): string | null {
  return images?.find((img) => img.kind === "poster")?.blurhash ?? null;
}

// browser-casual-F4: WatchlistPosterCard is "the PosterCell shape" (its own
// header's words) — same doomed-request gap as browser-shell-browse-F3,
// same fix.
function hasPosterImage(images: ImageDescriptor[] | undefined): boolean {
  return images?.some((img) => img.kind === "poster") ?? false;
}

function toCard(entry: WatchlistEntry): WatchlistCard {
  const item = entry.item;
  return {
    id: item.id,
    title: item.title,
    subtitle: item.year ? String(item.year) : undefined,
    blurhash: posterBlurhash(item.images),
    href: `/items/${entry.itemType}/${item.id}`,
    entityType: entry.itemType,
    hasPoster: hasPosterImage(item.images),
  };
}

async function fetchWatchlistPage(cursor: string | null): Promise<CursorPage<WatchlistCard>> {
  const page = await apiGet("/watchlist", {
    params: { query: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } },
  });
  return { items: page.items.map(toCard), nextCursor: page.nextCursor };
}

function WatchlistContent(): React.JSX.Element {
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    getAuthStore()
      .getAccessToken()
      .then((token) => {
        if (!cancelled) setAccessToken(token);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { items, hasMore, loading, loadingMore, error, loadMoreError, loadMore } = useCursorFeed<WatchlistCard>(
    fetchWatchlistPage,
    `v${resetKey}`,
  );

  // A change from another of THIS user's own devices/tabs — re-run the feed
  // from scratch (see this file's header for why a full refetch, not a
  // delta merge).
  useWatchlistChangeSignal(
    useCallback(() => {
      setRemovedIds(new Set());
      setResetKey((k) => k + 1);
    }, []),
  );

  async function handleRemove(itemId: string): Promise<void> {
    await apiDelete("/watchlist/{itemId}", { params: { path: { itemId } } });
    // Optimistic local removal — the watchlist.removed event this same tab
    // just caused will also arrive over the socket shortly after and is a
    // harmless no-op against useWatchlistChangeSignal's resetKey bump
    // triggering later (or, if it lands first, this filter is already a
    // no-op too).
    setRemovedIds((prev) => (prev.has(itemId) ? prev : new Set(prev).add(itemId)));
  }

  const visibleItems = items.filter((item) => !removedIds.has(item.id));
  const showEmpty = !loading && visibleItems.length === 0 && !error;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Watchlist</h1>

      {loading || accessToken === null ? (
        <div className={styles.grid}>
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} radius="md" height={252} />
          ))}
        </div>
      ) : error ? (
        <div className={styles.empty}>{error}</div>
      ) : showEmpty ? (
        <div className={styles.empty}>
          Nothing saved yet — toggle Watchlist on any movie, series, or album to save it here.
        </div>
      ) : (
        <>
          <div className={styles.grid}>
            {visibleItems.map((item) => (
              <div key={item.id} className={styles.cell}>
                <WatchlistPosterCard
                  serverUrl={serverUrl}
                  accessToken={accessToken}
                  entityType={item.entityType}
                  entityId={item.id}
                  href={item.href}
                  title={item.title}
                  subtitle={item.subtitle}
                  blurhash={item.blurhash}
                  hasPoster={item.hasPoster}
                  onRemove={() => handleRemove(item.id)}
                />
              </div>
            ))}
          </div>
          {hasMore && (
            <button type="button" className={styles.loadMore} onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
          {/* A failed page-append (confirmed[36]) — non-destructive: the
              already-loaded grid above stays put. The "Load more" button
              itself is already the retry (cursor/hasMore survive a failed
              loadMore in useCursorFeed), this is just the error readout. */}
          {loadMoreError && <div className={styles.loadMoreError}>{loadMoreError}</div>}
        </>
      )}
    </div>
  );
}

export default function WatchlistPage(): React.JSX.Element {
  return (
    <AppShell>
      <WatchlistContent />
    </AppShell>
  );
}
