// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZoneBrowseGrid.tsx
//
// STATE.md Stash run (S9): the shared card-list renderer behind
// /restricted/browse, /restricted/performers/{id} (filmography), and
// /restricted/studios/{id} (catalog) — one implementation of "cards for a
// page of RestrictedBrowseItem, wall or rows" rather than three.
//
// density="wall": components/browse/VirtualPosterGrid + ZonePosterCard —
// the S10 60fps-at-scale path (hand-rolled windowing, roving tabindex).
// density="rows": a plain scrollable list of ZoneDetailedRow with a
// "Load more" button (app/people/[id]/page.tsx's own filmography
// pattern) — NOT virtualized. Documented tradeoff: VirtualPosterGrid's
// windowing math is grid/column-shaped (computeColumns/rowOffset), not a
// single-column detailed-row shape, so reusing it here would need a
// second windowing implementation; rows density is the secondary, less-
// used view (S10's 60fps commitment is specifically about the poster
// WALL), so a bounded "Load more"-paged list is the accepted cost rather
// than building a second virtualizer for this lane.

import { VirtualPosterGrid } from "../browse/VirtualPosterGrid.js";
import { ZonePosterCard } from "./ZonePosterCard.js";
import { ZoneDetailedRow } from "./ZoneDetailedRow.js";
import type { ZoneDensity } from "../../lib/zone-density-prefs.js";
import type { components } from "@loombre/sdk";
import styles from "./ZoneBrowseGrid.module.css";

type RestrictedBrowseItem = components["schemas"]["RestrictedBrowseItem"];

export interface ZoneBrowseGridProps {
  items: RestrictedBrowseItem[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  loadMoreError?: string | null | undefined;
  onLoadMore: () => void;
  density: ZoneDensity;
  serverUrl: string;
  accessToken: string;
  ariaLabel: string;
  emptyMessage?: string | undefined;
}

export function ZoneBrowseGrid({
  items,
  hasMore,
  loading,
  loadingMore,
  loadMoreError,
  onLoadMore,
  density,
  serverUrl,
  accessToken,
  ariaLabel,
  emptyMessage,
}: ZoneBrowseGridProps): React.JSX.Element {
  if (density === "wall") {
    return (
      <VirtualPosterGrid<RestrictedBrowseItem>
        items={items}
        hasMore={hasMore}
        loading={loading}
        loadingMore={loadingMore}
        loadMoreError={loadMoreError ?? null}
        onLoadMore={onLoadMore}
        getKey={(item) => item.id}
        ariaLabel={ariaLabel}
        {...(emptyMessage !== undefined ? { emptyMessage } : {})}
        renderItem={(item, _index, handlers) => (
          <ZonePosterCard
            serverUrl={serverUrl}
            accessToken={accessToken}
            itemId={item.id}
            itemType={item.itemType}
            title={item.title}
            subtitle={item.year ? String(item.year) : undefined}
            blurhash={item.images.find((img) => img.kind === "poster")?.blurhash ?? null}
            href={`/restricted/scenes/${item.id}`}
            tabIndex={handlers.tabIndex}
            cellRef={handlers.cellRef}
            onFocus={handlers.onFocus}
          />
        )}
      />
    );
  }

  if (loading) {
    return (
      <div className={styles.rowsSkeleton} aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={styles.rowsSkeletonItem} />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return <div className={styles.empty}>{emptyMessage ?? "Nothing here yet."}</div>;
  }

  return (
    <div className={styles.rows} role="list" aria-label={ariaLabel}>
      {items.map((item) => (
        <div key={item.id} role="listitem">
          <ZoneDetailedRow item={item} serverUrl={serverUrl} accessToken={accessToken} href={`/restricted/scenes/${item.id}`} />
        </div>
      ))}
      {hasMore && (
        <button type="button" className={styles.loadMore} onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
      {loadMoreError && <div className={styles.loadMoreError}>{loadMoreError}</div>}
    </div>
  );
}
