// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/tags.ts
//
// listTags — the tag-side analogue of src/query/people.ts; see that file's
// header for the visibility model (content_class isolation AND credited-
// on-a-visible-item, both required) and seed.mjs's 'Drama'/'restricted'
// name-collision + generalTags['Rare'] orphan-tag fixtures this is proven
// against in packages/db/test/leak.spec.ts.
//
// `kind` (genre|tag) lives on the item_tags EDGE, not on the tags row
// itself (a tag row has no kind of its own — migrations/0001_init.sql), so
// the `kind` filter param is applied to the join, and count is scoped to
// that same filtered join when a kind is requested.

import type { Kysely } from 'kysely';
import type { ContentClass, DB, ItemTagKind } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuardToJoined, applyGuardToTags } from './guard.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';

export interface TagRow {
  id: string;
  name: string;
  contentClass: ContentClass;
  /** Count of DISTINCT items visible to ctx carrying this tag (scoped to
   *  `params.kind` when provided). */
  itemCount: number;
}

export interface ListTagsParams {
  cursor?: string;
  limit?: number;
  kind?: ItemTagKind;
}

export interface ListTagsResult {
  rows: TagRow[];
  nextCursor: string | null;
}

interface TagsCursorPayload {
  name: string;
  id: string;
}

function isTagsCursorPayload(value: unknown): value is TagsCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    isCursorRowId((value as Record<string, unknown>).id)
  );
}

const DEFAULT_LIMIT = 50;

export async function listTags(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListTagsParams = {}
): Promise<ListTagsResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = applyGuardToTags(db.selectFrom('tags'), ctx)
    .innerJoin('item_tags', 'item_tags.tag_id', 'tags.id')
    .where(applyGuardToJoined(ctx, 'item_tags.item_id'));

  if (params.kind) {
    query = query.where('item_tags.kind', '=', params.kind);
  }

  if (params.cursor) {
    const { name, id } = decodeCursor(params.cursor, isTagsCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('tags.name', '>', name),
        eb.and([eb('tags.name', '=', name), eb('tags.id', '>', id)]),
      ])
    );
  }

  const rows = await query
    .groupBy(['tags.id', 'tags.name', 'tags.content_class'])
    .select((eb) => [
      'tags.id as id',
      'tags.name as name',
      'tags.content_class as contentClass',
      eb.fn.count<string>('item_tags.item_id').distinct().as('itemCount'),
    ])
    .orderBy('tags.name', 'asc')
    .orderBy('tags.id', 'asc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ name: last.name, id: last.id }) : null;

  return {
    rows: rows.map((r) => ({ ...r, itemCount: Number(r.itemCount) })),
    nextCursor,
  };
}
