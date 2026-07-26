// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/restricted-zone-toolbar.test.ts

import { describe, expect, it } from "vitest";
import {
  INITIAL_ZONE_TOOLBAR_STATE,
  ZONE_SORT_CYCLE,
  clearZoneFilters,
  cycleZoneSort,
  deriveZoneGenres,
  filterAndSortZoneItems,
  hasActiveZoneFilters,
  zoneReadout,
  type ZoneItemLike,
  type ZoneToolbarState,
} from "./restricted-zone-toolbar.js";

// Fixture titles are THRILLER/WESTERN/WAR-flavored per the prototype's own
// examples — deliberately not literal-hardcoded anywhere in the module
// under test (see deriveZoneGenres), only here as test data standing in
// for real API-derived items.
function item(overrides: Partial<ZoneItemLike> & { id: string }): ZoneItemLike {
  return {
    title: "Untitled",
    sortTitle: "Untitled",
    year: null,
    addedAtMs: 0,
    genres: [],
    quality: { is4k: false, hdr: "none" },
    ...overrides,
  };
}

const FIXTURES: ZoneItemLike[] = [
  item({ id: "1", title: "After Hours Redline", sortTitle: "After Hours Redline", year: 2021, addedAtMs: 300, genres: ["Thriller"], quality: { is4k: true, hdr: "hdr10" } }),
  item({ id: "2", title: "Velvet Static", sortTitle: "Velvet Static", year: 2019, addedAtMs: 100, genres: ["Western"], quality: { is4k: false, hdr: "none" } }),
  item({ id: "3", title: "Midnight Ledger", sortTitle: "Midnight Ledger", year: 2023, addedAtMs: 200, genres: ["War", "Thriller"], quality: { is4k: true, hdr: "none" } }),
  item({ id: "4", title: "Undertow Confidential", sortTitle: "Undertow Confidential", year: null, addedAtMs: 400, genres: [], quality: { is4k: false, hdr: "dv" } }),
];

describe("cycleZoneSort", () => {
  it("advances through the exact README cycle: Recently Added -> Title A-Z -> Year -> back to Recently Added", () => {
    expect(ZONE_SORT_CYCLE).toEqual(["recently-added", "title", "year"]);
    expect(cycleZoneSort("recently-added")).toBe("title");
    expect(cycleZoneSort("title")).toBe("year");
    expect(cycleZoneSort("year")).toBe("recently-added");
  });
});

describe("deriveZoneGenres", () => {
  it("derives a sorted, deduplicated genre list from the items themselves — never a hardcoded list", () => {
    expect(deriveZoneGenres(FIXTURES)).toEqual(["Thriller", "War", "Western"]);
  });

  it("returns an empty array for an empty zone", () => {
    expect(deriveZoneGenres([])).toEqual([]);
  });
});

describe("filterAndSortZoneItems", () => {
  it("with no active filters, returns every item sorted by the active sort", () => {
    const byAdded = filterAndSortZoneItems(FIXTURES, INITIAL_ZONE_TOOLBAR_STATE);
    expect(byAdded.map((i) => i.id)).toEqual(["4", "1", "3", "2"]); // addedAtMs desc

    const byTitle = filterAndSortZoneItems(FIXTURES, { ...INITIAL_ZONE_TOOLBAR_STATE, sort: "title" });
    expect(byTitle.map((i) => i.title)).toEqual([
      "After Hours Redline",
      "Midnight Ledger",
      "Undertow Confidential",
      "Velvet Static",
    ]);

    const byYear = filterAndSortZoneItems(FIXTURES, { ...INITIAL_ZONE_TOOLBAR_STATE, sort: "year" });
    // Undated ("Undertow Confidential") sorts LAST regardless of direction.
    expect(byYear.map((i) => i.id)).toEqual(["3", "1", "2", "4"]);
  });

  it("search matches title case-insensitively, substring", () => {
    const result = filterAndSortZoneItems(FIXTURES, { ...INITIAL_ZONE_TOOLBAR_STATE, search: "velvet" });
    expect(result.map((i) => i.id)).toEqual(["2"]);
  });

  it("genre filter narrows to items carrying that exact genre", () => {
    const result = filterAndSortZoneItems(FIXTURES, { ...INITIAL_ZONE_TOOLBAR_STATE, genre: "Thriller" });
    expect(result.map((i) => i.id).sort()).toEqual(["1", "3"]);
  });

  it("4K and HDR toggles filter independently and can combine", () => {
    const only4k = filterAndSortZoneItems(FIXTURES, { ...INITIAL_ZONE_TOOLBAR_STATE, only4k: true });
    expect(only4k.map((i) => i.id).sort()).toEqual(["1", "3"]);

    const onlyHdr = filterAndSortZoneItems(FIXTURES, { ...INITIAL_ZONE_TOOLBAR_STATE, onlyHdr: true });
    expect(onlyHdr.map((i) => i.id).sort()).toEqual(["1", "4"]);

    const both = filterAndSortZoneItems(FIXTURES, { ...INITIAL_ZONE_TOOLBAR_STATE, only4k: true, onlyHdr: true });
    expect(both.map((i) => i.id)).toEqual(["1"]);
  });

  it("combining search + genre + quality filters that match nothing returns an empty array (the dashed empty-state case)", () => {
    const result = filterAndSortZoneItems(FIXTURES, {
      ...INITIAL_ZONE_TOOLBAR_STATE,
      search: "velvet",
      genre: "Thriller",
    });
    expect(result).toEqual([]);
  });
});

describe("zoneReadout", () => {
  it("formats the exact mono readout shape", () => {
    expect(zoneReadout(2, 4, "recently-added")).toBe("2 OF 4 · RECENTLY ADDED · ZONE-ONLY INDEX");
    expect(zoneReadout(4, 4, "title")).toBe("4 OF 4 · TITLE A–Z · ZONE-ONLY INDEX");
    expect(zoneReadout(0, 4, "year")).toBe("0 OF 4 · YEAR · ZONE-ONLY INDEX");
  });
});

describe("hasActiveZoneFilters / clearZoneFilters", () => {
  it("reports false for the initial state, true once any filter is set", () => {
    expect(hasActiveZoneFilters(INITIAL_ZONE_TOOLBAR_STATE)).toBe(false);
    expect(hasActiveZoneFilters({ ...INITIAL_ZONE_TOOLBAR_STATE, search: "x" })).toBe(true);
    expect(hasActiveZoneFilters({ ...INITIAL_ZONE_TOOLBAR_STATE, genre: "Thriller" })).toBe(true);
    expect(hasActiveZoneFilters({ ...INITIAL_ZONE_TOOLBAR_STATE, only4k: true })).toBe(true);
    expect(hasActiveZoneFilters({ ...INITIAL_ZONE_TOOLBAR_STATE, onlyHdr: true })).toBe(true);
  });

  it("sort is NOT considered an active filter (a non-default sort alone shouldn't trigger CLEAR SEARCH & FILTERS)", () => {
    expect(hasActiveZoneFilters({ ...INITIAL_ZONE_TOOLBAR_STATE, sort: "title" })).toBe(false);
  });

  it("clearZoneFilters resets search/genre/quality but preserves sort", () => {
    const dirty: ZoneToolbarState = { search: "x", genre: "Thriller", only4k: true, onlyHdr: true, sort: "year" };
    const cleared = clearZoneFilters(dirty);
    expect(cleared).toEqual({ ...INITIAL_ZONE_TOOLBAR_STATE, sort: "year" });
  });
});
