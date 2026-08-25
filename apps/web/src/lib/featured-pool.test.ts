// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildExclusionSet, selectFeaturedPool, visibleRailIds } from "./featured-pool.js";

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

// browser-shell-browse-F8 (owner ruling 2026-08-24): the exclusion covers
// the Recently Added rail's VISIBLE FIRST PAGE, not the whole page of rows
// Home fetches behind it. Before this, a small/medium library whose rail
// listed every recently-added title excluded the entire featured-candidate
// over-fetch and the banner could never appear at all.
describe("visibleRailIds", () => {
  const rail = Array.from({ length: 14 }, (_, i) => `ra-${String(i + 1).padStart(2, "0")}`);

  it("keeps only the rail's first page of ids", () => {
    expect(visibleRailIds(rail, 10)).toEqual(rail.slice(0, 10));
  });

  it("returns every id when the rail is shorter than one page", () => {
    expect(visibleRailIds(["a", "b"], 10)).toEqual(["a", "b"]);
  });

  it("returns nothing for a non-positive page size (never a silent full-rail exclusion)", () => {
    expect(visibleRailIds(rail, 0)).toEqual([]);
    expect(visibleRailIds(rail, -3)).toEqual([]);
  });

  it("never mutates the rail it is given", () => {
    const copy = [...rail];
    visibleRailIds(rail, 4);
    expect(rail).toEqual(copy);
  });

  it("REGRESSION (browser-shell-browse-F8): candidate #11 of the rail survives exclusion, so the banner has a pool", () => {
    // The QA shape: the rail lists the SAME titles the featured over-fetch
    // returns (a library smaller than the over-fetch), so excluding the
    // whole rail left pool size 0 and no banner ever rendered.
    const candidates = rail.map((id, i) => ({ id, addedAtMs: 14_000 - i * 1_000 }));

    const wholeRail = selectFeaturedPool(candidates, buildExclusionSet(rail), 5);
    expect(wholeRail).toEqual([]); // the old rule: structurally no banner

    const firstPageOnly = selectFeaturedPool(candidates, buildExclusionSet(visibleRailIds(rail, 10)), 5);
    expect(firstPageOnly.map((c) => c.id)).toEqual(["ra-11", "ra-12", "ra-13", "ra-14"]);
  });
});
