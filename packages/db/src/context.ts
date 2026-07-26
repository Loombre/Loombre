// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/context.ts
//
// Every guarded query entry point requires one of these. It is the ONLY
// input that determines what a caller can see — see docs/PLAN.md §6.4 for
// the five-gate model this resolves down to a single boolean + id set by
// the time it reaches packages/db.

export interface ViewerContext {
  /** The requesting user's id (catalog_items has no direct owner column;
   *  kept here for future per-user features — e.g. progress joins — that
   *  reuse this context without changing its shape). */
  userId: string;
  /** Library ids this user is permitted to see at all (library_permissions
   *  resolved upstream: general libraries the user has access to, plus
   *  restricted libraries only if gate 4 — the explicit grant — passed). */
  allowedLibraryIds: string[];
  /** True only when ALL FIVE gates in §6.4 have passed for this request:
   *  capability enabled, age-eligible, opted in, library-permission granted,
   *  AND the live session unlock (gate 5) is currently valid. When false,
   *  the guard forces `content_class = 'general'` regardless of what is in
   *  allowedLibraryIds. */
  restrictedCleared: boolean;
}
