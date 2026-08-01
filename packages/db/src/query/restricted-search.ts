// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/restricted-search.ts
//
// STATE.md Stash run (S9): the zone's own scoped search — title tsv +
// credited-person name + applied-tag (genre/tag/studio) name, the exact
// three-branch UNION shape src/query/search.ts already established (see
// that file's header for the full rationale: websearch_to_tsquery('simple',
// q) never raises on adversarial input; person/tag name matching is a
// trigram-indexed ILIKE substring; UNION-of-independently-planned-branches
// rather than one OR'd WHERE, so each branch gets its own index-backed
// plan and a row matching more than one branch collapses via UNION's
// DISTINCT). This module does not import search.ts's private branch
// builders (guard.ts's own header explains why: a generic helper cannot
// stay concretely typed across the raw-sql-column-reference pattern
// guardPredicateSql requires) — it is a small, self-contained, ZONE-SCOPED
// copy of the same shape, exactly the "small self-contained copy" posture
// restricted-zone.ts/restricted-browse.ts already establish for this
// package.
//
// Zone scoping: every branch additionally requires
// `library_id IN (the viewer's ENTITLED restricted libraries)` (src/query/
// restricted-zone.ts's resolveEntitledRestrictedLibraryIds) AND
// `item_type = 'movie'` (K1) — this is what makes the surface "hit a
// separate index" in the SENSE that matters (a dedicated, independently
// guarded query, never reachable from or leaking into the general
// searchCatalog surface's result set or timing): a zone title can never
// surface through GET /search, and a general title can never surface
// through this function, by construction of the WHERE clause, not by
// having a second physical GIN index (catalog_items has exactly one
// search_tsv column/index either way — see this lane's final report for
// the full reasoning).
//
// Entitlement gate: identical two-step every zone list surface in this
// wave uses — zero entitlement -> `undefined` (404); entitled -> a real,
// guard-filtered page, empty while entitled-but-locked (U10 posture).

import { sql, type Kysely } from 'kysely';
import type { DB, ItemType } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyGuard } from './guard.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { resolveEntitledRestrictedLibraryIds } from './restricted-zone.js';
import {
  fetchBrowseGenresBatch,
  fetchBrowseImagesBatch,
  fetchBrowseStudioBatch,
  resolutionBandForHeight,
  type RestrictedBrowseItemRow,
} from './restricted-browse.js';

/** A search hit IS a full zone scene card (packages/contract/openapi.yaml's
 *  restrictedSearch op reuses RestrictedBrowseItemPage as its response
 *  shape — the same poster/quality/studio data GET /restricted/browse
 *  attaches, per design/phosphor README's "SearchPanel precedent"), not a
 *  bare id/title/rank tuple — a client rendering search results as a
 *  poster grid needs the same fields a browse card does. */
export type RestrictedSearchResult = RestrictedBrowseItemRow;

export interface RestrictedSearchResultPage {
  rows: RestrictedSearchResult[];
  nextCursor: string | null;
}

export interface SearchRestrictedZoneParams {
  q: string;
  cursor?: string;
  limit?: number;
}

interface RestrictedSearchCursorPayload {
  rank: number;
  id: string;
}

function isRestrictedSearchCursorPayload(value: unknown): value is RestrictedSearchCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).rank === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

const DEFAULT_LIMIT = 50;

function likeContainsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function likePrefixPattern(q: string): string {
  return `${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

type RankedRow = { id: string; title: string; addedAtMs: number; rank: number };

function rankExpr(q: string, prefixPattern: string) {
  return sql<number>`ts_rank(${sql.ref('catalog_items.search_tsv')}, websearch_to_tsquery('simple', ${q})) + (CASE WHEN ${sql.ref('catalog_items.title')} ILIKE ${prefixPattern} THEN 0.5 ELSE 0 END)`.as(
    'rank'
  );
}

export async function searchRestrictedZone(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: SearchRestrictedZoneParams
): Promise<RestrictedSearchResultPage | undefined> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);
  if (restrictedLibraryIds.length === 0) {
    return undefined;
  }

  const limit = params.limit ?? DEFAULT_LIMIT;
  const q = params.q;
  const containsPattern = likeContainsPattern(q);
  const prefixPattern = likePrefixPattern(q);
  const rank = rankExpr(q, prefixPattern);

  // Each branch repeats the library/item_type zone-scoping clauses rather
  // than sharing them through a generic helper — search.ts's own header
  // explains why (guard.ts's raw-sql-column-reference pattern only stays
  // concretely typed at concrete, per-branch call sites, not behind an
  // abstract generic TB). Three short, concrete branches, same as search.ts.
  const tsvBranch = applyGuard(db.selectFrom('catalog_items'), ctx)
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where('catalog_items.item_type', '=', 'movie' satisfies ItemType)
    .where(sql<boolean>`${sql.ref('catalog_items.search_tsv')} @@ websearch_to_tsquery('simple', ${q})`)
    .select(['catalog_items.id as id', 'catalog_items.title as title', 'catalog_items.added_at_ms as addedAtMs', rank])
    .$castTo<RankedRow>();

  const performerBranch = applyContentClassFilter(
    applyGuard(
      db
        .selectFrom('catalog_items')
        .innerJoin('item_people', 'item_people.item_id', 'catalog_items.id')
        .innerJoin('people', 'people.id', 'item_people.person_id'),
      ctx
    )
      .where('catalog_items.library_id', 'in', restrictedLibraryIds)
      .where('catalog_items.item_type', '=', 'movie' satisfies ItemType)
      .where(sql<boolean>`${sql.ref('people.name')}::text ILIKE ${containsPattern}`),
    ctx,
    'people.content_class'
  )
    .select(['catalog_items.id as id', 'catalog_items.title as title', 'catalog_items.added_at_ms as addedAtMs', rank])
    .$castTo<RankedRow>();

  const tagBranch = applyContentClassFilter(
    applyGuard(
      db
        .selectFrom('catalog_items')
        .innerJoin('item_tags', 'item_tags.item_id', 'catalog_items.id')
        .innerJoin('tags', 'tags.id', 'item_tags.tag_id'),
      ctx
    )
      .where('catalog_items.library_id', 'in', restrictedLibraryIds)
      .where('catalog_items.item_type', '=', 'movie' satisfies ItemType)
      .where(sql<boolean>`${sql.ref('tags.name')}::text ILIKE ${containsPattern}`),
    ctx,
    'tags.content_class'
  )
    .select(['catalog_items.id as id', 'catalog_items.title as title', 'catalog_items.added_at_ms as addedAtMs', rank])
    .$castTo<RankedRow>();

  const unioned = tsvBranch.union(performerBranch).union(tagBranch);

  let outer = db.selectFrom(unioned.as('ranked_zone_items')).selectAll();

  if (params.cursor) {
    const { rank: cursorRank, id } = decodeCursor(params.cursor, isRestrictedSearchCursorPayload);
    outer = outer.where((eb) =>
      eb.or([eb('rank', '<', cursorRank), eb.and([eb('rank', '=', cursorRank), eb('id', '<', id)])])
    );
  }

  const ranked = await outer.orderBy('rank', 'desc').orderBy('id', 'desc').limit(limit).execute();

  const last = ranked[ranked.length - 1];
  const nextCursor =
    ranked.length === limit && last ? encodeCursor({ rank: last.rank, id: last.id }) : null;

  const rows = await attachSceneCardFields(db, ctx, ranked);
  return { rows, nextCursor };
}

/**
 * Attaches the same fields GET /restricted/browse's rows carry (premiere
 * date, probed duration/resolution/hdr, genres, studio, images) to a
 * RANKED page of {id, title, addedAtMs} hits — preserving the caller's
 * rank order (a plain `WHERE id IN (...)` does not). Small, page-sized
 * (<=200 ids per this module's own Limit ceiling), so a per-id lateral
 * join is not needed here the way listRestrictedBrowse's single big scan
 * needs one — one extra indexed lookup per page, not per row of a 33k scan.
 */
async function attachSceneCardFields(
  db: Kysely<DB>,
  ctx: ViewerContext,
  ranked: RankedRow[]
): Promise<RestrictedBrowseItemRow[]> {
  if (ranked.length === 0) return [];
  const ids = ranked.map((r) => r.id);

  const [baseRows, primaryFiles, genresMap, studioMap, imagesMap] = await Promise.all([
    db
      .selectFrom('catalog_items')
      .leftJoin('movie_details', 'movie_details.item_id', 'catalog_items.id')
      .select([
        'catalog_items.id as id',
        'catalog_items.library_id as libraryId',
        'catalog_items.sort_title as sortTitle',
        'catalog_items.year as year',
        'catalog_items.community_rating as communityRating',
        'catalog_items.updated_at_ms as updatedAtMs',
        'movie_details.premiere_at_ms as premiereAtMs',
      ])
      .where('catalog_items.id', 'in', ids)
      .execute(),
    db
      .selectFrom('media_files')
      .innerJoin('catalog_items', 'catalog_items.id', 'media_files.item_id')
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

  const baseById = new Map(baseRows.map((r) => [r.id, r]));
  // First non-missing file per item wins (unlabelled-file-first, same
  // convention as listRestrictedBrowse's lateral ORDER BY), then that
  // file's lowest-stream_index video row.
  const primaryByItem = new Map<string, { durationMs: number | null; height: number | null; hdr: RestrictedBrowseItemRow['hdr'] }>();
  for (const row of primaryFiles) {
    if (primaryByItem.has(row.itemId)) continue;
    primaryByItem.set(row.itemId, { durationMs: row.durationMs, height: row.height, hdr: row.hdr });
  }

  return ranked.map((hit) => {
    const base = baseById.get(hit.id);
    const primary = primaryByItem.get(hit.id);
    return {
      id: hit.id,
      libraryId: base?.libraryId ?? '',
      title: hit.title,
      sortTitle: base?.sortTitle ?? hit.title,
      year: base?.year ?? null,
      communityRating: base?.communityRating ?? null,
      contentClass: 'restricted',
      addedAtMs: hit.addedAtMs,
      updatedAtMs: base?.updatedAtMs ?? hit.addedAtMs,
      premiereAtMs: base?.premiereAtMs ?? null,
      durationMs: primary?.durationMs ?? null,
      resolution: resolutionBandForHeight(primary?.height),
      hdr: primary?.hdr ?? null,
      genres: genresMap.get(hit.id) ?? [],
      studio: studioMap.get(hit.id) ?? null,
      images: imagesMap.get(hit.id) ?? [],
    };
  });
}
