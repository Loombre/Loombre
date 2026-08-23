// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/browse/page.tsx
//
// Library browse — the P2.6 exit-gate surface: a virtualized poster grid
// that stays smooth at 50k items (see `pnpm db:seed-large`). One route,
// library switcher inside it (?library=<id> in the URL, so a link/back-
// button/reload all land on the same library).
//
// Sort: the list endpoints (GET /movies, /series, /artists) now take a
// `sort`+`order` pair (gap-closure lane addition — see SortControl.tsx's
// header); LibraryPills is the library filter, SortControl picks which
// server-side order the cursor feed walks. Cursor pagination stays correct
// across a sort change because `resetKey` below includes `sort` — a cursor
// from one sort+order pair is only valid under that same pair (contract
// doc on listMovies etc.), so switching sort always restarts the feed from
// cursor null rather than reusing a stale cursor.
//
// browser-shell-browse-F6: `sort` also round-trips through `?sort=<value>`
// (same URL-is-truth pattern as `?library=`) — the state initializer reads
// it once at mount (isSortValue guards an unrecognized/missing param back
// to the "recently-added" default) and every SortControl change writes it
// back via router.replace, so a sorted view survives a reload/share/back-
// button, not just the "recently-added" default the plain useState left it
// pinned to before.

"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../components/shell/AppShell.js";
import { VirtualPosterGrid } from "../../components/browse/VirtualPosterGrid.js";
import { PosterCell } from "../../components/browse/PosterCell.js";
import { LibraryPills } from "../../components/browse/LibraryPills.js";
import { SortControl, SORT_PARAMS, isSortValue, type SortValue } from "../../components/browse/SortControl.js";
import { useCursorFeed, type CursorPage } from "../../components/browse/useCursorFeed.js";
import { Skeleton } from "../../components/skeleton/Skeleton.js";
import { RestrictedZoneBrowseChip } from "../../components/restricted/RestrictedZoneBrowseChip.js";
import { apiGet } from "../../lib/api-client.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { useNowPlayingItemIds } from "../../lib/now-playing.js";
import styles from "./page.module.css";

type Library = components["schemas"]["Library"];
type ImageDescriptor = components["schemas"]["ImageDescriptor"];

interface BrowseCard {
  id: string;
  title: string;
  subtitle?: string | undefined;
  blurhash: string | null;
  href: string;
  entityType: string;
  hasPoster: boolean;
}

function posterBlurhash(images: ImageDescriptor[] | undefined): string | null {
  return images?.find((img) => img.kind === "poster")?.blurhash ?? null;
}

// browser-shell-browse-F3: PosterCell must not fire a doomed poster
// request when the item's own list-payload `images` already says there's
// no poster to fetch (the decision is free — it's already in hand).
function hasPosterImage(images: ImageDescriptor[] | undefined): boolean {
  return images?.some((img) => img.kind === "poster") ?? false;
}

const PAGE_LIMIT = 100;

async function fetchLibraryPage(library: Library, cursor: string | null, sort: SortValue): Promise<CursorPage<BrowseCard>> {
  const query = { libraryId: library.id, limit: PAGE_LIMIT, sort: SORT_PARAMS[sort], ...(cursor ? { cursor } : {}) };

  if (library.mediaKind === "movie") {
    const page = await apiGet("/movies", { params: { query } });
    return {
      items: page.items.map((m) => ({
        id: m.id,
        title: m.title,
        subtitle: m.year ? String(m.year) : undefined,
        blurhash: posterBlurhash(m.images),
        href: `/items/movie/${m.id}`,
        entityType: "movie",
        hasPoster: hasPosterImage(m.images),
      })),
      nextCursor: page.nextCursor,
    };
  }

  if (library.mediaKind === "tv") {
    const page = await apiGet("/series", { params: { query } });
    return {
      items: page.items.map((s) => ({
        id: s.id,
        title: s.title,
        subtitle: s.year ? String(s.year) : (s.status ?? undefined),
        blurhash: posterBlurhash(s.images),
        href: `/items/series/${s.id}`,
        entityType: "series",
        hasPoster: hasPosterImage(s.images),
      })),
      nextCursor: page.nextCursor,
    };
  }

  const page = await apiGet("/artists", { params: { query } });
  return {
    items: page.items.map((a) => ({
      id: a.id,
      title: a.title,
      subtitle: undefined,
      blurhash: posterBlurhash(a.images),
      href: `/items/artist/${a.id}`,
      entityType: "artist",
      hasPoster: hasPosterImage(a.images),
    })),
    nextCursor: page.nextCursor,
  };
}

