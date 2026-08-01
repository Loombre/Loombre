// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/zone-browse-filters.ts
//
// STATE.md Stash run (S9): /restricted/browse's filter/sort state, kept in
// the URL query string (shareable within a session; meaningless outside
// the gate — the lane brief's own framing) rather than component state.
// Mirrors app/browse/page.tsx's `?library=` precedent (URL as the single
// source of truth, `router.replace` on every change) generalized to the
// zone's full filter set: performers/studios/genres (comma-separated id
// lists, matching apps/server/src/session/restricted-query.ts's own CSV
// parsing convention), rating/duration/year ranges, resolution bands, and
// sort/order.
//
// Density (poster-wall <-> detailed-rows) is DELIBERATELY NOT here — it is
// a personal display preference, not shareable filter state, so it lives
// in zone-density-prefs.ts's localStorage store instead (same split
// appearance-prefs.ts already draws between "shareable via URL" and
// "sticks to this browser").

import type { components } from "@loombre/sdk";

export type ZoneResolutionBand = components["schemas"]["RestrictedResolutionBand"];
export type ZoneSort = components["schemas"]["RestrictedBrowseSort"];
export type ZoneOrder = "asc" | "desc";

export interface ZoneBrowseFilters {
  performerIds: string[];
  studioTagIds: string[];
  tagIds: string[];
  // `?: T | undefined` (not just `?: T`) throughout — this project's
  // tsconfig sets `exactOptionalPropertyTypes: true`, and ZoneFilterBar's
  // number inputs legitimately WRITE `undefined` back onto these fields
  // (clearing a min/max box), not merely omit the key.
  ratingMin?: number | undefined;
  ratingMax?: number | undefined;
  /** Minutes, not ms — the URL/UI unit; converted to ms at the API call
   *  site (durationMinutesToMs below). */
  durationMinMinutes?: number | undefined;
  durationMaxMinutes?: number | undefined;
  resolution: ZoneResolutionBand[];
  yearMin?: number | undefined;
  yearMax?: number | undefined;
  sort: ZoneSort;
  order?: ZoneOrder | undefined;
}

export const DEFAULT_ZONE_SORT: ZoneSort = "added";

export const ZONE_SORT_OPTIONS: readonly { value: ZoneSort; label: string }[] = [
  { value: "added", label: "Recently Added" },
  { value: "date", label: "Release Date" },
  { value: "title", label: "Title A–Z" },
  { value: "rating", label: "Highest Rated" },
  { value: "duration", label: "Duration" },
];

export const ZONE_RESOLUTION_BANDS: readonly ZoneResolutionBand[] = ["SD", "HD", "FHD", "UHD"];

const VALID_SORTS: ReadonlySet<string> = new Set<ZoneSort>(["added", "date", "title", "rating", "duration"]);
const VALID_BANDS: ReadonlySet<string> = new Set<ZoneResolutionBand>(ZONE_RESOLUTION_BANDS);

function parseCsv(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntParam(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Reads the zone's filter/sort state straight from a URLSearchParams —
 *  malformed/unrecognized values fall back to defaults or are dropped
 *  (same lenient posture apps/server's own query parsing takes; the
 *  guarded query layer is where a truly malformed id gets its house-rule
 *  "empty page, never a dropped filter" treatment — this is just URL
 *  ergonomics). */
export function parseZoneBrowseFilters(params: URLSearchParams): ZoneBrowseFilters {
  const sortRaw = params.get("sort");
  const sort = sortRaw && VALID_SORTS.has(sortRaw) ? (sortRaw as ZoneSort) : DEFAULT_ZONE_SORT;
  const orderRaw = params.get("order");
  const order = orderRaw === "asc" || orderRaw === "desc" ? orderRaw : undefined;

  const resolution = parseCsv(params.get("resolution")).filter((b): b is ZoneResolutionBand => VALID_BANDS.has(b));

  return {
    performerIds: parseCsv(params.get("performers")),
    studioTagIds: parseCsv(params.get("studios")),
    tagIds: parseCsv(params.get("genres")),
    ratingMin: parseIntParam(params.get("ratingMin")),
    ratingMax: parseIntParam(params.get("ratingMax")),
    durationMinMinutes: parseIntParam(params.get("durationMin")),
    durationMaxMinutes: parseIntParam(params.get("durationMax")),
    resolution,
    yearMin: parseIntParam(params.get("yearMin")),
    yearMax: parseIntParam(params.get("yearMax")),
    sort,
    ...(order !== undefined ? { order } : {}),
  };
}

/** Serializes filter state back to a query string (no leading `?`) —
 *  omits every default/empty value so the URL stays clean at the "no
 *  filters" starting state (matches app/browse/page.tsx never writing
 *  `?sort=added` for the default sort). */
export function zoneBrowseFiltersToSearchParams(filters: ZoneBrowseFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.performerIds.length > 0) params.set("performers", filters.performerIds.join(","));
  if (filters.studioTagIds.length > 0) params.set("studios", filters.studioTagIds.join(","));
  if (filters.tagIds.length > 0) params.set("genres", filters.tagIds.join(","));
  if (filters.ratingMin !== undefined) params.set("ratingMin", String(filters.ratingMin));
  if (filters.ratingMax !== undefined) params.set("ratingMax", String(filters.ratingMax));
  if (filters.durationMinMinutes !== undefined) params.set("durationMin", String(filters.durationMinMinutes));
  if (filters.durationMaxMinutes !== undefined) params.set("durationMax", String(filters.durationMaxMinutes));
  if (filters.resolution.length > 0) params.set("resolution", filters.resolution.join(","));
  if (filters.yearMin !== undefined) params.set("yearMin", String(filters.yearMin));
  if (filters.yearMax !== undefined) params.set("yearMax", String(filters.yearMax));
  if (filters.sort !== DEFAULT_ZONE_SORT) params.set("sort", filters.sort);
  if (filters.order !== undefined) params.set("order", filters.order);
  return params;
}

export function durationMinutesToMs(minutes: number | undefined): number | undefined {
  return minutes === undefined ? undefined : minutes * 60_000;
}

/** True when no filter narrows the result set (sort/order alone don't
 *  count — this drives the "Clear filters" affordance's visibility). */
export function hasActiveZoneFilters(filters: ZoneBrowseFilters): boolean {
  return (
    filters.performerIds.length > 0 ||
    filters.studioTagIds.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.ratingMin !== undefined ||
    filters.ratingMax !== undefined ||
    filters.durationMinMinutes !== undefined ||
    filters.durationMaxMinutes !== undefined ||
    filters.resolution.length > 0 ||
    filters.yearMin !== undefined ||
    filters.yearMax !== undefined
  );
}

export const EMPTY_ZONE_FILTERS: ZoneBrowseFilters = {
  performerIds: [],
  studioTagIds: [],
  tagIds: [],
  resolution: [],
  sort: DEFAULT_ZONE_SORT,
};

/** Clears every FILTER facet, keeping the current sort/order untouched —
 *  "Clear filters"/"Clear search & filters" affordances (ZoneFilterBar,
 *  RestrictedZoneEmptyState) reset facets only; changing sort is a
 *  separate, deliberate user action this function must not undo. */
export function clearZoneFilters(filters: ZoneBrowseFilters): ZoneBrowseFilters {
  return {
    ...EMPTY_ZONE_FILTERS,
    sort: filters.sort,
    ...(filters.order !== undefined ? { order: filters.order } : {}),
  };
}
