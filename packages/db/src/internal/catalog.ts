// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/catalog.ts
//
// Writers for catalog_items and its 7 satellite detail tables. These are
// the core scanner/import writes (docs/PLAN.md §8.1, D9 thin-polymorphic
// catalog). Guard-free by design: writes are not viewer-scoped (there is no
// "viewer" performing a scan), and reads here (e.g. upsert's RETURNING) are
// scanner-internal, not a catalog browse surface — see src/internal/index.ts
// header and CLAUDE.md invariant 4's carve-out for this module.

import { sql, type Selectable } from 'kysely';
import type {
  CatalogItemsTable,
  ItemType,
  ContentClass,
  MovieDetailsTable,
  SeriesDetailsTable,
  SeasonDetailsTable,
  EpisodeDetailsTable,
  ArtistDetailsTable,
  AlbumDetailsTable,
  TrackDetailsTable,
} from '../types.js';
import type { DbOrTx } from './tx.js';

export type CatalogItemRow = Selectable<CatalogItemsTable>;

export interface UpsertCatalogItemInput {
  /** Omit to always INSERT a new row; supply to UPDATE the row with this id
   *  (upsert-by-id via ON CONFLICT). */
  id?: string;
  libraryId: string;
  itemType: ItemType;
  parentId?: string | null;
  title: string;
  sortTitle: string;
  year?: number | null;
  communityRating?: number | null;
  /** Advisory only — the catalog_items_enforce_content_class trigger always
   *  overwrites this with the owning library's content_class, so it is safe
   *  to omit. */
  contentClass?: ContentClass;
  addedAtMs: number;
  updatedAtMs: number;
}

/**
 * Insert-or-update a catalog_items row. Identity is the caller-supplied
 * `id` (typically resolved beforehand via a media_files match, a
 * provider_ids match, or a fresh id for a brand-new item) — catalog_items
 * itself has no natural business key, so this module does not guess one.
 */