function BrowseContent(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  // browser-shell-browse-F6: seed from ?sort= at mount so a shared/
  // bookmarked/reloaded URL lands on the same sort, not always the default.
  const [sort, setSort] = useState<SortValue>(() => {
    const fromUrl = searchParams.get("sort");
    return isSortValue(fromUrl) ? fromUrl : "recently-added";
  });
  const nowPlayingIds = useNowPlayingItemIds();

  function handleSortChange(next: SortValue): void {
    setSort(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("sort", next);
    router.replace(`/browse?${params.toString()}`);
  }

  useEffect(() => {
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiGet("/libraries", { params: { query: { limit: 100 } } }).then((page) => {
      if (!cancelled) setLibraries(page.items);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestedId = searchParams.get("library");
  const activeLibrary = useMemo(
    () => libraries?.find((l) => l.id === requestedId) ?? null,
    [libraries, requestedId],
  );

  // No/invalid ?library= param once libraries have loaded — land on the
  // first one so the route is always in a well-defined state.
  useEffect(() => {
    if (libraries === null || libraries.length === 0) return;
    const first = libraries[0];
    if (!activeLibrary && first) {
      router.replace(`/browse?library=${first.id}`);
    }
  }, [libraries, activeLibrary, router]);

  const resetKey = activeLibrary ? `${activeLibrary.id}:${sort}` : null;
  const { items, hasMore, loading, loadingMore, error, loadMoreError, loadMore } = useCursorFeed<BrowseCard>(
    (cursor) => {
      if (!activeLibrary) return Promise.resolve({ items: [], nextCursor: null });
      return fetchLibraryPage(activeLibrary, cursor, sort);
    },
    resetKey,
  );

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>Browse</h1>
        {libraries === null ? (
          <Skeleton radius="pill" width={240} height={36} />
        ) : libraries.length > 0 ? (
          <LibraryPills
            options={libraries.map((l) => ({ id: l.id, name: l.name }))}
            activeId={activeLibrary?.id ?? null}
            onSelect={(id) => {
              const params = new URLSearchParams(searchParams.toString());
              params.set("library", id);
              router.replace(`/browse?${params.toString()}`);
            }}
          />
        ) : null}
        <SortControl active={sort} onChange={handleSortChange} />
      </div>

      {/* Wave 2 (lane L8): amber "N restricted · PIN-gated zone ->" chip,
          above the grid — entitlement-gated, hidden entirely otherwise. */}
      <RestrictedZoneBrowseChip />

      {libraries !== null && libraries.length === 0 ? (
        <div className={styles.emptyLibraries}>No libraries yet — ask an admin to create one.</div>
      ) : error ? (
        <div className={styles.emptyLibraries}>{error}</div>
      ) : accessToken === null || activeLibrary === null ? (
        <VirtualPosterGrid<BrowseCard>
          items={[]}
          hasMore={false}
          loadingMore={false}
          loading
          onLoadMore={() => {}}
          getKey={(item) => item.id}
          renderItem={() => null}
          ariaLabel="Library items"
        />
      ) : (
        <>
          <VirtualPosterGrid<BrowseCard>
            items={items}
            hasMore={hasMore}
            loadingMore={loadingMore}
            loading={loading}
            loadMoreError={loadMoreError}
            onLoadMore={loadMore}
            getKey={(item) => item.id}
            emptyMessage={`${activeLibrary.name} is empty — scan this library to add items.`}
            ariaLabel={`${activeLibrary.name} items`}
            renderItem={(item, _index, handlers) => (
              <PosterCell
                serverUrl={serverUrl}
                accessToken={accessToken}
                entityType={item.entityType}
                entityId={item.id}
                href={item.href}
                title={item.title}
                subtitle={item.subtitle}
                blurhash={item.blurhash}
                tabIndex={handlers.tabIndex}
                cellRef={handlers.cellRef}
                onFocus={handlers.onFocus}
                nowPlaying={nowPlayingIds.has(item.id)}
                hasPoster={item.hasPoster}
              />
            )}
          />
          {/* Sits outside VirtualPosterGrid on purpose (confirmed[36]) — a
              failed page-append must never unmount the grid: that's what
              would discard everything already loaded and the user's scroll
              position. `loadMore` is already a valid retry (cursor/hasMore
              are untouched by a failed loadMore in useCursorFeed). */}
          {loadMoreError && (
            <div className={styles.loadMoreError}>
              {loadMoreError}
              <button type="button" className={styles.retryButton} onClick={loadMore}>
                Retry
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function BrowsePage(): React.JSX.Element {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <BrowseContent />
      </Suspense>
    </AppShell>
  );
}
