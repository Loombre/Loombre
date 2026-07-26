// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/grid-windowing.ts
//
// Pure windowing math for the virtualized library-browse grid (P2.6 exit-
// gate surface — 50k items, 60fps scroll). No DOM/React here on purpose:
// components/browse/VirtualPosterGrid.tsx is the only caller, and this file
// is unit-tested in isolation (grid-windowing.test.ts) against a fake
// scrollTop/viewportHeight sweep instead of a real browser layout.
//
// Model: a uniform-size item grid wrapping at `columns` per row, uniform
// `rowHeight` (item height + gap). The grid container is itself the scroll
// region (overflow-y: auto, explicit height) — NOT window scroll — so this
// math only ever needs scrollTop relative to that one element.

export interface VisibleRowRangeParams {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  /** Extra rows rendered above/below the visible band so fast scrolling
   *  never shows a blank flash before React commits the next range. */
  overscanRows?: number;
}

export interface VisibleRowRange {
  /** Inclusive. */
  startRow: number;
  /** Exclusive. */
  endRow: number;
}

const DEFAULT_OVERSCAN_ROWS = 3;

/** How many columns fit in `containerWidth` given a fixed item width and
 *  inter-item gap (both sides of the gap belong to the tracks, not the
 *  container edge — this matches a CSS grid with `gap` and no outer
 *  padding contribution). Always at least 1. */
export function computeColumns(containerWidth: number, itemWidth: number, gap: number): number {
  if (containerWidth <= 0 || itemWidth <= 0) return 1;
  const columns = Math.floor((containerWidth + gap) / (itemWidth + gap));
  return Math.max(1, columns);
}

/** Total row count needed to lay out `itemCount` items at `columns` per row. */
export function computeTotalRows(itemCount: number, columns: number): number {
  if (columns <= 0 || itemCount <= 0) return 0;
  return Math.ceil(itemCount / columns);
}

/** The [startRow, endRow) band that must be rendered to cover the current
 *  scroll position plus overscan, clamped to [0, rowCount]. */
export function computeVisibleRowRange({
  scrollTop,
  viewportHeight,
  rowHeight,
  rowCount,
  overscanRows = DEFAULT_OVERSCAN_ROWS,
}: VisibleRowRangeParams): VisibleRowRange {
  if (rowCount <= 0 || rowHeight <= 0) return { startRow: 0, endRow: 0 };

  // Clamp first: scrollTop can exceed the track height by a frame or two
  // (fast fling past the end, or a stale value from a since-shrunk track) —
  // without this, an unclamped firstVisibleRow can push startRow past
  // rowCount entirely.
  const rawFirstVisibleRow = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const firstVisibleRow = Math.min(rawFirstVisibleRow, rowCount - 1);
  const visibleRowSpan = Math.ceil(viewportHeight / rowHeight) + 1;

  const startRow = Math.max(0, firstVisibleRow - overscanRows);
  const endRow = Math.min(rowCount, firstVisibleRow + visibleRowSpan + overscanRows);

  return { startRow, endRow };
}

/** Flat item indices covered by a row range, in row-major order, clamped to
 *  the real item count (the last row is usually partial). */
export function rangeToItemIndices(range: VisibleRowRange, columns: number, itemCount: number): number[] {
  const indices: number[] = [];
  for (let row = range.startRow; row < range.endRow; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const index = row * columns + col;
      if (index >= itemCount) break;
      indices.push(index);
    }
  }
  return indices;
}

export interface ShouldLoadMoreParams {
  /** End of the currently-rendered row window (exclusive). */
  endRow: number;
  /** Rows backed by items already loaded into memory. */
  loadedRows: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** Start fetching this many rows before the render window would run out
   *  of loaded data, so scrolling never outruns the network (P2.6: "fetch
   *  pages ahead of the scroll window; never load 50k rows at once"). */
  prefetchRows?: number;
}

const DEFAULT_PREFETCH_ROWS = 6;

/** True when the visible window is close enough to the end of loaded data
 *  that the next cursor page should be requested now. */
export function shouldLoadMore({
  endRow,
  loadedRows,
  hasMore,
  loadingMore,
  prefetchRows = DEFAULT_PREFETCH_ROWS,
}: ShouldLoadMoreParams): boolean {
  if (!hasMore || loadingMore) return false;
  return endRow >= loadedRows - prefetchRows;
}

/** Absolute pixel offset of `row`'s top edge within the scrollable track. */
export function rowOffset(row: number, rowHeight: number): number {
  return row * rowHeight;
}
