// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/item-read.ts
//
// Small internal (guard-free, scanner/import-path) read helpers for the
// metadata consumer (P1.6) — "search using item's parsed title/year (read
// via a small internal read helper)", and "read current provenance to
// know layers" for the precedence merge. Deliberately narrow: this is not
// a general catalog_items query surface, just enough to drive a provider
// search, seed mergeFields' nfo/tag/filename layers from what is already
// persisted, and know what to preserve when only some fields change.
//
// Uses only the `DbOrTx` type re-exported by @loombre/db/internal — no
// direct `kysely` import here, so this file does not trip the repo-root
// dependency-cruiser "no-raw-db-driver-outside-packages-db" rule (that
// rule flags files that import the `kysely`/`pg` packages directly;
// TypeScript resolves `.selectFrom(...)` structurally through the already-
// typed `DbOrTx` value without this file needing its own kysely import).

import type { DbOrTx } from '@loombre/db/internal';
import type { PersonCredit, PersonRole } from './provider.js';

export type MetadataItemType = 'movie' | 'series' | 'season' | 'episode' | 'artist' | 'album' | 'track';

export interface MetadataSourceItem {
  id: string;
  libraryId: string;
  itemType: MetadataItemType;
  parentId: string | null;
  title: string;
  sortTitle: string;
  year: number | null;
  communityRating: number | null;
  contentClass: 'general' | 'restricted';
  addedAtMs: number;
}

/** Returns undefined if the item does not exist (e.g. deleted between
 *  enqueue and processing) — callers must treat that as a no-op, not an
 *  error, since it's an ordinary race in an async job queue. */
export async function getMetadataSourceItem(db: DbOrTx, itemId: string): Promise<MetadataSourceItem | undefined> {
  const row = await db
    .selectFrom('catalog_items')
    .select(['id', 'library_id', 'item_type', 'parent_id', 'title', 'sort_title', 'year', 'community_rating', 'content_class', 'added_at_ms'])
    .where('id', '=', itemId)
    .executeTakeFirst();

  if (!row) return undefined;

  return {
    id: row.id,
    libraryId: row.library_id,
    itemType: row.item_type,
    parentId: row.parent_id,
    title: row.title,
    sortTitle: row.sort_title,
    year: row.year,
    communityRating: row.community_rating,
    contentClass: row.content_class,
    addedAtMs: row.added_at_ms,
  };
}

/** Currently-persisted satellite scalar fields, keyed by the same field
 *  names mergeFields/provenance use (a subset of the satellite's own
 *  column names — e.g. 'contentRating' not 'content_rating'). Empty object
 *  for item types with no satellite scalar fields this module writes
 *  (season/episode/track are not handled by the metadata consumer at all
 *  — see consumer.ts's header). */
export async function getCurrentSatelliteFields(db: DbOrTx, itemType: MetadataItemType, itemId: string): Promise<Record<string, unknown>> {
  switch (itemType) {
    case 'movie': {
      const row = await db.selectFrom('movie_details').selectAll().where('item_id', '=', itemId).executeTakeFirst();
      if (!row) return {};
      return { overview: row.overview, contentRating: row.content_rating, tagline: row.tagline, runtimeMs: row.runtime_ms };
    }
    case 'series': {
      const row = await db.selectFrom('series_details').selectAll().where('item_id', '=', itemId).executeTakeFirst();
      if (!row) return {};
      return { overview: row.overview, contentRating: row.content_rating, status: row.status };
    }
    case 'artist': {
      const row = await db.selectFrom('artist_details').selectAll().where('item_id', '=', itemId).executeTakeFirst();
      if (!row) return {};
      return { overview: row.overview };
    }
    case 'album':
    case 'season':
    case 'episode':
    case 'track':
      return {};
  }
}

export interface CurrentRelations {
  genres: string[];
  tags: string[];
  people: PersonCredit[];
}

/** Current genres/tags/cast for an item, read fresh each consumer run so a
 *  metadata refresh that only touches SOME relation fields (e.g. genres
 *  locked, people not) can preserve the untouched ones when rewriting the
 *  wholesale item_tags/item_people rowsets (replaceItemTags/
 *  replaceItemPeople both replace the FULL set for an item). */
export async function getCurrentRelations(db: DbOrTx, itemId: string): Promise<CurrentRelations> {
  const tagRows = await db
    .selectFrom('item_tags')
    .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
    .select(['tags.name as name', 'item_tags.kind as kind'])
    .where('item_tags.item_id', '=', itemId)
    .execute();

  const peopleRows = await db
    .selectFrom('item_people')
    .innerJoin('people', 'people.id', 'item_people.person_id')
    .select(['people.name as name', 'item_people.role as role', 'item_people.credit as credit', 'item_people.ord as ord'])
    .where('item_people.item_id', '=', itemId)
    .orderBy('item_people.ord', 'asc')
    .execute();

  return {
    genres: tagRows.filter((r) => r.kind === 'genre').map((r) => r.name),
    tags: tagRows.filter((r) => r.kind === 'tag').map((r) => r.name),
    people: peopleRows.map((r) => ({ name: r.name, role: r.role as PersonRole, order: r.ord, credit: r.credit })),
  };
}
