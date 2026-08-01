// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/chapter-markers.ts
//
// chapter_markers writer (migrations/0019_restricted_editorial_schema.sql
// — K9/S7: Stash scene markers become player chapters). Wholesale
// delete-then-insert per item, the exact replaceItemTags/replaceItemPeople
// pattern (relations.ts) — a metadata refresh always supersedes the prior
// marker set wholesale rather than diffing individual markers, same
// rationale as those two.

import type { Selectable } from 'kysely';
import type { ChapterMarkerSource, ChapterMarkersTable } from '../types.js';
import type { DbOrTx } from './tx.js';
import { withTransaction } from './tx.js';

export type ChapterMarkerRow = Selectable<ChapterMarkersTable>;

export interface ChapterMarkerInput {
  title: string;
  startMs: number;
  source: ChapterMarkerSource;
}

/** Atomically replaces every chapter_markers row for `itemId` (delete-then-
 *  insert in one transaction, mirroring relations.ts's replaceItemTags/
 *  replaceItemPeople). No uniqueness on (item_id, start_ms) — two markers
 *  at the same offset are legal in Stash and preserved verbatim
 *  (migrations/0019's table comment), so this never dedupes `markers`. */
export async function replaceChapterMarkers(db: DbOrTx, itemId: string, markers: ChapterMarkerInput[]): Promise<ChapterMarkerRow[]> {
  return withTransaction(db, async (trx) => {
    await trx.deleteFrom('chapter_markers').where('item_id', '=', itemId).execute();
    if (markers.length === 0) return [];

    return trx
      .insertInto('chapter_markers')
      .values(markers.map((m) => ({ item_id: itemId, title: m.title, start_ms: m.startMs, source: m.source })))
      .returningAll()
      .execute();
  });
}

export async function getChapterMarkers(db: DbOrTx, itemId: string): Promise<ChapterMarkerRow[]> {
  return db.selectFrom('chapter_markers').selectAll().where('item_id', '=', itemId).orderBy('start_ms', 'asc').execute();
}