export async function upsertCatalogItem(
  db: DbOrTx,
  input: UpsertCatalogItemInput
): Promise<CatalogItemRow> {
  const values = {
    ...(input.id ? { id: input.id } : {}),
    library_id: input.libraryId,
    item_type: input.itemType,
    parent_id: input.parentId ?? null,
    title: input.title,
    sort_title: input.sortTitle,
    year: input.year ?? null,
    community_rating: input.communityRating ?? null,
    ...(input.contentClass ? { content_class: input.contentClass } : {}),
    added_at_ms: input.addedAtMs,
    updated_at_ms: input.updatedAtMs,
  };

  return db
    .insertInto('catalog_items')
    .values(values)
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        library_id: (eb) => eb.ref('excluded.library_id'),
        parent_id: (eb) => eb.ref('excluded.parent_id'),
        title: (eb) => eb.ref('excluded.title'),
        sort_title: (eb) => eb.ref('excluded.sort_title'),
        year: (eb) => eb.ref('excluded.year'),
        community_rating: (eb) => eb.ref('excluded.community_rating'),
        updated_at_ms: (eb) => eb.ref('excluded.updated_at_ms'),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export type UpsertSatelliteInput =
  | ({ itemType: 'movie' } & Selectable<MovieDetailsTable>)
  | ({ itemType: 'series' } & Selectable<SeriesDetailsTable>)
  | ({ itemType: 'season' } & Selectable<SeasonDetailsTable>)
  | ({ itemType: 'episode' } & Selectable<EpisodeDetailsTable>)
  | ({ itemType: 'artist' } & Selectable<ArtistDetailsTable>)
  | ({ itemType: 'album' } & Selectable<AlbumDetailsTable>)
  | ({ itemType: 'track' } & Selectable<TrackDetailsTable>);

/**
 * Upsert the one satellite row matching `input.itemType` (FK = PK on
 * catalog_items.id, so this is always a single-row upsert keyed on
 * `item_id`). One function for all 7 satellites, dispatched on the
 * discriminant, so callers don't need to know 7 separate names.
 */
export async function upsertSatellite(db: DbOrTx, input: UpsertSatelliteInput): Promise<void> {
  switch (input.itemType) {
    case 'movie': {
      const { itemType: _itemType, ...row } = input;
      await db
        .insertInto('movie_details')
        .values(row)
        .onConflict((oc) =>
          oc.column('item_id').doUpdateSet({
            content_rating: (eb) => eb.ref('excluded.content_rating'),
            runtime_ms: (eb) => eb.ref('excluded.runtime_ms'),
            tagline: (eb) => eb.ref('excluded.tagline'),
            overview: (eb) => eb.ref('excluded.overview'),
          })
        )
        .execute();
      return;
    }
    case 'series': {
      const { itemType: _itemType, ...row } = input;
      await db
        .insertInto('series_details')
        .values(row)
        .onConflict((oc) =>
          oc.column('item_id').doUpdateSet({
            content_rating: (eb) => eb.ref('excluded.content_rating'),
            status: (eb) => eb.ref('excluded.status'),
            overview: (eb) => eb.ref('excluded.overview'),
          })
        )
        .execute();
      return;
    }
    case 'season': {
      const { itemType: _itemType, ...row } = input;
      await db
        .insertInto('season_details')
        .values(row)
        .onConflict((oc) =>
          oc.column('item_id').doUpdateSet({
            season_number: (eb) => eb.ref('excluded.season_number'),
          })
        )
        .execute();
      return;
    }
    case 'episode': {
      const { itemType: _itemType, ...row } = input;
      await db
        .insertInto('episode_details')
        .values(row)
        .onConflict((oc) =>
          oc.column('item_id').doUpdateSet({
            episode_number: (eb) => eb.ref('excluded.episode_number'),
            aired_at_ms: (eb) => eb.ref('excluded.aired_at_ms'),
            overview: (eb) => eb.ref('excluded.overview'),
          })
        )
        .execute();
      return;
    }
    case 'artist': {
      const { itemType: _itemType, ...row } = input;
      await db
        .insertInto('artist_details')
        .values(row)
        .onConflict((oc) =>
          oc.column('item_id').doUpdateSet({ overview: (eb) => eb.ref('excluded.overview') })
        )
        .execute();
      return;
    }
    case 'album': {
      const { itemType: _itemType, ...row } = input;
      await db
        .insertInto('album_details')
        .values(row)
        .onConflict((oc) =>
          oc.column('item_id').doUpdateSet({ year: (eb) => eb.ref('excluded.year') })
        )
        .execute();
      return;
    }
    case 'track': {
      const { itemType: _itemType, ...row } = input;
      await db
        .insertInto('track_details')
        .values(row)
        .onConflict((oc) =>
          oc.column('item_id').doUpdateSet({
            track_number: (eb) => eb.ref('excluded.track_number'),
            disc_number: (eb) => eb.ref('excluded.disc_number'),
            duration_ms: (eb) => eb.ref('excluded.duration_ms'),
          })
        )
        .execute();
      return;
    }
  }
}

/** By primary key — the probe job consumer needs the owning item's
 *  item_type to decide whether a satellite table has a runtime/duration
 *  field to backfill (docs/PLAN.md §8.3/P1.5: track_details.duration_ms
 *  yes, episode_details has no runtime_ms column at all — see
 *  apps/worker/src/probe/consumer.ts). */
export async function getCatalogItemById(db: DbOrTx, id: string): Promise<CatalogItemRow | undefined> {
  return db.selectFrom('catalog_items').selectAll().where('id', '=', id).executeTakeFirst();
}

/** track_details reader — the probe consumer needs the EXISTING
 *  track_number/disc_number before it can upsertSatellite a new
 *  duration_ms without clobbering them (upsertSatellite's track branch
 *  writes all three columns together, not a partial update). */
export async function getTrackDetails(
  db: DbOrTx,
  itemId: string
): Promise<Selectable<TrackDetailsTable> | undefined> {
  return db.selectFrom('track_details').selectAll().where('item_id', '=', itemId).executeTakeFirst();
}

// ============================================================================
// find-by-natural-key — the scanner's find-or-create identity resolution
// (docs/PLAN.md §8.1). catalog_items itself has no natural business key (see
// upsertCatalogItem's doc comment above), so every item TYPE resolves its own
// "does this already exist" lookup against title/parent/satellite fields the
// filename or tag parser produced. Case-insensitive on title (parser output
// casing can vary run to run — "The Matrix" vs "the matrix" from a
// lower-confidence directory-fallback parse must still resolve to the same
// item) via `lower(...)`, since catalog_items.title is plain TEXT, not CITEXT.
// ============================================================================

export interface FindMovieInput {
  libraryId: string;
  title: string;
  /** null matches a movie with no parsed year (both sides NULL); a specific
   *  year never matches a NULL-year row or vice versa — an exact identity
   *  key, not a fuzzy one. */
  year: number | null;
}

/**
 * Movie identity key: (library, title, year) — this is what makes the
 * multi-version/editions case work (docs/PLAN.md §8.1 "Multi-version/
 * editions"): two files that parse to the same title+year in the same
 * library resolve to the SAME catalog item, and the caller adds a second
 * media_files row (with a version_label) instead of creating a duplicate.
 */
export async function findMovieByTitleYear(
  db: DbOrTx,
  input: FindMovieInput
): Promise<CatalogItemRow | undefined> {
  let query = db
    .selectFrom('catalog_items')
    .selectAll()
    .where('library_id', '=', input.libraryId)
    .where('item_type', '=', 'movie')
    .where((eb) => eb(sql`lower(title)`, '=', input.title.toLowerCase()));

  query = input.year === null ? query.where('year', 'is', null) : query.where('year', '=', input.year);

  return query.executeTakeFirst();
}

/** Series identity key: (library, title) — no year component (TV parsing,
 *  unlike movies, does not carry a reliable series-level year). */
export async function findSeriesByTitle(
  db: DbOrTx,
  libraryId: string,
  title: string
): Promise<CatalogItemRow | undefined> {
  return db
    .selectFrom('catalog_items')
    .selectAll()
    .where('library_id', '=', libraryId)
    .where('item_type', '=', 'series')
    .where((eb) => eb(sql`lower(title)`, '=', title.toLowerCase()))
    .executeTakeFirst();
}

/** Season identity key: (series, season_number) — joins season_details. */
export async function findSeasonByNumber(
  db: DbOrTx,
  seriesId: string,
  seasonNumber: number
): Promise<CatalogItemRow | undefined> {
  return db
    .selectFrom('catalog_items')
    .innerJoin('season_details', 'season_details.item_id', 'catalog_items.id')
    .selectAll('catalog_items')
    .where('catalog_items.parent_id', '=', seriesId)
    .where('catalog_items.item_type', '=', 'season')
    .where('season_details.season_number', '=', seasonNumber)
    .executeTakeFirst();
}

/** Episode identity key: (season, episode_number) — joins episode_details. */
export async function findEpisodeByNumber(
  db: DbOrTx,
  seasonId: string,
  episodeNumber: number
): Promise<CatalogItemRow | undefined> {
  return db
    .selectFrom('catalog_items')
    .innerJoin('episode_details', 'episode_details.item_id', 'catalog_items.id')
    .selectAll('catalog_items')
    .where('catalog_items.parent_id', '=', seasonId)
    .where('catalog_items.item_type', '=', 'episode')
    .where('episode_details.episode_number', '=', episodeNumber)
    .executeTakeFirst();
}

/** Artist identity key: (library, name). */
export async function findArtistByName(
  db: DbOrTx,
  libraryId: string,
  name: string
): Promise<CatalogItemRow | undefined> {
  return db
    .selectFrom('catalog_items')
    .selectAll()
    .where('library_id', '=', libraryId)
    .where('item_type', '=', 'artist')
    .where((eb) => eb(sql`lower(title)`, '=', name.toLowerCase()))
    .executeTakeFirst();
}

/** Album identity key: (artist, title) — album_details.year is descriptive,
 *  not part of the key (an album re-tagged with a corrected year must still
 *  resolve to the same item). */
export async function findAlbumByTitle(
  db: DbOrTx,
  artistId: string,
  title: string
): Promise<CatalogItemRow | undefined> {
  return db
    .selectFrom('catalog_items')
    .selectAll()
    .where('parent_id', '=', artistId)
    .where('item_type', '=', 'album')
    .where((eb) => eb(sql`lower(title)`, '=', title.toLowerCase()))
    .executeTakeFirst();
}

/**
 * Track identity key: (album, track_number) when a track number is known
 * (joins track_details); falls back to (album, title) for track-number-less
 * files (music.ts's "track:absent" fallback path — tag-first music without
 * a track number tag still needs a stable identity key).
 */
export async function findTrackByNumberOrTitle(
  db: DbOrTx,
  albumId: string,
  input: { trackNumber: number | null; title: string }
): Promise<CatalogItemRow | undefined> {
  if (input.trackNumber !== null) {
    return db
      .selectFrom('catalog_items')
      .innerJoin('track_details', 'track_details.item_id', 'catalog_items.id')
      .selectAll('catalog_items')
      .where('catalog_items.parent_id', '=', albumId)
      .where('catalog_items.item_type', '=', 'track')
      .where('track_details.track_number', '=', input.trackNumber)
      .executeTakeFirst();
  }
  return db
    .selectFrom('catalog_items')
    .selectAll()
    .where('parent_id', '=', albumId)
    .where('item_type', '=', 'track')
    .where((eb) => eb(sql`lower(title)`, '=', input.title.toLowerCase()))
    .executeTakeFirst();
}
