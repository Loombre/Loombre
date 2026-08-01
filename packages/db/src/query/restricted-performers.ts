// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/restricted-performers.ts
//
// STATE.md Stash run (S9): the zone's own performer surface —
// role='performer' people credited on >=1 item in a viewer's ENTITLED
// restricted libraries (src/query/restricted-zone.ts's
// resolveEntitledRestrictedLibraryIds — the SAME entitlement resolver
// every zone query module shares). Mirrors src/query/people.ts's
// visibility model exactly (content_class isolation on the person row AND
// "credited on >=1 item visible to ctx" via applyGuardToJoined — neither
// clause alone is sufficient, see that file's header) with two additions:
// a `role = 'performer'` filter (the zone's performer rail/list is not
// "every credited person", unlike the general /people surface) and the
// `restrictedLibraryIds` scoping so a performer who happens to hold a
// (hypothetical, non-existent-today) credit on some OTHER restricted
// library the viewer is not entitled to never leaks a scene count that
// includes it.
//
// Entitlement gate (identical two-step every zone query module uses):
// zero entitlement -> `undefined` (caller: 404). Entitled -> a real query
// through applyGuardToPeople/applyGuardToJoined, which additionally
// requires ctx.restrictedCleared for a restricted-class person or a
// restricted item's credit to survive — entitled-but-locked yields a real,
// empty page, never a 404 (matches every other zone list surface's U10
// posture).

import type { Kysely } from 'kysely';
import type { ContentClass, DB } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuardToJoined, applyGuardToPeople } from './guard.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { resolveEntitledRestrictedLibraryIds } from './restricted-zone.js';
import { listRestrictedBrowse, type ListRestrictedBrowseResult } from './restricted-browse.js';

export interface RestrictedPerformerRow {
  id: string;
  name: string;
  contentClass: ContentClass;
  /** Count of DISTINCT zone items visible to ctx this performer is
   *  credited on (role='performer'), scoped to the viewer's entitled
   *  restricted libraries — never a raw credit-row count. */
  sceneCount: number;
}

export interface ListRestrictedPerformersParams {
  cursor?: string;
  limit?: number;
  /** Case-insensitive substring match on name. */
  q?: string;
}

export interface ListRestrictedPerformersResult {
  rows: RestrictedPerformerRow[];
  nextCursor: string | null;
}

interface PerformerCursorPayload {
  name: string;
  id: string;
}

function isPerformerCursorPayload(value: unknown): value is PerformerCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

/** Escapes `%`/`_`/`\` — see people.ts's identical helper for the
 *  adversarial "LIKE injection" rationale (packages/db/test/leak.spec.ts). */
function likeContainsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const DEFAULT_LIMIT = 50;

export async function listRestrictedPerformers(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListRestrictedPerformersParams = {}
): Promise<ListRestrictedPerformersResult | undefined> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);
  if (restrictedLibraryIds.length === 0) {
    return undefined;
  }

  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = applyGuardToPeople(db.selectFrom('people'), ctx)
    .innerJoin('item_people', 'item_people.person_id', 'people.id')
    .innerJoin('catalog_items', 'catalog_items.id', 'item_people.item_id')
    .where('item_people.role', '=', 'performer')
    .where('catalog_items.item_type', '=', 'movie')
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where(applyGuardToJoined(ctx, 'item_people.item_id'));

  if (params.q) {
    query = query.where('people.name', 'ilike', likeContainsPattern(params.q));
  }

  if (params.cursor) {
    const { name, id } = decodeCursor(params.cursor, isPerformerCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('people.name', '>', name),
        eb.and([eb('people.name', '=', name), eb('people.id', '>', id)]),
      ])
    );
  }

  const rows = await query
    .groupBy(['people.id', 'people.name', 'people.content_class'])
    .select((eb) => [
      'people.id as id',
      'people.name as name',
      'people.content_class as contentClass',
      eb.fn.count<string>('item_people.item_id').distinct().as('sceneCount'),
    ])
    .orderBy('people.name', 'asc')
    .orderBy('people.id', 'asc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ name: last.name, id: last.id }) : null;

  return {
    rows: rows.map((r) => ({ ...r, sceneCount: Number(r.sceneCount) })),
    nextCursor,
  };
}

/**
 * A single performer by id. Zero entitlement, or an id that does not
 * resolve to a role='performer' credit inside the viewer's entitled
 * restricted libraries (wrong person, wrong role, or restricted-and-not-
 * cleared), are INDISTINGUISHABLE — both `undefined` — matching
 * getPersonById/getItemById's existing "hidden == nonexistent" contract.
 */
export async function getRestrictedPerformerById(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string
): Promise<RestrictedPerformerRow | undefined> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);
  if (restrictedLibraryIds.length === 0) {
    return undefined;
  }

  const row = await applyGuardToPeople(db.selectFrom('people'), ctx)
    .innerJoin('item_people', 'item_people.person_id', 'people.id')
    .innerJoin('catalog_items', 'catalog_items.id', 'item_people.item_id')
    .where('people.id', '=', id)
    .where('item_people.role', '=', 'performer')
    .where('catalog_items.item_type', '=', 'movie')
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where(applyGuardToJoined(ctx, 'item_people.item_id'))
    .groupBy(['people.id', 'people.name', 'people.content_class'])
    .select((eb) => [
      'people.id as id',
      'people.name as name',
      'people.content_class as contentClass',
      eb.fn.count<string>('item_people.item_id').distinct().as('sceneCount'),
    ])
    .executeTakeFirst();

  return row ? { ...row, sceneCount: Number(row.sceneCount) } : undefined;
}

/**
 * A performer's filmography inside the zone — pure delegation to
 * listRestrictedBrowse with `performerIds: [personId]` (S9: "+/{id}/scenes
 * keyset"). Safe by construction: listRestrictedBrowse re-derives
 * entitlement and re-applies the full guard itself, so a personId that
 * does not resolve to any guard-visible credit simply yields an empty
 * page — never a leak, and never a second, divergent implementation of
 * the zone's guard/keyset logic.
 */
export async function listRestrictedPerformerScenes(
  db: Kysely<DB>,
  ctx: ViewerContext,
  personId: string,
  params: { cursor?: string; limit?: number } = {}
): Promise<ListRestrictedBrowseResult | undefined> {
  return listRestrictedBrowse(db, ctx, { ...params, performerIds: [personId] });
}
