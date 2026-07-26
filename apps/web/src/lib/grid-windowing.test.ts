// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/grid-windowing.test.ts
//
// Pure math tests for the 50k-item virtualized browse grid (P2.6 exit-gate
// surface) — no DOM, no React, just the windowing arithmetic.

import { describe, expect, it } from "vitest";
import {
  computeColumns,
  computeTotalRows,
  computeVisibleRowRange,
  rangeToItemIndices,
  rowOffset,
  shouldLoadMore,
} from "./grid-windowing.js";

describe("computeColumns", () => {
  it("fits as many item+gap tracks as the container allows", () => {
    // 5 columns of 160px + 16px gaps between them = 5*160 + 4*16 = 864.
    expect(computeColumns(864, 160, 16)).toBe(5);
    expect(computeColumns(863, 160, 16)).toBe(4);
  });

  it("never returns fewer than 1 column even in a tiny container", () => {
    expect(computeColumns(10, 160, 16)).toBe(1);
    expect(computeColumns(0, 160, 16)).toBe(1);
  });
});

describe("computeTotalRows", () => {
  it("rounds up to cover the last partial row", () => {
    expect(computeTotalRows(50_000, 8)).toBe(6250);
    expect(computeTotalRows(50_001, 8)).toBe(6251);
  });

  it("is 0 for an empty grid", () => {
    expect(computeTotalRows(0, 8)).toBe(0);
  });
});

describe("computeVisibleRowRange", () => {
  it("computes a small band around the scroll position at 50k-item scale", () => {
    const rowCount = computeTotalRows(50_000, 8); // 6250
    const range = computeVisibleRowRange({
      scrollTop: 100_000,
      viewportHeight: 900,
      rowHeight: 260,
      rowCount,
      overscanRows: 3,
    });
    // firstVisibleRow = floor(100000/260) = 384; visibleRowSpan = ceil(900/260)+1 = 5
    expect(range.startRow).toBe(384 - 3);
    expect(range.endRow).toBe(384 + 5 + 3);
    // Rendered band stays tiny no matter how large rowCount is — this IS
    // the 60fps-at-50k-items guarantee: DOM node count is bounded by the
    // viewport, never by the dataset size.
    expect(range.endRow - range.startRow).toBeLessThan(20);
  });

  it("clamps to [0, rowCount] at both scroll extremes", () => {
    const rowCount = 100;
    const atTop = computeVisibleRowRange({ scrollTop: 0, viewportHeight: 900, rowHeight: 260, rowCount });
    expect(atTop.startRow).toBe(0);

    const atBottom = computeVisibleRowRange({
      scrollTop: 1_000_000,
      viewportHeight: 900,
      rowHeight: 260,
      rowCount,
    });
    expect(atBottom.endRow).toBe(rowCount);
    expect(atBottom.startRow).toBeLessThanOrEqual(rowCount);
  });

  it("returns an empty range for a zero-row grid", () => {
    const range = computeVisibleRowRange({ scrollTop: 0, viewportHeight: 900, rowHeight: 260, rowCount: 0 });
    expect(range).toEqual({ startRow: 0, endRow: 0 });
  });
});

describe("rangeToItemIndices", () => {
  it("expands a row range into row-major flat indices", () => {
    const indices = rangeToItemIndices({ startRow: 1, endRow: 3 }, 4, 100);
    expect(indices).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("stops at the real item count on a partial last row", () => {
    const indices = rangeToItemIndices({ startRow: 0, endRow: 2 }, 4, 6);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("shouldLoadMore", () => {
  it("fires once the render window is within prefetchRows of loaded data", () => {
    expect(
      shouldLoadMore({ endRow: 94, loadedRows: 100, hasMore: true, loadingMore: false, prefetchRows: 6 }),
    ).toBe(true);
    expect(
      shouldLoadMore({ endRow: 80, loadedRows: 100, hasMore: true, loadingMore: false, prefetchRows: 6 }),
    ).toBe(false);
  });

  it("never fires when there is nothing more to load or a fetch is already in flight", () => {
    expect(shouldLoadMore({ endRow: 100, loadedRows: 100, hasMore: false, loadingMore: false })).toBe(false);
    expect(shouldLoadMore({ endRow: 100, loadedRows: 100, hasMore: true, loadingMore: true })).toBe(false);
  });
});

describe("rowOffset", () => {
  it("is row * rowHeight", () => {
    expect(rowOffset(10, 260)).toBe(2600);
    expect(rowOffset(0, 260)).toBe(0);
  });
});
