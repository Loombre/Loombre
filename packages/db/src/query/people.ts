// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/people.ts
//
// listPeople / getPersonById — first-class leak surface per docs/PLAN.md
// §6.4 / STATE.md P1.17. A person row is visible to `ctx` iff BOTH:
//   1. content_class is 'general', or ctx.restrictedCleared (gate on the
//      person row itself — metadata isolation) — applyGuardToPeople.
//   2. the person is credited on >=1 catalog item visible to ctx — NOT
//      merely "exists somewhere in the DB" — applyGuardToJoined against
//      item_people.item_id.
// Neither clause alone is sufficient; see seed.mjs's restrictedCameoPerformer
// (general item, restricted-class person: clause 1 fails) and
// marginalGeneralActor (general-class person, credited only on a restricted
// item: clause 2 fails) fixtures, and packages/db/test/leak.spec.ts for both
// directions proven against them.
//
// Credit counts are computed as DISTINCT item ids over the SAME guarded
// join used for visibility — never a raw item_people row count (a person
// can hold more than one credit on the same item) and never inflated by
// credits on items ctx cannot see.

import type { Kysely } from 'kysely';
import type { ContentClass, DB, ItemType } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuardToJoined, applyGuardToPeople } from './guard.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';

export interface PersonRow {
  id: string;
  name: string;
  contentClass: ContentClass;
  /** Count of DISTINCT items visible to ctx this person is credited on. */
  creditCount: number;
}

export interface ListPeopleParams {
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Page size. Defaults to 50. */
  limit?: number;
  /** Case-insensitive substring match on name. */
  q?: string;
}

export interface ListPeopleResult {
  rows: PersonRow[];
  nextCursor: string | null;
}

interface PeopleCursorPayload {
  name: string;
  id: string;
}

function isPeopleCursorPayload(value: unknown): value is PeopleCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    isCursorRowId((value as Record<string, unknown>).id)
  );
}

const DEFAULT_LIMIT = 50;

/** Escapes `%`/`_`/`\` so a raw `q` can never widen an ILIKE pattern beyond
 *  a literal substring match — the adversarial "LIKE injection" concern
 *  (packages/db/test/leak.spec.ts). Postgres's default LIKE escape
 *  character is `\`, so no explicit ESCAPE clause is required. */
function likeContainsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listPeople(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListPeopleParams = {}
): Promise<ListPeopleResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = applyGuardToPeople(db.selectFrom('people'), ctx)
    .innerJoin('item_people', 'item_people.person_id', 'people.id')
    .where(applyGuardToJoined(ctx, 'item_people.item_id'));

  if (params.q) {
    query = query.where('people.name', 'ilike', likeContainsPattern(params.q));
  }

  if (params.cursor) {
    const { name, id } = decodeCursor(params.cursor, isPeopleCursorPayload);
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
      eb.fn.count<string>('item_people.item_id').distinct().as('creditCount'),
    ])
    .orderBy('people.name', 'asc')
    .orderBy('people.id', 'asc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ name: last.name, id: last.id }) : null;

  return {
    rows: rows.map((r) => ({ ...r, creditCount: Number(r.creditCount) })),
    nextCursor,
  };
}

export async function getPersonById(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string
): Promise<PersonRow | undefined> {
  const row = await applyGuardToPeople(db.selectFrom('people'), ctx)
    .innerJoin('item_people', 'item_people.person_id', 'people.id')
    .where('people.id', '=', id)
    .where(applyGuardToJoined(ctx, 'item_people.item_id'))
    .groupBy(['people.id', 'people.name', 'people.content_class'])
    .select((eb) => [
      'people.id as id',
      'people.name as name',
      'people.content_class as contentClass',
      eb.fn.count<string>('item_people.item_id').distinct().as('creditCount'),
    ])
    .executeTakeFirst();

  return row ? { ...row, creditCount: Number(row.creditCount) } : undefined;
}

