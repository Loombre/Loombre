// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/restricted-studios.ts
//
// STATE.md Stash run (S9/K2/S6): studios are first-class VIA tags —
// migration 0019's `tags.kind = 'studio'` (entity-level identity, studio
// image lives in `images` entity_type='tag') joined through
// `item_tags.kind = 'studio'` edges (K2's edge-level classification), the
// SAME kind-widening 0019 also gave item_tags. No new entity table (S6).
// Mirrors src/query/tags.ts's visibility model (content_class isolation
// AND "applied to >=1 item visible to ctx", applyGuardToTags/
// applyGuardToJoined — neither alone is sufficient) with the same two
// zone-specific additions restricted-performers.ts documents: a
// `kind = 'studio'` filter and restrictedLibraryIds scoping via
// src/query/restricted-zone.ts's shared resolveEntitledRestrictedLibraryIds.
//
// A studio's OWN catalog (its scenes) is deliberately NOT a function in
// this file — per the STATE.md Contract additions freeze, "GET
// /restricted/studios/{id} (+ catalog via browse filter)": the web client
// calls GET /restricted/browse?studioTagIds={id} directly, so there is
// only ONE implementation of the zone's filtered browse/keyset logic
// (listRestrictedBrowse), never a second copy specialized to "browse
// scoped to one studio".

import type { Kysely } from 'kysely';
import type { ContentClass, DB } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuardToJoined, applyGuardToTags } from './guard.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { resolveEntitledRestrictedLibraryIds } from './restricted-zone.js';
import type { ImageDescriptor } from './catalog-detail.js';

export interface RestrictedStudioRow {
  id: string;
  name: string;
  contentClass: ContentClass;
  /** Count of DISTINCT zone items visible to ctx carrying this studio
   *  (item_tags.kind='studio'), scoped to the viewer's entitled restricted
   *  libraries. */
  sceneCount: number;
  images: ImageDescriptor[];
}

export interface ListRestrictedStudiosParams {
  cursor?: string;
  limit?: number;
  q?: string;
}

export interface ListRestrictedStudiosResult {
  rows: RestrictedStudioRow[];
  nextCursor: string | null;
}

interface StudioCursorPayload {
  name: string;
  id: string;
}

function isStudioCursorPayload(value: unknown): value is StudioCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

function likeContainsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const DEFAULT_LIMIT = 50;

async function fetchStudioImagesBatch(db: Kysely<DB>, ids: string[]): Promise<Map<string, ImageDescriptor[]>> {
  const map = new Map<string, ImageDescriptor[]>();
  if (ids.length === 0) return map;

  const rows = await db
    .selectFrom('images')
    .select(['entity_id', 'kind', 'width', 'height', 'blurhash', 'dominant_color'])
    .where('entity_type', '=', 'tag')
    .where('entity_id', 'in', ids)
    .execute();

  for (const row of rows) {
    const arr = map.get(row.entity_id) ?? [];
    arr.push({
      kind: row.kind,
      width: row.width,
      height: row.height,
      blurhash: row.blurhash,
      dominantColor: row.dominant_color ? row.dominant_color : null,
    });
    map.set(row.entity_id, arr);
  }
  return map;
}

export async function listRestrictedStudios(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListRestrictedStudiosParams = {}
): Promise<ListRestrictedStudiosResult | undefined> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);
  if (restrictedLibraryIds.length === 0) {
    return undefined;
  }

  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = applyGuardToTags(db.selectFrom('tags'), ctx)
    .where('tags.kind', '=', 'studio')
    .innerJoin('item_tags', 'item_tags.tag_id', 'tags.id')
    .innerJoin('catalog_items', 'catalog_items.id', 'item_tags.item_id')
    .where('item_tags.kind', '=', 'studio')
    .where('catalog_items.item_type', '=', 'movie')
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where(applyGuardToJoined(ctx, 'item_tags.item_id'));

  if (params.q) {
    query = query.where('tags.name', 'ilike', likeContainsPattern(params.q));
  }

  if (params.cursor) {
    const { name, id } = decodeCursor(params.cursor, isStudioCursorPayload);
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
      eb.fn.count<string>('item_tags.item_id').distinct().as('sceneCount'),
    ])
    .orderBy('tags.name', 'asc')
    .orderBy('tags.id', 'asc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ name: last.name, id: last.id }) : null;

  const ids = rows.map((r) => r.id);
  const imagesMap = await fetchStudioImagesBatch(db, ids);

  return {
    rows: rows.map((r) => ({ ...r, sceneCount: Number(r.sceneCount), images: imagesMap.get(r.id) ?? [] })),
    nextCursor,
  };
}

export async function getRestrictedStudioById(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string
): Promise<RestrictedStudioRow | undefined> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);
  if (restrictedLibraryIds.length === 0) {
    return undefined;
  }

  const row = await applyGuardToTags(db.selectFrom('tags'), ctx)
    .where('tags.id', '=', id)
    .where('tags.kind', '=', 'studio')
    .innerJoin('item_tags', 'item_tags.tag_id', 'tags.id')
    .innerJoin('catalog_items', 'catalog_items.id', 'item_tags.item_id')
    .where('item_tags.kind', '=', 'studio')
    .where('catalog_items.item_type', '=', 'movie')
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where(applyGuardToJoined(ctx, 'item_tags.item_id'))
    .groupBy(['tags.id', 'tags.name', 'tags.content_class'])
    .select((eb) => [
      'tags.id as id',
      'tags.name as name',
      'tags.content_class as contentClass',
      eb.fn.count<string>('item_tags.item_id').distinct().as('sceneCount'),
    ])
    .executeTakeFirst();

  if (!row) return undefined;
  const imagesMap = await fetchStudioImagesBatch(db, [row.id]);
  return { ...row, sceneCount: Number(row.sceneCount), images: imagesMap.get(row.id) ?? [] };
}
