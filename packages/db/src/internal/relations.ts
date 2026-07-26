// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/relations.ts
//
// Writers for provider_ids / people+item_people / tags+item_tags
// (docs/PLAN.md §5, §6.3, §6.4). Added alongside the metadata-provider
// consumer (P1.6/P1.7): src/internal/catalog.ts covers catalog_items + its
// 7 satellites, but the scanner/import path also needs to attach
// provider ids, cast/crew, and genres/tags to an item — this file is that
// missing writer surface, following the exact conventions of the sibling
// files in this directory (DbOrTx-accepting, Selectable row types,
// delete+insert "replace wholesale" for one-to-many relations, matching
// files.ts's replaceFileStreams).
//
// content_class isolation (§6.4): people/tags rows carry their own
// content_class (0001_init.sql) so a person/tag credited only on
// restricted items never surfaces in general people/tag search — callers
// pass the OWNING ITEM's content_class through findOrCreatePerson/
// findOrCreateTag; this module does not infer it.

import type { Selectable } from 'kysely';
import type { ContentClass, ItemPeopleTable, ItemTagKind, ItemTagsTable, PeopleTable, PersonRole, ProviderIdsTable, TagsTable } from '../types.js';
import type { DbOrTx } from './tx.js';
import { withTransaction } from './tx.js';

// ============================================================================
// provider_ids
// ============================================================================

export type ProviderIdRow = Selectable<ProviderIdsTable>;

export interface UpsertProviderIdInput {
  itemId: string;
  provider: string;
  externalId: string;
}

export async function upsertProviderId(db: DbOrTx, input: UpsertProviderIdInput): Promise<ProviderIdRow> {
  return db
    .insertInto('provider_ids')
    .values({ item_id: input.itemId, provider: input.provider, external_id: input.externalId })
    .onConflict((oc) => oc.columns(['item_id', 'provider']).doUpdateSet({ external_id: (eb) => eb.ref('excluded.external_id') }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getProviderIdsForItem(db: DbOrTx, itemId: string): Promise<ProviderIdRow[]> {
  return db.selectFrom('provider_ids').selectAll().where('item_id', '=', itemId).execute();
}

// ============================================================================
// people / item_people
// ============================================================================

export type PersonRow = Selectable<PeopleTable>;
export type ItemPersonRow = Selectable<ItemPeopleTable>;

/**
 * people(name) has no unique constraint (0001_init.sql — CITEXT name only,
 * indexed but not uniqued), so this is a find-then-insert rather than an
 * ON CONFLICT upsert. Matches this item's content_class to the caller-
 * supplied `contentClass` so a general and a restricted person sharing a
 * name never collapse into one row (§6.4 metadata isolation).
 */
export async function findOrCreatePerson(db: DbOrTx, name: string, contentClass: ContentClass): Promise<PersonRow> {
  const existing = await db
    .selectFrom('people')
    .selectAll()
    .where('name', '=', name)
    .where('content_class', '=', contentClass)
    .executeTakeFirst();
  if (existing) return existing;

  return db.insertInto('people').values({ name, content_class: contentClass }).returningAll().executeTakeFirstOrThrow();
}

export interface ItemPersonInput {
  personId: string;
  role: PersonRole;
  credit?: string | null;
  order?: number;
}

/**
 * Atomically replaces every item_people row for `itemId` with `people`
 * (delete-then-insert in one transaction, mirroring files.ts's
 * replaceFileStreams) — a metadata refresh always supersedes the prior
 * cast/crew list wholesale rather than diffing individual credits.
 */
export async function replaceItemPeople(db: DbOrTx, itemId: string, people: ItemPersonInput[]): Promise<ItemPersonRow[]> {
  return withTransaction(db, async (trx) => {
    await trx.deleteFrom('item_people').where('item_id', '=', itemId).execute();
    if (people.length === 0) return [];

    return trx
      .insertInto('item_people')
      .values(
        people.map((p) => ({
          item_id: itemId,
          person_id: p.personId,
          role: p.role,
          credit: p.credit ?? null,
          ...(p.order !== undefined ? { ord: p.order } : {}),
        }))
      )
      .returningAll()
      .execute();
  });
}

// ============================================================================
// tags / item_tags
// ============================================================================

export type TagRow = Selectable<TagsTable>;
export type ItemTagRow = Selectable<ItemTagsTable>;

/** tags(name, content_class) IS uniqued (0001_init.sql), so this upserts
 *  rather than find-then-insert. */
export async function findOrCreateTag(db: DbOrTx, name: string, contentClass: ContentClass): Promise<TagRow> {
  return db
    .insertInto('tags')
    .values({ name, content_class: contentClass })
    .onConflict((oc) => oc.columns(['name', 'content_class']).doUpdateSet({ name: (eb) => eb.ref('excluded.name') }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface ItemTagInput {
  tagId: string;
  kind: ItemTagKind;
}

/** Atomically replaces every item_tags row for `itemId` (delete+insert),
 *  same rationale as replaceItemPeople above. */
export async function replaceItemTags(db: DbOrTx, itemId: string, tags: ItemTagInput[]): Promise<ItemTagRow[]> {
  return withTransaction(db, async (trx) => {
    await trx.deleteFrom('item_tags').where('item_id', '=', itemId).execute();
    if (tags.length === 0) return [];

    return trx
      .insertInto('item_tags')
      .values(tags.map((t) => ({ item_id: itemId, tag_id: t.tagId, kind: t.kind })))
      .returningAll()
      .execute();
  });
}
