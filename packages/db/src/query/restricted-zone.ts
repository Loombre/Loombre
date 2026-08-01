// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/restricted-zone.ts
//
// Restricted zone aggregate count (STATE.md Phosphor retheme, W1c
// "contract enablers" lane; design/phosphor/README.md "Interactions ->
// Restricted content" / U10): the zone's EXISTENCE and aggregate item
// count are deliberately visible to entitled users REGARDLESS of the
// current lock state (gate 5 / ctx.restrictedCleared) — the owner-accepted
// disclosure is "that a zone exists and how big it is", never titles or
// artwork. Restricted-profile viewers (no entitlement at all) must get
// NOTHING: for them the zone does not exist, server-side, full stop.
//
// Entitlement, ground-truthed against apps/server/src/common/
// viewer-context.provider.ts: ViewerContextProvider populates
// ctx.allowedLibraryIds with a restricted library's id iff gates 1-4 (server
// capability, age, opt-in+PIN, explicit library_permissions grant) ALL
// pass — deliberately INDEPENDENT of gate 5 (live session unlock), which
// only gates ctx.restrictedCleared. So "does ctx.allowedLibraryIds contain
// at least one restricted-class library id" is EXACTLY "gates 1-4 passed
// for this viewer", independent of whether they're currently locked —
// precisely the entitlement question this surface needs, already answered
// by the ViewerContext this package always requires (CLAUDE.md invariant
// 4), with no new field needed on that type. Verified against
// packages/db/test/leak.spec.ts's own fixtures: `casualUncleared`
// (allowedLibraryIds = general only — not entitled) vs
// `adminClearedButNotUnlocked` (allowedLibraryIds = ALL libraries incl.
// restricted, restrictedCleared: false — entitled but locked).
//
// getRestrictedZoneCountForViewer (below) deliberately does NOT call
// applyGuard()/apply the ctx.restrictedCleared content_class branch at all
// — that branch exists to hide restricted rows from a LOCKED-but-entitled
// viewer, which is exactly the case this ONE surface must NOT hide (U10:
// the aggregate count is visible regardless of lock state). Instead:
// library membership is resolved to the entitled subset of
// ctx.allowedLibraryIds ourselves (a real `libraries` lookup, not trusting
// the ctx array blindly — a defense-in-depth double-check that the ids in
// question really are restricted-class libraries), content_class is
// pinned explicitly to 'restricted', and the missing-file visibility rule
// (docs/PLAN.md §8.2) is reused verbatim via applyNotMissingFilesFilter so
// the count matches what listItems()-style reads would actually surface
// once unlocked — never a raw, ungoverned `count(*)`.
//
// STATE.md Stash run (K4): the OLD "fetch the whole list client-side and
// filter/sort/search locally" design this file used to also expose
// (listRestrictedZoneItemsForViewer, GET /restricted/items) is SUPERSEDED
// — the dedicated Restricted Content surface (S9) now has real guarded
// server-side keyset endpoints under src/query/restricted-browse.ts,
// restricted-performers.ts, restricted-studios.ts, restricted-search.ts,
// and restricted-home.ts, all of which share the SAME entitlement
// resolution this file already established — resolveEntitledRestrictedLibraryIds
// is exported (was module-private) for exactly that reuse, so there is
// only ever ONE implementation of "does ctx hold restricted-zone
// entitlement" across every zone query module, never a second copy that
// could drift. getRestrictedZoneCountForViewer stays here unchanged (still
// the zone's own gate-screen aggregate, per U10) and is the reason this
// file — rather than one of the new ones — remains the entitlement
// resolver's home.

import type { Kysely } from 'kysely';
import type { DB } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyNotMissingFilesFilter } from './guard.js';

export interface RestrictedZoneCount {
  count: number;
}

/**
 * The entitlement resolution EVERY restricted-zone query module shares:
 * "does `ctx` hold at least one restricted-class library id in its own
 * allowedLibraryIds" (gates 1-4, independent of gate 5/restrictedCleared —
 * see module header). Returns the empty array for "not entitled" rather
 * than a boolean so callers get the actual ids to filter on, not just a
 * yes/no. Exported (STATE.md Stash run K4) so restricted-browse.ts/
 * restricted-performers.ts/restricted-studios.ts/restricted-search.ts/
 * restricted-home.ts all call this SAME implementation rather than each
 * re-deriving it.
 */
export async function resolveEntitledRestrictedLibraryIds(db: Kysely<DB>, ctx: ViewerContext): Promise<string[]> {
  if (ctx.allowedLibraryIds.length === 0) {
    return [];
  }
  const rows = await db
    .selectFrom('libraries')
    .select('id')
    .where('content_class', '=', 'restricted')
    .where('id', 'in', ctx.allowedLibraryIds)
    .execute();
  return rows.map((row) => row.id);
}

/**
 * Returns the restricted zone's aggregate, guard-consistent item count for
 * `ctx`, or `null` when `ctx` holds NO restricted-library entitlement at
 * all (this module's header) — the caller must turn `null` into a 404, NOT
 * `{ count: 0 }` (a zero count would itself let a restricted-profile
 * viewer infer "a zone exists with nothing in it", the exact side channel
 * U10 forbids). Only ever selects a COUNT aggregate — no title, artwork,
 * or id column is read here, by construction, so there is no code path
 * through this function that could leak zone content.
 */
export async function getRestrictedZoneCountForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext
): Promise<RestrictedZoneCount | null> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);

  if (restrictedLibraryIds.length === 0) {
    // Not entitled (gates 1-4 never all passed for this viewer) — the zone
    // does not exist for them, independent of ctx.restrictedCleared.
    return null;
  }

  const result = await applyNotMissingFilesFilter(
    db
      .selectFrom('catalog_items')
      .where('library_id', 'in', restrictedLibraryIds)
      .where('content_class', '=', 'restricted')
  )
    .select((eb) => eb.fn.countAll().as('count'))
    .executeTakeFirst();

  return { count: Number(result?.count ?? 0) };
}
