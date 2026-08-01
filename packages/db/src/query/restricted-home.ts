// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/restricted-home.ts
//
// STATE.md Stash run (S9): the zone's home rails — continue-watching-in-
// zone, recently-added-in-zone, a studios rail, and a performers rail (both
// by scene count), all scoped to the viewer's ENTITLED restricted libraries
// (src/query/restricted-zone.ts's shared resolveEntitledRestrictedLibraryIds)
// and re-using this wave's already-guarded building blocks rather than
// re-deriving their logic:
//   - recentlyAddedInZone delegates straight to listRestrictedBrowse (sort:
//     'added') — the zone's OWN keyset browse, not a third implementation.
//   - studios/performers rails are TOP-N BY SCENE COUNT (S9's frozen rail
//     spec — "top-N studios + performers rails (by scene count)"), NOT the
//     alphabetical order listRestrictedStudios/listRestrictedPerformers use
//     for their own picker/browse lists — so this file queries them
//     directly (same guard primitives, count-DESC order) rather than
//     delegating to those two alphabetical list functions.
//   - continueWatchingInZone is a zone-scoped variant of src/query/
//     progress.ts's getContinueWatching (same applyGuardToJoined guard,
//     plus the `library_id IN restrictedLibraryIds` + `item_type = 'movie'`
//     zone scoping progress.ts has no reason to know about), shaped as
//     FULL RestrictedBrowseItemRow cards + progress (design/phosphor
//     README Home spec: "Continue Watching rail of 16:9 cards with
//     progress bars" — a poster/genres/studio card, not a bare id/title
//     tuple), reusing restricted-browse.ts's exported genre/studio/image
//     batch helpers so a card here can never drift from what GET
//     /restricted/browse itself renders for the same scene.
//
// Entitlement gate: identical two-step every zone surface in this wave
// uses — zero entitlement -> `undefined` (404). Entitled -> real rails,
// naturally empty while entitled-but-locked (every delegate below already
// enforces this the same way).

import { sql, type Kysely } from 'kysely';
import type { ContentClass, DB, ItemType, WatchState } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuardToJoined, applyGuardToPeople, applyGuardToTags } from './guard.js';
import { resolveEntitledRestrictedLibraryIds } from './restricted-zone.js';
import {
  fetchBrowseGenresBatch,
  fetchBrowseImagesBatch,
  fetchBrowseStudioBatch,
  listRestrictedBrowse,
  resolutionBandForHeight,
  type RestrictedBrowseItemRow,
} from './restricted-browse.js';
import type { RestrictedStudioRow } from './restricted-studios.js';
import type { RestrictedPerformerRow } from './restricted-performers.js';
import type { ImageDescriptor } from './catalog-detail.js';

export interface RestrictedContinueWatchingProgress {
  positionMs: number;
  durationMs: number | null;
  state: WatchState;
  playCount: number;
  updatedAtMs: number;
}

export interface RestrictedContinueWatchingEntry {
  item: RestrictedBrowseItemRow;
  progress: RestrictedContinueWatchingProgress;
}

export interface RestrictedZoneHome {
  continueWatchingInZone: RestrictedContinueWatchingEntry[];
  recentlyAddedInZone: RestrictedBrowseItemRow[];
  studios: RestrictedStudioRow[];
  performers: RestrictedPerformerRow[];
}

export interface GetRestrictedZoneHomeParams {
  /** Row cap for EACH rail independently (continueWatchingInZone/
   *  recentlyAddedInZone/studios/performers) — a home shell, not a
   *  browseable list; no cursor. */
  railLimit?: number;
}

const DEFAULT_RAIL_LIMIT = 20;
const DEFAULT_ENTITY_RAIL_LIMIT = 10;

/**
 * Continue-watching-in-zone: `progress.state = 'in-progress'` rows for
 * ctx.userId whose item is a zone scene, newest-updated first — shaped as
 * FULL RestrictedBrowseItemRow cards (poster/genres/studio/quality), not a
 * bare id/title tuple (module header). Small rail-sized result set
 * (<=railLimit rows), so a plain per-id lookup — not listRestrictedBrowse's
 * lateral-join scan machinery, built for a 33k-row keyset walk — is the
 * right cost here.
 */
