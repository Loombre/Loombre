// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/VirtualPosterGrid.tsx
//
// The P2.6 exit-gate surface: a poster grid that scrolls 60fps at 50k
// items. Hand-rolled windowing (not @tanstack/react-virtual — see
// lib/grid-windowing.ts's header) so the DOM only ever holds the rows
// covering the current viewport + a small overscan band, regardless of how
// many items are loaded. Own scroll container (overflow-y: auto on this
// component, not window scroll) so the windowing math only needs one
// element's scrollTop.
//
// Cursor pagination: `items` grows as the caller's useCursorFeed loads more
// pages; this component never fetches anything itself — it only decides
// WHEN to ask for more via `onLoadMore`, based on how close the rendered
// row-window is to the end of what's currently loaded (shouldLoadMore in
// grid-windowing.ts), which is how "fetch pages ahead of the scroll
// window; never load 50k rows at once" (P2.6) is satisfied: at most one
// extra page is ever in flight, and the full 50k-row dataset is never
// materialized in the DOM at once.
//
// Keyboard nav: roving tabindex (WAI-ARIA grid pattern, simplified to a
// flat list) — arrow keys move a single logical focus index; the target
// cell is scrolled into view (if not already) and focused once its row
// re-enters the rendered window.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  computeColumns,
  computeTotalRows,
  computeVisibleRowRange,
  rangeToItemIndices,
  rowOffset,
  shouldLoadMore,
} from "../../lib/grid-windowing.js";
import { Skeleton } from "../skeleton/Skeleton.js";
import styles from "./VirtualPosterGrid.module.css";

const DEFAULT_ITEM_WIDTH = 168;
const DEFAULT_GAP = 16; // px — matches --space-md
const LABEL_HEIGHT = 46; // title + subtitle line, plus the tile's own gap
const POSTER_ASPECT = 1.5; // 2:3 poster: height = width * 1.5

export interface CellHandlers {
  tabIndex: number;
  cellRef: (el: HTMLAnchorElement | null) => void;
  onFocus: () => void;
}

export interface VirtualPosterGridProps<T> {
  items: T[];
  hasMore: boolean;
  loadingMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  getKey: (item: T) => string;
  renderItem: (item: T, index: number, handlers: CellHandlers) => ReactNode;
  emptyMessage?: string;
  itemWidth?: number;
  gap?: number;
  ariaLabel: string;
}

