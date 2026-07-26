// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildExclusionSet, selectFeaturedPool } from "./featured-pool.js";

describe("buildExclusionSet", () => {
  it("merges multiple id sources into one set", () => {
    const set = buildExclusionSet(["a", "b"], ["c"], []);
    expect([...set].sort()).toEqual(["a", "b", "c"]);
  });

  it("dedupes ids repeated across sources", () => {
    const set = buildExclusionSet(["a"], ["a", "b"]);
    expect(set.size).toBe(2);
  });

  it("is the composable seam L3 (Watchlist) can add a source to at reconciliation", () => {
    // Simulates today's call (no watchlist source yet) vs. the one-line
    // addition the orchestrator makes once L3 lands.
    const withoutWatchlist = buildExclusionSet(["cw-1"], ["ra-1"]);
    const withWatchlist = buildExclusionSet(["cw-1"], ["ra-1"], ["wl-1"]);
    expect(withoutWatchlist.has("wl-1")).toBe(false);
    expect(withWatchlist.has("wl-1")).toBe(true);
  });

  it("returns an empty set given no sources", () => {
    expect(buildExclusionSet().size).toBe(0);
  });
});

describe("selectFeaturedPool", () => {
  const candidates = [
    { id: "a", addedAtMs: 1000 },
    { id: "b", addedAtMs: 3000 },
    { id: "c", addedAtMs: 2000 },
    { id: "d", addedAtMs: 5000 },
    { id: "e", addedAtMs: 4000 },
    { id: "f", addedAtMs: 6000 },
  ];

  it("excludes anything in the excluded set — a real constraint, not a reorder", () => {
    const excluded = buildExclusionSet(["d", "f"]);
    const pool = selectFeaturedPool(candidates, excluded, 5);
    expect(pool.some((c) => c.id === "d" || c.id === "f")).toBe(false);
  });

  it("orders survivors by most-recently-added first", () => {
    const pool = selectFeaturedPool(candidates, new Set(), 10);
    expect(pool.map((c) => c.id)).toEqual(["f", "d", "e", "b", "c", "a"]);
  });

  it("caps the pool at max (design: five)", () => {
    const pool = selectFeaturedPool(candidates, new Set(), 5);
    expect(pool).toHaveLength(5);
    expect(pool.map((c) => c.id)).not.toContain("a"); // the oldest, bumped by the cap
  });

  it("defaults max to 5 when not supplied", () => {
    const pool = selectFeaturedPool(candidates, new Set());
    expect(pool).toHaveLength(5);
  });

  it("never mutates the input candidates array", () => {
    const copy = candidates.map((c) => ({ ...c }));
    selectFeaturedPool(candidates, new Set(), 3);
    expect(candidates).toEqual(copy);
  });

  it("returns an empty pool when everything is excluded (no fabricated filler)", () => {
    const excluded = buildExclusionSet(candidates.map((c) => c.id));
    expect(selectFeaturedPool(candidates, excluded)).toEqual([]);
  });

  it("handles fewer than max survivors", () => {
    const excluded = buildExclusionSet(["a", "b", "c", "d"]);
    const pool = selectFeaturedPool(candidates, excluded, 5);
    expect(pool.map((c) => c.id)).toEqual(["f", "e"]);
  });
});
