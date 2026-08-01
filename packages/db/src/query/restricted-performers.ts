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
//
// QUERY SHAPE (STATE.md S10, 0021 migration, finding 6): the original
// implementation joined people -> item_people -> catalog_items, GROUP BY
// person, ORDER BY name LIMIT — a GroupAggregate that visits every
// role='performer' credit row (65,916 at the 33k-scene fixture) before the
// name-ordered LIMIT ever discards anything, EXPLAIN-measured at 209ms
// (T0 budget: 100ms). Reshaped to the cheaper of 0021's two evidenced
// options: keyset-page `people` DIRECTLY on (name, id) with an EXISTS
// check for "has >=1 qualifying credit" (index-backed, early-exits — never
// visits more than a handful of credit rows per candidate), THEN batch-
// count scenes for ONLY the <=limit people the page actually returns
// (fetchPerformerSceneCountsBatch below) — the same "batch the expensive
// part over the already-page-bounded id list" shape catalog-detail.ts's
// fetchPeopleBatch/fetchMediaFilesBatch use. Collapses the GroupAggregate's
// 65,916-row visit to <=limit batched lookups; EXPLAIN-verified 209ms ->
// low single-digit ms at the 33k fixture (0021's migration comment carries
// the exact before/after numbers). getRestrictedPerformerById shares the
// same EXISTS + batch-count shape for a single id, for the same reason.

import { sql, type Kysely } from 'kysely';
import type { ContentClass, DB } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuardToJoined, applyGuardToPeople } from './guard.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';
import { resolveEntitledRestrictedLibraryIds } from './restricted-zone.js';
import { listRestrictedBrowse, type ListRestrictedBrowseResult } from './restricted-browse.js';
import type { ImageDescriptor } from './catalog-detail.js';

export interface RestrictedPerformerRow {
  id: string;
  name: string;
  contentClass: ContentClass;
  /** Count of DISTINCT zone items visible to ctx this performer is
   *  credited on (role='performer'), scoped to the viewer's entitled
   *  restricted libraries — never a raw credit-row count. */
  sceneCount: number;
  /** FX2 fix wave: the performer's portrait (images entity_type='person',
   *  kind='thumb', ingested by Lane B) — mirrors RestrictedStudioRow's own
   *  `images` field exactly (fetchStudioImagesBatch's shape, entity_type
   *  swapped). A person with no image fixture gets an honest empty array,
   *  never a leak of some OTHER performer's portrait. */
  images: ImageDescriptor[];
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

/** `id` must be a real uuid, not merely a string (R1 review lane,
 *  leak.spec 12h): this payload's id is bound straight into a
 *  `people.id > ?` keyset comparison, so a forged non-uuid cursor
 *  otherwise reaches Postgres and raises 22P02 — a 500 for what is
 *  client input. isCursorRowId is the codec's own shared check
 *  (src/query/cursor.ts), the same one restricted-browse.ts's
 *  isBrowseCursorPayload already applied. */
function isPerformerCursorPayload(value: unknown): value is PerformerCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    isCursorRowId((value as Record<string, unknown>).id)
  );
}

/** Escapes `%`/`_`/`\` — see people.ts's identical helper for the
 *  adversarial "LIKE injection" rationale (packages/db/test/leak.spec.ts). */
function likeContainsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const DEFAULT_LIMIT = 50;

/** The "has >=1 qualifying credit" predicate shared by the EXISTS check
 *  (list/get) and the batched scene-count query below — one implementation
 *  so the two can never drift into inconsistent visibility (a person the
 *  EXISTS check admits must always find itself in the count batch, and
 *  vice versa). Callers add their own `item_people.person_id` predicate on
 *  top (a correlated `sql.ref` equality for the EXISTS check, a bound `IN`
 *  list for the batch query — see guard.ts's applyGuardToJoined header for
 *  why a raw `sql.ref` is the house pattern for referencing a column on a
 *  table outside this query's own FROM/JOIN list, e.g. the outer `people`
 *  alias a correlated EXISTS subquery reaches into). */
function qualifyingCreditQuery(
  db: Kysely<DB>,
  ctx: ViewerContext,
  restrictedLibraryIds: string[]
) {
  return db
    .selectFrom('item_people')
    .innerJoin('catalog_items', 'catalog_items.id', 'item_people.item_id')
    .where('item_people.role', '=', 'performer')
    .where('catalog_items.item_type', '=', 'movie')
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where(applyGuardToJoined(ctx, 'item_people.item_id'));
}