async function getContinueWatchingInZone(
  db: Kysely<DB>,
  ctx: ViewerContext,
  restrictedLibraryIds: string[],
  limit: number
): Promise<RestrictedContinueWatchingEntry[]> {
  const progressRows = await db
    .selectFrom('progress')
    .innerJoin('catalog_items', 'catalog_items.id', 'progress.item_id')
    .leftJoin('movie_details', 'movie_details.item_id', 'catalog_items.id')
    .where('progress.user_id', '=', ctx.userId)
    .where('progress.state', '=', 'in-progress')
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where('catalog_items.item_type', '=', 'movie' satisfies ItemType)
    .where(applyGuardToJoined(ctx, 'progress.item_id'))
    .select([
      'catalog_items.id as id',
      'catalog_items.library_id as libraryId',
      'catalog_items.title as title',
      'catalog_items.sort_title as sortTitle',
      'catalog_items.year as year',
      'catalog_items.community_rating as communityRating',
      'catalog_items.added_at_ms as addedAtMs',
      'movie_details.premiere_at_ms as premiereAtMs',
      'progress.position_ms as positionMs',
      'progress.duration_ms as progressDurationMs',
      'progress.state as state',
      'progress.play_count as playCount',
      'progress.updated_at_ms as updatedAtMs',
    ])
    .orderBy('progress.updated_at_ms', 'desc')
    .orderBy('progress.item_id', 'desc')
    .limit(limit)
    .execute();

  if (progressRows.length === 0) return [];
  const ids = progressRows.map((r) => r.id);

  const [primaryFiles, genresMap, studioMap, imagesMap] = await Promise.all([
    db
      .selectFrom('media_files')
      .leftJoin('media_streams', (join) =>
        join.onRef('media_streams.file_id', '=', 'media_files.id').on('media_streams.stream_type', '=', 'video')
      )
      .select([
        'media_files.item_id as itemId',
        'media_files.id as fileId',
        'media_files.duration_ms as durationMs',
        'media_streams.height as height',
        'media_streams.hdr as hdr',
      ])
      .where('media_files.item_id', 'in', ids)
      .where('media_files.missing_since_ms', 'is', null)
      .orderBy(sql`(media_files.version_label IS NULL)`, 'desc')
      .orderBy('media_files.id', 'asc')
      .orderBy('media_streams.stream_index', 'asc')
      .execute(),
    fetchBrowseGenresBatch(db, ctx, ids),
    fetchBrowseStudioBatch(db, ctx, ids),
    fetchBrowseImagesBatch(db, ids),
  ]);

  const primaryByItem = new Map<string, { durationMs: number | null; height: number | null; hdr: RestrictedBrowseItemRow['hdr'] }>();
  for (const f of primaryFiles) {
    if (primaryByItem.has(f.itemId)) continue; // first non-missing file per item wins
    primaryByItem.set(f.itemId, { durationMs: f.durationMs, height: f.height, hdr: f.hdr });
  }

  return progressRows.map((row) => {
    const primary = primaryByItem.get(row.id);
    const item: RestrictedBrowseItemRow = {
      id: row.id,
      libraryId: row.libraryId,
      title: row.title,
      sortTitle: row.sortTitle,
      year: row.year,
      communityRating: row.communityRating,
      contentClass: 'restricted',
      addedAtMs: row.addedAtMs,
      updatedAtMs: row.updatedAtMs,
      premiereAtMs: row.premiereAtMs,
      durationMs: primary?.durationMs ?? null,
      resolution: resolutionBandForHeight(primary?.height),
      hdr: primary?.hdr ?? null,
      genres: genresMap.get(row.id) ?? [],
      studio: studioMap.get(row.id) ?? null,
      images: imagesMap.get(row.id) ?? [],
    };
    return {
      item,
      progress: {
        positionMs: row.positionMs,
        durationMs: row.progressDurationMs,
        state: row.state,
        playCount: row.playCount,
        updatedAtMs: row.updatedAtMs,
      },
    };
  });
}

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

/** Top-N studios by scene count (S9's rail spec — see module header for why
 *  this is a dedicated count-DESC query rather than a delegation to
 *  listRestrictedStudios, which is alphabetical for its own picker/browse
 *  use). Same guard primitives (applyGuardToTags + applyGuardToJoined) as
 *  restricted-studios.ts. */