export function VirtualPosterGrid<T>({
  items,
  hasMore,
  loadingMore,
  loading,
  onLoadMore,
  getKey,
  renderItem,
  emptyMessage = "Nothing here yet.",
  itemWidth = DEFAULT_ITEM_WIDTH,
  gap = DEFAULT_GAP,
  ariaLabel,
}: VirtualPosterGridProps<T>): React.JSX.Element {
  // A plain `useRef` + a `useEffect(fn, [])` that reads `.current` would
  // silently never attach here: `loading`/empty states below are separate
  // early `return`s, so on first mount (usually `loading === true`) the
  // scroll-container div doesn't exist yet, `.current` is null, the effect
  // bails, and — because its deps array is `[]` — it never runs again once
  // the real grid div mounts later. State-backed callback ref instead: React
  // invokes it (and re-invokes it) every time this exact DOM node is
  // attached, on whichever render that turns out to be, so the
  // ResizeObserver/scroll-listener effects below (which depend on
  // `scrollEl`) always run once the node is real. (Real bug hit during
  // Wave-2 real-browser verification: container stuck at width 0 forever
  // -> single-column layout + dead scroll handling.)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollElRef = useCallback((el: HTMLDivElement | null) => setScrollEl(el), []);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const cellRefs = useRef(new Map<number, HTMLAnchorElement>());
  const pendingFocusRef = useRef(false);

  useEffect(() => {
    if (!scrollEl) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
      setContainerHeight(entry.contentRect.height);
    });
    observer.observe(scrollEl);
    // Also seed synchronously from the current box — ResizeObserver's first
    // callback is async (next microtask/frame), and without this the very
    // first render after mount briefly computes columns from width 0.
    setContainerWidth(scrollEl.clientWidth);
    setContainerHeight(scrollEl.clientHeight);
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

  const columns = useMemo(
    () => computeColumns(containerWidth, itemWidth, gap),
    [containerWidth, itemWidth, gap],
  );
  const actualItemWidth = columns > 0 && containerWidth > 0 ? (containerWidth - gap * (columns - 1)) / columns : itemWidth;
  const rowHeight = actualItemWidth * POSTER_ASPECT + LABEL_HEIGHT + gap;
  const totalRows = computeTotalRows(items.length, columns);

  const range = useMemo(
    () =>
      computeVisibleRowRange({
        scrollTop,
        viewportHeight: containerHeight,
        rowHeight: rowHeight || 1,
        rowCount: totalRows,
      }),
    [scrollTop, containerHeight, rowHeight, totalRows],
  );

  useEffect(() => {
    if (shouldLoadMore({ endRow: range.endRow, loadedRows: totalRows, hasMore, loadingMore })) {
      onLoadMore();
    }
  }, [range.endRow, totalRows, hasMore, loadingMore, onLoadMore]);

  const visibleIndices = useMemo(
    () => rangeToItemIndices(range, columns, items.length),
    [range, columns, items.length],
  );

  const moveFocus = useCallback(
    (nextIndex: number) => {
      if (items.length === 0) return;
      const clamped = Math.max(0, Math.min(items.length - 1, nextIndex));
      if (scrollEl && rowHeight > 0) {
        const row = Math.floor(clamped / columns);
        const top = rowOffset(row, rowHeight);
        const bottom = top + rowHeight;
        if (top < scrollEl.scrollTop) scrollEl.scrollTop = top;
        else if (bottom > scrollEl.scrollTop + scrollEl.clientHeight) scrollEl.scrollTop = bottom - scrollEl.clientHeight;
      }
      pendingFocusRef.current = true;
      setFocusedIndex(clamped);
    },
    [items.length, columns, rowHeight, scrollEl],
  );

  // Retries every render until the target cell exists in the DOM (it may
  // not yet if moveFocus just scrolled its row into the window) — cheap:
  // guarded by pendingFocusRef, clears itself once the focus lands.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const el = cellRefs.current.get(focusedIndex);
    if (el) {
      el.focus();
      pendingFocusRef.current = false;
    }
  });

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveFocus(focusedIndex + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(focusedIndex - 1);
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(focusedIndex + columns);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(focusedIndex - columns);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(0);
        break;
      case "End":
        event.preventDefault();
        moveFocus(items.length - 1);
        break;
      default:
        break;
    }
  }

  if (loading) {
    return (
      <div className={styles.skeletonGrid} aria-hidden="true">
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className={styles.skeletonCell}>
            <Skeleton radius="md" height={itemWidth * POSTER_ASPECT} />
            <Skeleton radius="sm" height={14} width="70%" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return <div className={styles.empty}>{emptyMessage}</div>;
  }

  return (
    <div
      ref={scrollElRef}
      className={styles.scrollArea}
      role="list"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className={styles.track} style={{ height: totalRows * rowHeight }}>
        {visibleIndices.map((index) => {
          const item = items[index];
          if (!item) return null;
          const row = Math.floor(index / columns);
          const col = index % columns;
          const left = col * (actualItemWidth + gap);
          const top = rowOffset(row, rowHeight);
          return (
            <div
              key={getKey(item)}
              role="listitem"
              className={styles.cell}
              style={{ transform: `translate(${left}px, ${top}px)`, width: actualItemWidth }}
            >
              {renderItem(item, index, {
                tabIndex: index === focusedIndex ? 0 : -1,
                cellRef: (el) => {
                  if (el) cellRefs.current.set(index, el);
                  else cellRefs.current.delete(index);
                },
                onFocus: () => setFocusedIndex(index),
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
