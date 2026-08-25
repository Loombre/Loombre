// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/featured-pool.ts
//
// Pure "featured pool" selection for Home's rotating banner (design/
// phosphor/README.md §Screens -> Home): "The featured candidates must be
// titles that appear in none of those rails ... Build the exclusion set
// from the continue-watching items, the Recently Added grid, and the
// watchlist, then take up to five of the remaining library titles ... make
// this a real query constraint, not a preference ordering." No timers, no
// fetch, no DOM — a real Set-difference plus a real recency sort, so it is
// independently unit-testable and cannot silently degrade into "reorder,
// don't exclude" (the exact regression the README calls out: two earlier
// prototype revisions leaked a duplicate first from Continue Watching, then
// from Recently Added).
//
// SCOPE OF THE EXCLUSION (browser-shell-browse-F8, owner ruling
// 2026-08-24). A rail's exclusion source is the ids that rail actually puts
// ON SCREEN — visibleRailIds() below — not the whole page of rows Home
// fetched behind it. QA found the banner structurally unreachable on a real
// 30-movie library: /home/recently-added returned 35 rows, the rail listed
// them all, and that set was a SUPERSET of the featured candidates' own
// 25+25 over-fetch, so the Set-difference was empty every single time and
// no banner could ever render. The README's rule is kept where its own
// stated reason lives — "shipped a featured item that duplicated a card in
// the same fold" — so what shares the fold with the banner (Recently
// Added's first page) is excluded, and what is behind a horizontal scroll
// is eligible. Raising the candidate over-fetch would NOT have fixed this:
// it only moves the same collision to a slightly larger library.
//
// SIBLING SEAM (Wave 2 lane L3 owns the Watchlist rail + toggle state):
// buildExclusionSet() takes any number of id SOURCES rather than one
// pre-merged list, specifically so the orchestrator's reconciliation can
// add the watchlist id source as a one-line addition once L3 lands, with
// zero change to this function's shape or this lane's call site beyond
// that one argument. See app/home/page.tsx's WATCHLIST_IDS_SEAM constant
// for the placeholder source it passes today.

/** Merges any number of id iterables (arrays, Sets, ...) into one Set. */
export function buildExclusionSet(...sources: Iterable<string>[]): Set<string> {
  const excluded = new Set<string>();
  for (const source of sources) {
    for (const id of source) excluded.add(id);
  }
  return excluded;
}

export interface FeaturedPoolCandidate {
  id: string;
  /** Format: int64 — CatalogItemBase.addedAtMs (packages/contract/openapi.
   *  yaml), the one real "how recent" field every Movie/Series row carries. */
  addedAtMs: number;
}

/**
 * Real Set-difference against `excluded`, then the most-recently-added
 * `max` survivors. This is the honest "most-recently-added-unwatched"
 * heuristic available to a client: list endpoints (GET /movies, /series)
 * carry no per-item "already watched" flag, only continue-watching
 * MEMBERSHIP is knowable, so "recently added, and not already surfaced
 * anywhere else on Home" is what the available data can actually support —
 * not a stand-in for a real watched/unwatched signal. Logged as a follow-up
 * in this lane's freeze report: the README itself asks for this to move
 * server-side eventually for cross-device consistency.
 */
export function selectFeaturedPool<T extends FeaturedPoolCandidate>(
  candidates: readonly T[],
  excluded: ReadonlySet<string>,
  max = 5,
): T[] {
  return candidates
    .filter((c) => !excluded.has(c.id))
    .slice()
    .sort((a, b) => b.addedAtMs - a.addedAtMs)
    .slice(0, max);
}

/**
 * The ids a rail actually shows without scrolling: its first
 * `visibleCount` entries, in rail order. Home passes the Recently Added
 * rail through this before it becomes an exclusion source (see this
 * module's header and app/home/HomeContent.tsx's
 * RECENTLY_ADDED_VISIBLE_CARDS, which is where that count is derived from
 * the rail's real card geometry — this function never invents one).
 *
 * A non-positive `visibleCount` yields NO exclusions rather than the whole
 * rail: "nothing is on screen" must never silently mean "exclude
 * everything", which is the failure mode this whole change is about.
 */
export function visibleRailIds(railIds: readonly string[], visibleCount: number): string[] {
  return visibleCount > 0 ? railIds.slice(0, visibleCount) : [];
}
