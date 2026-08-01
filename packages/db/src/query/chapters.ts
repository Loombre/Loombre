// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/chapters.ts
//
// STATE.md Stash run (S7/K9): GET /items/{id}/chapters — the generic,
// content-agnostic read over chapter_markers (migrations/0019). "Generic"
// on purpose: the table is not item-type-restricted (item_type 'movie'
// today per K1's scene identity, but the schema doesn't encode that), and
// this is the SAME query the player consumes for ANY item id, not only
// restricted-zone scenes — restricted-browse.ts's getRestrictedSceneDetail
// embeds the identical rows inline as RestrictedSceneDetail.chapters for
// the zone's own detail page (that file's own inline chapter_markers read
// trusts the guard ALREADY established by resolving the scene row first —
// see its header); this module is the standalone entry point for a bare
// item id with no such prior guarantee.
//
// Visibility rides the owning item (house pattern — chapter_markers has no
// content_class of its own, exactly like watchlist.ts/progress.ts's
// per-user item-referencing tables): getItemById(db, ctx, id) is checked
// FIRST — undefined there means "does not exist OR not visible to ctx",
// indistinguishable, matching getItemById's own documented contract — and
// the caller (apps/server) maps that straight to 404, byte-identical to
// what a direct GET on the item itself would return for the same viewer.
// A visible item with zero markers returns an EMPTY array, never
// undefined: "no chapters" and "item not visible" are deliberately
// different, observable states.
//
// The chapter_markers SELECT itself ALSO re-applies applyGuardToJoined on
// item_id (the 0019 migration's own chapter_markers_item_start_idx COMMENT
// names this exact pattern) as defense-in-depth on top of the getItemById
// check above — belt-and-suspenders in the same spirit catalog-detail.ts's
// fetchGrandparentBatch documents for itself: a leak here would have to
// defeat BOTH the item-level guard check and this table-level one.

import type { Kysely } from 'kysely';
import type { ChapterMarkerSource, DB } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuardToJoined } from './guard.js';
import { getItemById } from './items.js';

export interface ChapterMarkerRow {
  title: string;
  startMs: number;
  source: ChapterMarkerSource;
}

/**
 * Ordered chapter markers (startMs ascending) for `itemId`, or `undefined`
 * if the item does not exist or is not visible to `ctx` (see module
 * header). Never throws for a well-formed but nonexistent/hidden id —
 * mirrors getItemById/getCatalogDetail's existing "hidden == nonexistent"
 * contract so the controller layer's notFound() mapping is a one-liner.
 */
export async function getChaptersForItem(
  db: Kysely<DB>,
  ctx: ViewerContext,
  itemId: string
): Promise<ChapterMarkerRow[] | undefined> {
  const item = await getItemById(db, ctx, itemId);
  if (!item) return undefined;

  const rows = await db
    .selectFrom('chapter_markers')
    .select(['title', 'start_ms', 'source'])
    .where('item_id', '=', itemId)
    .where(applyGuardToJoined(ctx, 'chapter_markers.item_id'))
    .orderBy('start_ms', 'asc')
    .orderBy('id', 'asc')
    .execute();

  return rows.map((r) => ({ title: r.title, startMs: r.start_ms, source: r.source }));
}