// ============================================================================
// Filmography (Phosphor Wave 2 lane L3, /people/[id] route) — ground-truthed
// gap: getPersonById above returns only creditCount (a number), never the
// actual credited items a Person page's filmography grid needs to render
// posters. This is the missing query the gap requires, built from the SAME
// two-clause guard listPeople/getPersonById already enforce (person
// content_class isolation via applyGuardToPeople, AND "credited on a
// currently-visible item" via applyGuardToJoined against
// item_people.item_id) — a person's restricted-only credits can never leak
// through this surface any more than through listPeople/getPersonById
// themselves. See packages/db/test/leak.spec.ts for the dedicated case
// proving a restricted item never appears in a cleared-for-the-PERSON-but-
// not-the-ITEM viewer's filmography (the general/marginalGeneralActor
// asymmetry this file's header already documents, replayed one level down
// at the item-list surface instead of the count surface).
// ============================================================================

export interface PersonItemRow {
  itemId: string;
  itemType: ItemType;
  addedAtMs: number;
}

export interface ListItemsForPersonParams {
  cursor?: string;
  limit?: number;
}

export interface ListItemsForPersonResult {
  rows: PersonItemRow[];
  nextCursor: string | null;
}

interface PersonItemsCursorPayload {
  addedAtMs: number;
  itemId: string;
}

function isPersonItemsCursorPayload(value: unknown): value is PersonItemsCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).addedAtMs === 'number' &&
    isCursorRowId((value as Record<string, unknown>).itemId)
  );
}

const ITEMS_DEFAULT_LIMIT = 50;

/**
 * Items `personId` is credited on that are ALSO currently visible to `ctx`
 * — newest catalog-added-first, keyset-paginated on (added_at_ms, item_id)
 * both descending. `DISTINCT` on the selected columns: item_people has no
 * uniqueness constraint on (item_id, person_id) — the same person can carry
 * more than one credit on the same item (e.g. actor AND writer), which must
 * still surface exactly once in a filmography, mirroring listPeople/
 * getPersonById's own `DISTINCT` credit-count semantics one level down.
 *
 * A person that does not exist, or is not itself visible to ctx (restricted-
 * class person, uncleared viewer), yields an empty page rather than an
 * error — the caller (apps/server) additionally calls getPersonById first
 * to distinguish "person not found" (404) from "person visible, zero
 * visible credits" (200 with an empty page); this function does not need to
 * make that distinction itself, only to never leak a row either way.
 */
export async function listItemsForPerson(
  db: Kysely<DB>,
  ctx: ViewerContext,
  personId: string,
  params: ListItemsForPersonParams = {}
): Promise<ListItemsForPersonResult> {
  const limit = params.limit ?? ITEMS_DEFAULT_LIMIT;

  let query = applyGuardToPeople(db.selectFrom('people'), ctx)
    .where('people.id', '=', personId)
    .innerJoin('item_people', 'item_people.person_id', 'people.id')
    .innerJoin('catalog_items', 'catalog_items.id', 'item_people.item_id')
    .where(applyGuardToJoined(ctx, 'item_people.item_id'));

  if (params.cursor) {
    const { addedAtMs, itemId } = decodeCursor(params.cursor, isPersonItemsCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('catalog_items.added_at_ms', '<', addedAtMs),
        eb.and([
          eb('catalog_items.added_at_ms', '=', addedAtMs),
          eb('catalog_items.id', '<', itemId),
        ]),
      ])
    );
  }

  const rows = await query
    .select([
      'catalog_items.id as itemId',
      'catalog_items.item_type as itemType',
      'catalog_items.added_at_ms as addedAtMs',
    ])
    .distinct()
    .orderBy('catalog_items.added_at_ms', 'desc')
    .orderBy('catalog_items.id', 'desc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor({ addedAtMs: last.addedAtMs, itemId: last.itemId })
      : null;

  return { rows, nextCursor };
}
