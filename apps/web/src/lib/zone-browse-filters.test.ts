// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZONE_SORT,
  EMPTY_ZONE_FILTERS,
  durationMinutesToMs,
  hasActiveZoneFilters,
  parseZoneBrowseFilters,
  zoneBrowseFiltersToSearchParams,
} from "./zone-browse-filters.js";

describe("zone-browse-filters", () => {
  it("parses an empty query string to the default (no filters, added sort)", () => {
    const filters = parseZoneBrowseFilters(new URLSearchParams());
    expect(filters).toEqual(EMPTY_ZONE_FILTERS);
    expect(filters.sort).toBe(DEFAULT_ZONE_SORT);
  });

  it("parses comma-separated id lists for performers/studios/genres", () => {
    const filters = parseZoneBrowseFilters(new URLSearchParams("performers=a,b&studios=c&genres=d,e,f"));
    expect(filters.performerIds).toEqual(["a", "b"]);
    expect(filters.studioTagIds).toEqual(["c"]);
    expect(filters.tagIds).toEqual(["d", "e", "f"]);
  });

  it("trims whitespace and drops empty segments from id lists", () => {
    const filters = parseZoneBrowseFilters(new URLSearchParams("performers=a, ,b,"));
    expect(filters.performerIds).toEqual(["a", "b"]);
  });

  it("parses numeric range params", () => {
    const filters = parseZoneBrowseFilters(
      new URLSearchParams("ratingMin=5&ratingMax=9&durationMin=30&durationMax=180&yearMin=2019&yearMax=2023"),
    );
    expect(filters.ratingMin).toBe(5);
    expect(filters.ratingMax).toBe(9);
    expect(filters.durationMinMinutes).toBe(30);
    expect(filters.durationMaxMinutes).toBe(180);
    expect(filters.yearMin).toBe(2019);
    expect(filters.yearMax).toBe(2023);
  });

  it("silently drops a malformed numeric param rather than throwing", () => {
    const filters = parseZoneBrowseFilters(new URLSearchParams("ratingMin=not-a-number"));
    expect(filters.ratingMin).toBeUndefined();
  });

  it("only accepts real RestrictedResolutionBand values, dropping unrecognized ones", () => {
    const filters = parseZoneBrowseFilters(new URLSearchParams("resolution=FHD,UHD,BOGUS"));
    expect(filters.resolution).toEqual(["FHD", "UHD"]);
  });

  it("falls back to the default sort for an unrecognized sort value", () => {
    const filters = parseZoneBrowseFilters(new URLSearchParams("sort=alphabetical"));
    expect(filters.sort).toBe(DEFAULT_ZONE_SORT);
  });

  it("accepts a real sort + order pair", () => {
    const filters = parseZoneBrowseFilters(new URLSearchParams("sort=rating&order=asc"));
    expect(filters.sort).toBe("rating");
    expect(filters.order).toBe("asc");
  });

  it("round-trips through zoneBrowseFiltersToSearchParams -> parseZoneBrowseFilters", () => {
    const original = parseZoneBrowseFilters(
      new URLSearchParams("performers=a,b&studios=c&genres=d&ratingMin=5&resolution=UHD&sort=duration&order=asc"),
    );
    const serialized = zoneBrowseFiltersToSearchParams(original);
    const reparsed = parseZoneBrowseFilters(serialized);
    expect(reparsed).toEqual(original);
  });

  it("omits the default sort (added) from the serialized query string — clean URL at the starting state", () => {
    const params = zoneBrowseFiltersToSearchParams(EMPTY_ZONE_FILTERS);
    expect(params.toString()).toBe("");
  });

  it("omits a non-default sort's params only when actually set", () => {
    const params = zoneBrowseFiltersToSearchParams({ ...EMPTY_ZONE_FILTERS, sort: "title" });
    expect(params.get("sort")).toBe("title");
    expect(params.has("order")).toBe(false);
  });

  it("durationMinutesToMs converts minutes to ms, passing through undefined", () => {
    expect(durationMinutesToMs(90)).toBe(5_400_000);
    expect(durationMinutesToMs(undefined)).toBeUndefined();
  });

  it("hasActiveZoneFilters is false for the empty state and true once any facet is set", () => {
    expect(hasActiveZoneFilters(EMPTY_ZONE_FILTERS)).toBe(false);
    expect(hasActiveZoneFilters({ ...EMPTY_ZONE_FILTERS, performerIds: ["a"] })).toBe(true);
    expect(hasActiveZoneFilters({ ...EMPTY_ZONE_FILTERS, ratingMin: 5 })).toBe(true);
    expect(hasActiveZoneFilters({ ...EMPTY_ZONE_FILTERS, resolution: ["HD"] })).toBe(true);
  });

  it("hasActiveZoneFilters ignores sort/order — those aren't 'filters'", () => {
    expect(hasActiveZoneFilters({ ...EMPTY_ZONE_FILTERS, sort: "rating", order: "asc" })).toBe(false);
  });
});
