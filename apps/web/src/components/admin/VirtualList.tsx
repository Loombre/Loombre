// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/VirtualList.tsx
//
// Generic single-column virtualized list for admin data-dense surfaces
// (Phase 4 deliverable D task brief: "virtualized where lists can grow
// (jobs)"). Reuses the SAME pure windowing math
// apps/web/src/components/browse/VirtualPosterGrid.tsx is built on
// (lib/grid-windowing.ts, already unit-tested there) with `columns`
// pinned to 1 and a caller-supplied FIXED row height — VirtualPosterGrid
// itself isn't reused directly because its row-height formula is hard-
// coded to the 2:3 poster aspect ratio (P2.6 exit-gate surface, out of
// this lane's scope to touch), which doesn't fit an admin list row's
// shape at all.
//
// Own scroll container (overflow-y: auto), cursor-pagination aware
// (onLoadMore fires via the same shouldLoadMore heuristic — fetch pages
// ahead of the scroll window, never load everything at once).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { computeVisibleRowRange, rowOffset, shouldLoadMore } from "../../lib/grid-windowing.js";
import styles from "./VirtualList.module.css";

export interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  getKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  /** Caps the scroll area's own height (px) — the list still virtualizes
   *  internally past this. Admin panels sit inside a normal scrolling
   *  page, so a list needs its OWN bounded scroll region rather than
   *  growing to push the rest of the page off-screen. */
  maxHeight?: number;
  ariaLabel: string;
}

const DEFAULT_MAX_HEIGHT = 640;

export function VirtualList<T>({
  items,
  rowHeight,
  hasMore,
  loadingMore,
  onLoadMore,
  getKey,
  renderRow,
  maxHeight = DEFAULT_MAX_HEIGHT,
  ariaLabel,
}: VirtualListProps<T>): React.JSX.Element {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollElRef = useCallback((el: HTMLDivElement | null) => setScrollEl(el), []);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    if (!scrollEl) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(scrollEl);
    setViewportHeight(scrollEl.clientHeight);
    return () => observer.disconnect();
  }, [scrollEl]);

  useEffect(() => {
    if (!scrollEl) return;
    let raf = 0;
    function onScroll(): void {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollTop(scrollEl ? scrollEl.scrollTop : 0);
      });
    }
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollEl]);

  const range = useMemo(
    () =>
      computeVisibleRowRange({
        scrollTop,
        viewportHeight,
        rowHeight,
        rowCount: items.length,
      }),
    [scrollTop, viewportHeight, rowHeight, items.length],
  );

  useEffect(() => {
    if (shouldLoadMore({ endRow: range.endRow, loadedRows: items.length, hasMore, loadingMore })) {
      onLoadMore();
    }
  }, [range.endRow, items.length, hasMore, loadingMore, onLoadMore]);

  const visible = items.slice(range.startRow, range.endRow);

  return (
    <div
      ref={scrollElRef}
      className={styles.scrollArea}
      role="list"
      aria-label={ariaLabel}
      style={{ maxHeight }}
    >
      <div className={styles.track} style={{ height: items.length * rowHeight }}>
        {visible.map((item, i) => {
          const index = range.startRow + i;
          return (
            <div
              key={getKey(item)}
              role="listitem"
              className={styles.row}
              style={{ transform: `translateY(${rowOffset(index, rowHeight)}px)`, height: rowHeight }}
            >
              {renderRow(item)}
            </div>
          );
        })}
      </div>
      {loadingMore && <div className={styles.loadingMore}>Loading more…</div>}
    </div>
  );
}