async function getTopStudiosInZone(
  db: Kysely<DB>,
  ctx: ViewerContext,
  restrictedLibraryIds: string[],
  limit: number
): Promise<RestrictedStudioRow[]> {
  const rows = await applyGuardToTags(db.selectFrom('tags'), ctx)
    .where('tags.kind', '=', 'studio')
    .innerJoin('item_tags', 'item_tags.tag_id', 'tags.id')
    .innerJoin('catalog_items', 'catalog_items.id', 'item_tags.item_id')
    .where('item_tags.kind', '=', 'studio')
    .where('catalog_items.item_type', '=', 'movie' satisfies ItemType)
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where(applyGuardToJoined(ctx, 'item_tags.item_id'))
    .groupBy(['tags.id', 'tags.name', 'tags.content_class'])
    .select((eb) => [
      'tags.id as id',
      'tags.name as name',
      'tags.content_class as contentClass',
      eb.fn.count<string>('item_tags.item_id').distinct().as('sceneCount'),
    ])
    .orderBy((eb) => eb.fn.count('item_tags.item_id').distinct(), 'desc')
    .orderBy('tags.id', 'asc')
    .limit(limit)
    .execute();

  const imagesMap = await fetchStudioImagesBatch(
    db,
    rows.map((r) => r.id)
  );
  return rows.map((r) => ({ ...r, sceneCount: Number(r.sceneCount), images: imagesMap.get(r.id) ?? [] }));
}

/** FX2 fix wave: batch-fetch performer portraits — the SAME shape as this
 *  file's own fetchStudioImagesBatch above (entity_type swapped, 'person'
 *  instead of 'tag'), duplicated here rather than imported from
 *  restricted-performers.ts for the same reason fetchStudioImagesBatch is
 *  its own local copy rather than an import from restricted-studios.ts. */
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

/** Top-N performers by scene count — see getTopStudiosInZone's doc comment
 *  (same rationale, applyGuardToPeople + applyGuardToJoined per
 *  restricted-performers.ts). */
async function getTopPerformersInZone(
  db: Kysely<DB>,
  ctx: ViewerContext,
  restrictedLibraryIds: string[],
  limit: number
): Promise<RestrictedPerformerRow[]> {
  const rows = await applyGuardToPeople(db.selectFrom('people'), ctx)
    .innerJoin('item_people', 'item_people.person_id', 'people.id')
    .innerJoin('catalog_items', 'catalog_items.id', 'item_people.item_id')
    .where('item_people.role', '=', 'performer')
    .where('catalog_items.item_type', '=', 'movie' satisfies ItemType)
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where(applyGuardToJoined(ctx, 'item_people.item_id'))
    .groupBy(['people.id', 'people.name', 'people.content_class'])
    .select((eb) => [
      'people.id as id',
      'people.name as name',
      'people.content_class as contentClass',
      eb.fn.count<string>('item_people.item_id').distinct().as('sceneCount'),
    ])
    .orderBy((eb) => eb.fn.count('item_people.item_id').distinct(), 'desc')
    .orderBy('people.id', 'asc')
    .limit(limit)
    .execute();

  const imagesMap = await fetchPerformerImagesBatch(
    db,
    rows.map((r) => r.id)
  );
  return rows.map((r) => ({
    ...r,
    contentClass: r.contentClass as ContentClass,
    sceneCount: Number(r.sceneCount),
    images: imagesMap.get(r.id) ?? [],
  }));
}

/**
 * The zone home shell's four rails. `undefined` for zero restricted-zone
 * entitlement (caller: 404) — otherwise real (possibly all-empty, while
 * entitled-but-locked) rails.
 */
export async function getRestrictedZoneHome(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: GetRestrictedZoneHomeParams = {}
): Promise<RestrictedZoneHome | undefined> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);
  if (restrictedLibraryIds.length === 0) {
    return undefined;
  }

  const railLimit = params.railLimit ?? DEFAULT_RAIL_LIMIT;
  const entityRailLimit = Math.min(railLimit, DEFAULT_ENTITY_RAIL_LIMIT);

  const [continueWatchingInZone, recentlyAddedResult, studios, performers] = await Promise.all([
    getContinueWatchingInZone(db, ctx, restrictedLibraryIds, railLimit),
    listRestrictedBrowse(db, ctx, { sort: 'added', limit: railLimit }),
    getTopStudiosInZone(db, ctx, restrictedLibraryIds, entityRailLimit),
    getTopPerformersInZone(db, ctx, restrictedLibraryIds, entityRailLimit),
  ]);

  return {
    continueWatchingInZone,
    // listRestrictedBrowse re-derives the SAME entitlement check this
    // function just performed, so `undefined` here would mean the
    // entitlement state changed between calls (a race, not a real case) —
    // fall back to an empty rail rather than propagate a confusing
    // undefined through an otherwise-defined RestrictedZoneHome.
    recentlyAddedInZone: recentlyAddedResult?.rows ?? [],
    studios,
    performers,
  };
}
