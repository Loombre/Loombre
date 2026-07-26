// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/restricted-zone-toolbar.ts
//
// Pure state/derivation logic for the /restricted zone's OWN query toolbar
// (design/phosphor/README.md "Interactions -> Restricted content"; STATE.md
// Phosphor W2 L8). Deliberately separate from apps/web/src/components/
// browse/** (SortControl, LibraryPills, useCursorFeed): the zone's search/
// genre/quality/sort state must never touch the general library's browse
// store (U10 hard line) — this module owns its OWN, freestanding state
// shape, consumed only by the zone's own components.
//
// Design (see restricted-zone.ts's server-side header for why): GET
// /restricted/items has no q/sort params — the zone is a small, curated
// collection by product design, so the client fetches it in FULL (see
// lib/restricted-zone-items.ts) and this module does every search/genre/
// quality/sort operation locally, in memory, over that already-fetched,
// already-guarded page. This is a stronger property than "a separate
// server-side index" for leak-avoidance purposes: there is no zone-search
// HTTP call at all, so there is no shared code path with GET /search to
// ever drift out of sync with.
//
// Kept as pure functions (no hooks) for the same testability reason
// shell/mobile-header.ts and shell/nav-items.ts's predicates are — the
// component layer (RestrictedZoneToolbar.tsx) is a thin render of whatever
// this returns.

export type ZoneSort = "recently-added" | "title" | "year";

/** Cycling order, matching the README literally: "Recently Added / Title
 *  A–Z / Year". */
export const ZONE_SORT_CYCLE: readonly ZoneSort[] = ["recently-added", "title", "year"];

export const ZONE_SORT_LABELS: Record<ZoneSort, string> = {
  "recently-added": "Recently Added",
  title: "Title A–Z",
  year: "Year",
};

export interface ZoneToolbarState {
  search: string;
  /** null = the "ALL" genre pill (no genre filter active). */
  genre: string | null;
  only4k: boolean;
  onlyHdr: boolean;
  sort: ZoneSort;
}

export const INITIAL_ZONE_TOOLBAR_STATE: ZoneToolbarState = {
  search: "",
  genre: null,
  only4k: false,
  onlyHdr: false,
  sort: "recently-added",
};

/** Advances to the next sort in ZONE_SORT_CYCLE, wrapping around — the
 *  "cycling sort chip" interaction (tap advances one step), distinct from
 *  Browse's own SortControl tablist. */
export function cycleZoneSort(current: ZoneSort): ZoneSort {
  const index = ZONE_SORT_CYCLE.indexOf(current);
  const next = ZONE_SORT_CYCLE[(index + 1) % ZONE_SORT_CYCLE.length];
  return next ?? ZONE_SORT_CYCLE[0]!;
}

/** The minimal shape this module needs from a zone item — matches
 *  @loombre/sdk's RestrictedZoneItem structurally without importing it
 *  (keeps this module dependency-free/easily unit-testable). */
export interface ZoneItemLike {
  id: string;
  title: string;
  sortTitle: string;
  year: number | null;
  addedAtMs: number;
  genres: string[];
  quality: { is4k: boolean; hdr: string };
}

/** Genre pills are DERIVED from the zone's actual titles (README: "genre
 *  pills derived from the zone's titles [...] — derive, don't hardcode"),
 *  from the FULL unfiltered set so the pill row stays stable while a
 *  search/other filter narrows the grid — mirrors Browse's LibraryPills
 *  deriving from the library list rather than the current page. */
export function deriveZoneGenres(items: readonly ZoneItemLike[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    for (const genre of item.genres) set.add(genre);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function matchesZoneToolbarState(item: ZoneItemLike, state: ZoneToolbarState): boolean {
  const q = state.search.trim().toLowerCase();
  if (q.length > 0 && !item.title.toLowerCase().includes(q)) return false;
  if (state.genre !== null && !item.genres.includes(state.genre)) return false;
  if (state.only4k && !item.quality.is4k) return false;
  if (state.onlyHdr && item.quality.hdr === "none") return false;
  return true;
}

function compareZoneItems(a: ZoneItemLike, b: ZoneItemLike, sort: ZoneSort): number {
  switch (sort) {
    case "title":
      return a.sortTitle.localeCompare(b.sortTitle);
    case "year":
      // Undated items sort last, regardless of direction (same convention
      // packages/db/src/query/catalog-detail.ts's sortKeyExpr documents for
      // Browse's own year sort).
      return (b.year ?? -1) - (a.year ?? -1);
    case "recently-added":
    default:
      return b.addedAtMs - a.addedAtMs;
  }
}

/** Filters then sorts — the zone grid's entire data pipeline for one
 *  toolbar state snapshot. Generic over T (extends ZoneItemLike) so the
 *  caller gets back its own richer row type (with images etc.), not a
 *  stripped-down one. */
export function filterAndSortZoneItems<T extends ZoneItemLike>(
  items: readonly T[],
  state: ZoneToolbarState,
): T[] {
  return items
    .filter((item) => matchesZoneToolbarState(item, state))
    .slice()
    .sort((a, b) => compareZoneItems(a, b, state.sort));
}

/** The mono readout line: "N OF TOTAL · SORT · ZONE-ONLY INDEX". */
export function zoneReadout(filteredCount: number, totalCount: number, sort: ZoneSort): string {
  return `${filteredCount} OF ${totalCount} · ${ZONE_SORT_LABELS[sort].toUpperCase()} · ZONE-ONLY INDEX`;
}

export function hasActiveZoneFilters(state: ZoneToolbarState): boolean {
  return state.search.trim().length > 0 || state.genre !== null || state.only4k || state.onlyHdr;
}

/** "CLEAR SEARCH & FILTERS" — resets everything except sort (the README's
 *  empty state only ever promises to clear search+filters, not the user's
 *  chosen sort order). */
export function clearZoneFilters(state: ZoneToolbarState): ZoneToolbarState {
  return { ...state, search: "", genre: null, only4k: false, onlyHdr: false };
}