/** Correlated `item_people.person_id = people.id` for the EXISTS checks
 *  below — see qualifyingCreditQuery's doc comment. */
function correlatedToOuterPerson() {
  return sql<boolean>`${sql.ref('item_people.person_id')} = ${sql.ref('people.id')}`;
}

/** Batch scene-count for a page's worth of already-resolved person ids
 *  (0021 finding 6: never a GroupAggregate over every credit row — only
 *  ever called with a page-bounded id list, same "batch the expensive part
 *  over an already-limited id set" shape as catalog-detail.ts's
 *  fetchPeopleBatch). */
async function fetchPerformerSceneCountsBatch(
  db: Kysely<DB>,
  ctx: ViewerContext,
  restrictedLibraryIds: string[],
  personIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (personIds.length === 0) return map;

  const rows = await qualifyingCreditQuery(db, ctx, restrictedLibraryIds)
    .where('item_people.person_id', 'in', personIds)
    .groupBy('item_people.person_id')
    .select((eb) => [
      'item_people.person_id as personId',
      eb.fn.count<string>('item_people.item_id').distinct().as('sceneCount'),
    ])
    .execute();

  for (const r of rows) {
    map.set(r.personId, Number(r.sceneCount));
  }
  return map;
}

/** FX2 fix wave: batch-fetch performer portraits for a page's worth of
 *  already-resolved person ids — same "batch over an already-limited id
 *  set" shape as fetchPerformerSceneCountsBatch above, and BYTE-IDENTICAL
 *  to restricted-studios.ts's fetchStudioImagesBatch except entity_type
 *  ('person' vs 'tag') — no guard/visibility logic of its own, because the
 *  ids handed in already passed applyGuardToPeople + the qualifying-credit
 *  EXISTS check (an uncleared/nonexistent/wrong-role person id can never
 *  reach this function to begin with — see this file's header). */
async function fetchPerformerImagesBatch(db: Kysely<DB>, ids: string[]): Promise<Map<string, ImageDescriptor[]>> {
  const map = new Map<string, ImageDescriptor[]>();
  if (ids.length === 0) return map;

  const rows = await db
    .selectFrom('images')
    .select(['entity_id', 'kind', 'width', 'height', 'blurhash', 'dominant_color'])
    .where('entity_type', '=', 'person')
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

  let query = applyGuardToPeople(db.selectFrom('people'), ctx).where((eb) =>
    eb.exists(
      qualifyingCreditQuery(db, ctx, restrictedLibraryIds)
        .where(correlatedToOuterPerson())
        .select('item_people.id')
    )
  );

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

  const idRows = await query
    .select(['people.id as id', 'people.name as name', 'people.content_class as contentClass'])
    .orderBy('people.name', 'asc')
    .orderBy('people.id', 'asc')
    .limit(limit)
    .execute();

  const last = idRows[idRows.length - 1];
  const nextCursor =
    idRows.length === limit && last ? encodeCursor({ name: last.name, id: last.id }) : null;

  const ids = idRows.map((r) => r.id);
  const [sceneCounts, imagesMap] = await Promise.all([
    fetchPerformerSceneCountsBatch(db, ctx, restrictedLibraryIds, ids),
    fetchPerformerImagesBatch(db, ids),
  ]);

  return {
    // sceneCounts.get(r.id) is never undefined in practice — the EXISTS
    // check above and qualifyingCreditQuery share the exact same predicate,
    // so every id in idRows has >=1 matching row in the batch. The ?? 0
    // fallback is defense-in-depth, not an expected path.
    rows: idRows.map((r) => ({ ...r, sceneCount: sceneCounts.get(r.id) ?? 0, images: imagesMap.get(r.id) ?? [] })),
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

  const person = await applyGuardToPeople(db.selectFrom('people'), ctx)
    .where('people.id', '=', id)
    .where((eb) =>
      eb.exists(
        qualifyingCreditQuery(db, ctx, restrictedLibraryIds)
          .where(correlatedToOuterPerson())
          .select('item_people.id')
      )
    )
    .select(['people.id as id', 'people.name as name', 'people.content_class as contentClass'])
    .executeTakeFirst();
  if (!person) return undefined;

  const [sceneCounts, imagesMap] = await Promise.all([
    fetchPerformerSceneCountsBatch(db, ctx, restrictedLibraryIds, [person.id]),
    fetchPerformerImagesBatch(db, [person.id]),
  ]);
  return { ...person, sceneCount: sceneCounts.get(person.id) ?? 0, images: imagesMap.get(person.id) ?? [] };
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
