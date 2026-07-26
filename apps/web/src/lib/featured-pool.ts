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
