// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/context.ts
//
// Every guarded query entry point requires one of these. It is the ONLY
// input that determines what a caller can see — see docs/PLAN.md §6.4 for
// the five-gate model this resolves down to a boolean + id set + surface by
// the time it reaches packages/db.

/**
 * Which surface a request serves (docs/PLAN.md §6.4 surface scoping, run
 * RZI-2026-08-30 / DECISIONS.md §2026-08-29): 'restricted' is the dedicated
 * zone plus the full-clearance item-addressed reads that serve it (playback,
 * images, chapters, item-addressed progress/watchlist ops, admin tooling
 * per RZI-D6, data-freedom export per RZI-D7). Everything else — browse,
 * search, home rails, watchlist/progress lists, people, tags — is
 * 'general', where restricted rows are excluded UNCONDITIONALLY: a live
 * gate-5 unlock never widens a general surface (design/phosphor/README.md's
 * "never appear … locked or not" law). apps/server's grep-gate (f) pins
 * which files may resolve a restricted-surface context.
 */
export type ViewerSurface = 'general' | 'restricted';

export interface ViewerContext {
  /** The requesting user's id (catalog_items has no direct owner column;
   *  kept here for future per-user features — e.g. progress joins — that
   *  reuse this context without changing its shape). */
  userId: string;
  /** Library ids this user is permitted to see at all (library_permissions
   *  resolved upstream: general libraries the user has access to, plus
   *  restricted libraries only if gate 4 — the explicit grant — passed).
   *  A general-surface context excludes restricted library ids entirely
   *  (defense in depth; the guard's class clause already pins it). */
  allowedLibraryIds: string[];
  /** True only when ALL FIVE gates in §6.4 have passed for this request:
   *  capability enabled, age-eligible, opted in, library-permission granted,
   *  AND the live session unlock (gate 5) is currently valid. When false,
   *  the guard forces `content_class = 'general'` regardless of what is in
   *  allowedLibraryIds. Clearance is NECESSARY but not sufficient: the
   *  guard lifts the class clause only when `surface` is ALSO 'restricted'. */
  restrictedCleared: boolean;
  /** The requesting surface — see ViewerSurface above. Required (no
   *  default) so every construction site chooses explicitly. */
  surface: ViewerSurface;
}
