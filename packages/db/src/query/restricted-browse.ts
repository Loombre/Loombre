// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/restricted-browse.ts
//
// STATE.md Stash run (S9/K4): the dedicated Restricted Content surface's
// own guarded, keyset-paginated browse + scene-detail reads — real
// server-side filtering/sorting, replacing the retired "fetch the whole
// zone client-side" design (src/query/restricted-zone.ts's header).
//
// Entitlement model: identical two-step gate every zone query module in
// this wave shares (src/query/restricted-zone.ts's
// resolveEntitledRestrictedLibraryIds is the SINGLE implementation all of
// them call):
//   1. Zero restricted-library entitlement at all (gates 1-4 never passed)
//      -> `undefined`. The caller (apps/server) maps this to 404 — the zone
//      does not exist for this viewer, same posture as
//      getRestrictedZoneCountForViewer.
//   2. Entitled -> a REAL query through applyGuard(), which additionally
//      requires ctx.restrictedCleared (gate 5, the live session unlock) for
//      any `content_class = 'restricted'` row to survive. An entitled-but-
//      locked viewer therefore gets a real, empty result (200), never a 404
//      — distinguishing "the zone exists but I'm locked out right now" from
//      "no such zone" is exactly the U10 disclosure design/phosphor/
//      README.md accepts.
//
// K1 (scene identity): a "scene" is an `item_type = 'movie'` row in a
// restricted library — no new item_type. Every function below pins
// `item_type = 'movie'` explicitly (belt-and-suspenders: libraries.media_kind
// already constrains what the scanner ever creates in a restricted library,
// but this guards against a future media_kind changing that invariant
// silently widening what this surface returns).
//
// Filter combinability + malformed-input rule: every filter param below is
// independently optional and AND-combines with every other (house
// pattern). A malformed UUID inside performerIds/studioTagIds/tagIds, OR in
// a cursor's own id, can never match a row — per catalog-detail.ts:741-751's
// house rule this returns an EMPTY page (the filter still applied, just
// impossible to satisfy), NEVER a silently dropped filter (which would
// widen the result set beyond what the caller asked for).
//
// Resolution bands (S9, S5 "Loombre ffprobe authoritative for technical
// facts"): derived per item from its PRIMARY (unlabelled-wins-else-lowest-
// id, the same convention catalog-detail.ts's fetchMediaFilesBatch/
// media-info.ts's resolvePrimaryFile use) non-missing media_files row's
// PRIMARY (lowest stream_index) video stream's `height` — never stored,
// always computed. An item with no probed video stream yet (not scanned,
// or the Stash sync hasn't matched a file) reports `resolution: null`
// ("no evidence"), matching restricted-zone.ts's old is4k/hdr "honest
// default" precedent, and is excluded by a resolution filter (cannot prove
// membership in any band) but still returned when no resolution filter is
// active.
//
// Query shape: two LEFT JOIN LATERAL subqueries resolve, per catalog_items
// row, its primary media_files row (duration_ms) and that file's primary
// video stream (height) — a single index-backed correlated lookup per row
// rather than a second N+1 round trip, so `duration`-sort and resolution
// filtering can live in the SAME keyset query as everything else (Kysely
// 0.29 leftJoinLateral, verified against this package's kysely version).
// EXPLAIN findings against the current index set (packages/db/migrations
// through 0019) are documented in this lane's final report for Lane E's
// 0021 migration — see that report rather than duplicating the analysis
// here (index law: this file cannot add migrations, K8-amended).

import { sql, type Kysely } from 'kysely';
import type { DB, HdrType, ItemType } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyGuard } from './guard.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';
import { resolveEntitledRestrictedLibraryIds } from './restricted-zone.js';
import type { ImageDescriptor } from './catalog-detail.js';

export type RestrictedResolutionBand = 'SD' | 'HD' | 'FHD' | 'UHD';

/** height -> band, per this module's header. `null`/`undefined` height
 *  (no probed video stream) yields `null` — "no evidence", never a
 *  fabricated band. Exported: restricted-home.ts/restricted-performers.ts/
 *  restricted-search.ts all shape RestrictedBrowseItemRow-equivalent scene
 *  rows too (home rails, a performer's filmography, search hits) and must
 *  derive the SAME band from the SAME thresholds — one implementation,
 *  never a second copy that could drift. */
export function resolutionBandForHeight(height: number | null | undefined): RestrictedResolutionBand | null {
  if (height == null) return null;
  if (height >= 2160) return 'UHD';
  if (height >= 1080) return 'FHD';
  if (height >= 720) return 'HD';
  return 'SD';
}

/** Postgres's own `uuid` input format — see catalog-detail.ts's UUID_PATTERN
 *  for the identical rationale (binding a non-UUID into a uuid column
 *  comparison throws 22P02, a raw 500 for what is a client input mistake). */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function allUuids(ids: readonly string[] | undefined): boolean {
  return ids === undefined || ids.every((id) => UUID_PATTERN.test(id));
}

// ============================================================================
// Browse
// ============================================================================

export interface RestrictedBrowseItemRow {
  id: string;
  libraryId: string;
  title: string;
  sortTitle: string;
  year: number | null;
  communityRating: number | null;
  contentClass: 'restricted';
  addedAtMs: number;
  updatedAtMs: number;
  /** Editorial premiere date (K1, movie_details.premiere_at_ms) — null for
   *  the many scenes whose source carries no full date; callers fall back
   *  to `year`. */
  premiereAtMs: number | null;
  /** Probed primary-file duration (S9: "duration sort keys on probed
   *  media_files.duration_ms") — null until the file is probed. */
  durationMs: number | null;
  resolution: RestrictedResolutionBand | null;
  hdr: HdrType | null;
  genres: string[];
  /** Singular: a scene carries at most one studio attribution (K2, the
   *  item_tags.kind='studio' edge) in the current mapping. */
  studio: { id: string; name: string } | null;
  images: ImageDescriptor[];
}

export interface RestrictedBrowseFilterParams {
  performerIds?: string[];
  studioTagIds?: string[];
  /** Genre/general tag ids (kind IN ('genre','tag')) — deliberately
   *  excludes 'studio' edges, which have their own dedicated
   *  `studioTagIds` param so a studio filter and a genre/tag filter can be
   *  combined without one silently absorbing the other. */
  tagIds?: string[];
  ratingMin?: number;
  ratingMax?: number;
  durationMinMs?: number;
  durationMaxMs?: number;
  /** Multiple bands OR-combine (e.g. "FHD or UHD"); an item whose
   *  resolution is unknown (`null`) never matches any non-empty filter. */
  resolution?: RestrictedResolutionBand[];
  yearMin?: number;
  yearMax?: number;
}

export type RestrictedBrowseSort = 'added' | 'date' | 'title' | 'rating' | 'duration';
export type RestrictedBrowseOrder = 'asc' | 'desc';

const DEFAULT_ORDER_BY_SORT: Record<RestrictedBrowseSort, RestrictedBrowseOrder> = {
  added: 'desc',
  date: 'desc',
  title: 'asc',
  rating: 'desc',
  duration: 'desc',
};

// Sentinels (same convention as catalog-detail.ts's RATING_LOW/HIGH_SENTINEL:
// push NULLs to the end of the result set regardless of sort direction —
// documented convention, not DB-enforced). Duration/date are epoch-ms/ms
// BIGINTs; these sentinels sit comfortably outside any real value's range
// while staying well inside Number.isSafeInteger.
const RATING_LOW_SENTINEL = -1;
const RATING_HIGH_SENTINEL = 11;
const DATE_LOW_SENTINEL = -1;
const DATE_HIGH_SENTINEL = 99_999_999_999_999;
const DURATION_LOW_SENTINEL = -1;
const DURATION_HIGH_SENTINEL = 99_999_999_999_999;

// ─────────────────────────────────────────────────────────────────────────
// S10 residue, MEASURED (R2 audit, 33k fixture, two-restricted-library
// viewer, same hardware/warm-cache conditions as 0021's own table)
// ─────────────────────────────────────────────────────────────────────────
// migration 0021 declined rating/date/duration sorts as owner-sign-off
// territory, following 0009's precedent, on the reasoning that "one index
// does not cover both directions". That reasoning is correct but was never
// taken to a measurement; here is the measurement, so the next person to
// look at this decides from numbers instead of re-deriving them:
//
//   sort=rating — a per-direction PARTIAL EXPRESSION index on
//     catalog_items DOES work, and works well:
//       CREATE INDEX ... ON catalog_items ((COALESCE(community_rating, -1)) DESC, id DESC) WHERE item_type = 'movie'   -- order=desc
//       CREATE INDEX ... ON catalog_items ((COALESCE(community_rating, 11)) ASC,  id ASC)  WHERE item_type = 'movie'   -- order=asc
//     desc 238.7ms -> 7.4ms, asc 253.1ms -> 7.5ms, deep keyset (~page 21)
//     7.7ms, ~1.3 MB each. The sentinel reaches Postgres as a bound
//     PARAMETER rather than a literal, which would normally defeat
//     expression-index matching — it does not here, because node-postgres
//     issues unnamed statements and Postgres therefore plans each one with
//     the parameter's actual value (a custom plan). Anything that changes
//     that (naming/preparing these statements, or a future
//     plan_cache_mode=force_generic_plan) would silently un-match the
//     index, so a re-measurement belongs in the same change.
//
//   sort=date — NOT fixable this way, confirmed rather than assumed: the
//     equivalent index on movie_details ((COALESCE(premiere_at_ms, ...)))
//     is simply not chosen by the planner (240.2ms -> 238.2ms, index
//     unused), because the COALESCE lives on a LEFT JOINed satellite and
//     cannot order a scan driven from catalog_items.
//
//   sort=duration — structurally unindexable: the key comes out of the
//     per-item LATERAL below (the primary-file resolution rule has no
//     column to index). Needs the catalog_items.primary_duration_ms
//     denormalization, i.e. a writer change, i.e. owner sign-off.
//
// So the honest split is: date + duration really are owner-decision
// territory; rating is a two-index migration whose only open question is
// whether the owner wants the zone to diverge from the general catalog's
// own still-declined rating/year sorts (0009's header). Not landed here —
// that symmetry call is the owner's, not a review lane's.
function sortKeyExpr(sort: RestrictedBrowseSort, order: RestrictedBrowseOrder) {
  switch (sort) {
    case 'added':
      return sql<number>`catalog_items.added_at_ms`;
    case 'title':
      return sql<string>`catalog_items.sort_title`;
    case 'rating':
      return sql<number>`COALESCE(catalog_items.community_rating, ${
        order === 'desc' ? RATING_LOW_SENTINEL : RATING_HIGH_SENTINEL
      })`;
    case 'date':
      return sql<number>`COALESCE(movie_details.premiere_at_ms, ${
        order === 'desc' ? DATE_LOW_SENTINEL : DATE_HIGH_SENTINEL
      })`;
    case 'duration':
      return sql<number>`COALESCE(primary_file.duration_ms, ${
        order === 'desc' ? DURATION_LOW_SENTINEL : DURATION_HIGH_SENTINEL
      })`;
  }
}

export interface ListRestrictedBrowseParams extends RestrictedBrowseFilterParams {
  sort?: RestrictedBrowseSort;
  order?: RestrictedBrowseOrder;
  cursor?: string;
  limit?: number;
}

export interface ListRestrictedBrowseResult {
  rows: RestrictedBrowseItemRow[];
  nextCursor: string | null;
}

interface BrowseCursorPayload {
  sort: RestrictedBrowseSort;
  order: RestrictedBrowseOrder;
  sortKey: string | number;
  id: string;
}

const VALID_SORTS: ReadonlySet<string> = new Set<RestrictedBrowseSort>(['added', 'date', 'title', 'rating', 'duration']);
const VALID_ORDERS: ReadonlySet<string> = new Set<RestrictedBrowseOrder>(['asc', 'desc']);

function isBrowseCursorPayload(
  value: unknown,
  activeSort: RestrictedBrowseSort,
  activeOrder: RestrictedBrowseOrder
): value is BrowseCursorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  // isCursorRowId (src/query/cursor.ts) is the shared form of the check
  // this validator originated — restricted-performers/-studios/-search's
  // own payload validators now call the SAME helper, so the four zone
  // list surfaces cannot drift back apart (R1 review lane, leak.spec 12h).
  if (!isCursorRowId(v.id)) return false;
  if (typeof v.sort !== 'string' || !VALID_SORTS.has(v.sort)) return false;
  if (typeof v.order !== 'string' || !VALID_ORDERS.has(v.order)) return false;
  if (v.sort !== activeSort || v.order !== activeOrder) return false;
  return v.sort === 'title' ? typeof v.sortKey === 'string' : typeof v.sortKey === 'number';
}

const DEFAULT_LIMIT = 50;
const EMPTY_PAGE: ListRestrictedBrowseResult = { rows: [], nextCursor: null };

/** Zone-local genre batch. Exported (unlike catalog-detail.ts's
 *  fetchGenresBatch precedent, which stays module-private for its single
 *  caller): FOUR zone modules now shape RestrictedBrowseItemRow-equivalent
 *  scene rows from a guard-filtered id list (this file, restricted-home.ts,
 *  restricted-performers.ts, restricted-search.ts) — one shared
 *  implementation here is what keeps their genre/studio/image attachment
 *  rules from drifting apart, not a leak concern (every id passed in is
 *  already guard-filtered by the caller). Scoped to kind='genre' — studio
 *  is fetched separately below, tag (kind='tag') separately again by scene
 *  detail's own inline query in getRestrictedSceneDetail (list rows never
 *  need non-genre tags; only scene detail does). */
export async function fetchBrowseGenresBatch(db: Kysely<DB>, ctx: ViewerContext, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;

  const rows = await applyContentClassFilter(
    db
      .selectFrom('item_tags')
      .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
      .select(['item_tags.item_id as itemId', 'tags.name as name'])
      .where('item_tags.item_id', 'in', ids)
      .where('item_tags.kind', '=', 'genre'),
    ctx,
    'tags.content_class'
  ).execute();

  for (const row of rows) {
    const arr = map.get(row.itemId) ?? [];
    arr.push(row.name);
    map.set(row.itemId, arr);
  }
  return map;
}

/** One studio ref per item (K2: an item_tags.kind='studio' edge to a
 *  tags.kind='studio' row) — singular by current mapping convention, first
 *  edge wins if more than one somehow exists. `id` included (not just the
 *  name) so browse cards/scene detail can link straight to
 *  GET /restricted/studios/{id}. */
export async function fetchBrowseStudioBatch(
  db: Kysely<DB>,
  ctx: ViewerContext,
  ids: string[]
): Promise<Map<string, { id: string; name: string }>> {
  const map = new Map<string, { id: string; name: string }>();
  if (ids.length === 0) return map;

  const rows = await applyContentClassFilter(
    db
      .selectFrom('item_tags')
      .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
      .select(['item_tags.item_id as itemId', 'tags.id as id', 'tags.name as name'])
      .where('item_tags.item_id', 'in', ids)
      .where('item_tags.kind', '=', 'studio'),
    ctx,
    'tags.content_class'
  ).execute();

  for (const row of rows) {
    if (!map.has(row.itemId)) map.set(row.itemId, { id: row.id, name: row.name });
  }
  return map;
}

export async function fetchBrowseImagesBatch(db: Kysely<DB>, ids: string[]): Promise<Map<string, ImageDescriptor[]>> {
  const map = new Map<string, ImageDescriptor[]>();
  if (ids.length === 0) return map;

  const rows = await db
    .selectFrom('images')
    .select(['entity_id', 'kind', 'width', 'height', 'blurhash', 'dominant_color'])
    .where('entity_type', '=', 'catalog_item')
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

/**
 * The zone's own filtered/sorted/keyset-paginated browse — `undefined` for
 * zero restricted-zone entitlement (caller: 404); otherwise a real page
 * (empty while entitled-but-locked, per this module's header).
 */
export async function listRestrictedBrowse(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListRestrictedBrowseParams = {}
): Promise<ListRestrictedBrowseResult | undefined> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);
  if (restrictedLibraryIds.length === 0) {
    return undefined;
  }

  // House rule (catalog-detail.ts:741-751): a malformed UUID filter/cursor
  // id can never match a row — answer with an EMPTY page, never a silently
  // dropped filter (which would widen the result set).
  if (
    !allUuids(params.performerIds) ||
    !allUuids(params.studioTagIds) ||
    !allUuids(params.tagIds)
  ) {
    return EMPTY_PAGE;
  }

  const limit = params.limit ?? DEFAULT_LIMIT;
  const sort = params.sort ?? 'added';
  const order = params.order ?? DEFAULT_ORDER_BY_SORT[sort];
  const keyExpr = sortKeyExpr(sort, order);
  const cmp = order === 'desc' ? '<' : '>';

  let query = applyGuard(db.selectFrom('catalog_items').selectAll(), ctx)
    .where('catalog_items.library_id', 'in', restrictedLibraryIds)
    .where('catalog_items.item_type', '=', 'movie' satisfies ItemType)
    .leftJoin('movie_details', 'movie_details.item_id', 'catalog_items.id')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('media_files')
          .select(['media_files.id as file_id', 'media_files.duration_ms as duration_ms'])
          .whereRef('media_files.item_id', '=', 'catalog_items.id')
          .where('media_files.missing_since_ms', 'is', null)
          .orderBy(sql`(media_files.version_label IS NULL)`, 'desc')
          .orderBy('media_files.id', 'asc')
          .limit(1)
          .as('primary_file'),
      (join) => join.onTrue()
    )
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('media_streams')
          .select(['media_streams.height as height', 'media_streams.hdr as hdr'])
          .whereRef('media_streams.file_id', '=', 'primary_file.file_id')
          .where('media_streams.stream_type', '=', 'video')
          .orderBy('media_streams.stream_index', 'asc')
          .limit(1)
          .as('primary_video'),
      (join) => join.onTrue()
    )
    .select([
      'movie_details.premiere_at_ms as premiereAtMs',
      'primary_file.duration_ms as durationMs',
      'primary_video.height as height',
      'primary_video.hdr as hdr',
    ]);

  if (params.performerIds && params.performerIds.length > 0) {
    const performerIds = params.performerIds;
    // `role = 'performer'` (R1 review lane, leak.spec 12h): the zone's
    // notion of "performer" is role='performer' EVERYWHERE else —
    // restricted-performers.ts's qualifyingCreditQuery (which is what
    // mints every id a client can legitimately pass in here, via GET
    // /restricted/performers and the home rail) and
    // getRestrictedPerformerById both require it. Without the same
    // predicate on this filter the zone answered 404 for
    // GET /restricted/performers/{id} and 200-with-a-real-scene-card for
    // GET /restricted/performers/{id}/scenes on the SAME id — a person
    // holding only a non-performer credit (seed.mjs's 'Marginal General
    // Actor', role='guest' on a zone scene) resolved through the
    // sub-resource its own parent surface denies. Same shape as Lane D's
    // catch (a general item id resolving through getRestrictedSceneDetail),
    // one level down.
    //
    // Person-side content_class isolation is deliberately NOT added here:
    // it would be a strict no-op (when ctx.restrictedCleared is false
    // applyGuard has already emptied every zone row this query can reach,
    // and when it is true the clause is the identity), and the guard law
    // is that filters narrow — the OUTPUT rows carry the isolation.
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('item_people')
          .select('item_people.id')
          .whereRef('item_people.item_id', '=', 'catalog_items.id')
          .where('item_people.role', '=', 'performer')
          .where('item_people.person_id', 'in', performerIds)
      )
    );
  }

  if (params.studioTagIds && params.studioTagIds.length > 0) {
    const studioTagIds = params.studioTagIds;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('item_tags')
          .select('item_tags.id')
          .whereRef('item_tags.item_id', '=', 'catalog_items.id')
          .where('item_tags.kind', '=', 'studio')
          .where('item_tags.tag_id', 'in', studioTagIds)
      )
    );
  }

  if (params.tagIds && params.tagIds.length > 0) {
    const tagIds = params.tagIds;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('item_tags')
          .select('item_tags.id')
          .whereRef('item_tags.item_id', '=', 'catalog_items.id')
          .where('item_tags.kind', 'in', ['genre', 'tag'])
          .where('item_tags.tag_id', 'in', tagIds)
      )
    );
  }

  if (params.ratingMin !== undefined) {
    query = query.where('catalog_items.community_rating', '>=', params.ratingMin);
  }
  if (params.ratingMax !== undefined) {
    query = query.where('catalog_items.community_rating', '<=', params.ratingMax);
  }
  if (params.yearMin !== undefined) {
    query = query.where('catalog_items.year', '>=', params.yearMin);
  }
  if (params.yearMax !== undefined) {
    query = query.where('catalog_items.year', '<=', params.yearMax);
  }
  if (params.durationMinMs !== undefined) {
    query = query.where('primary_file.duration_ms', '>=', params.durationMinMs);
  }
  if (params.durationMaxMs !== undefined) {
    query = query.where('primary_file.duration_ms', '<=', params.durationMaxMs);
  }
  if (params.resolution && params.resolution.length > 0) {
    const bands = params.resolution;
    query = query.where((eb) =>
      eb.or(
        bands.map((band) => {
          switch (band) {
            case 'UHD':
              return eb('primary_video.height', '>=', 2160);
            case 'FHD':
              return eb.and([eb('primary_video.height', '>=', 1080), eb('primary_video.height', '<', 2160)]);
            case 'HD':
              return eb.and([eb('primary_video.height', '>=', 720), eb('primary_video.height', '<', 1080)]);
            case 'SD':
              return eb.and([eb('primary_video.height', 'is not', null), eb('primary_video.height', '<', 720)]);
          }
        })
      )
    );
  }

  if (params.cursor) {
    const { sortKey, id } = decodeCursor(params.cursor, (v): v is BrowseCursorPayload =>
      isBrowseCursorPayload(v, sort, order)
    );
    // ROW-comparison keyset (catalog-detail.ts precedent): pushes the
    // cursor position into an Index Cond seek rather than a per-row Filter.
    query = query.where(sql<boolean>`(${keyExpr}, catalog_items.id) ${sql.raw(cmp)} (${sortKey}, ${id})`);
  }

  const rows = await query
    .orderBy(keyExpr, order)
    .orderBy('catalog_items.id', order)
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const lastSortKey =
    sort === 'title'
      ? last?.sort_title
      : sort === 'added'
        ? last?.added_at_ms
        : sort === 'rating'
          ? (last?.community_rating ?? (order === 'desc' ? RATING_LOW_SENTINEL : RATING_HIGH_SENTINEL))
          : sort === 'date'
            ? (last?.premiereAtMs ?? (order === 'desc' ? DATE_LOW_SENTINEL : DATE_HIGH_SENTINEL))
            : (last?.durationMs ?? (order === 'desc' ? DURATION_LOW_SENTINEL : DURATION_HIGH_SENTINEL));
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor({ sort, order, sortKey: lastSortKey as string | number, id: last.id })
      : null;

  const ids = rows.map((r) => r.id);
  const [genresMap, studioMap, imagesMap] = await Promise.all([
    fetchBrowseGenresBatch(db, ctx, ids),
    fetchBrowseStudioBatch(db, ctx, ids),
    fetchBrowseImagesBatch(db, ids),
  ]);

  const items: RestrictedBrowseItemRow[] = rows.map((row) => ({
    id: row.id,
    libraryId: row.library_id,
    title: row.title,
    sortTitle: row.sort_title,
    year: row.year,
    communityRating: row.community_rating,
    contentClass: 'restricted',
    addedAtMs: row.added_at_ms,
    updatedAtMs: row.updated_at_ms,
    premiereAtMs: row.premiereAtMs,
    durationMs: row.durationMs,
    resolution: resolutionBandForHeight(row.height),
    hdr: row.hdr,
    genres: genresMap.get(row.id) ?? [],
    studio: studioMap.get(row.id) ?? null,
    images: imagesMap.get(row.id) ?? [],
  }));

  return { rows: items, nextCursor };
}

// ============================================================================
// Scene detail
// ============================================================================

export interface RestrictedScenePersonChip {
  id: string;
  name: string;
}

export interface RestrictedSceneTagChip {
  id: string;
  name: string;
}

export interface RestrictedSceneChapter {
  id: string;
  title: string;
  startMs: number;
}

export interface RestrictedSceneDetail {
  id: string;
  libraryId: string;
  title: string;
  sortTitle: string;
  year: number | null;
  communityRating: number | null;
  contentClass: 'restricted';
  addedAtMs: number;
  updatedAtMs: number;
  premiereAtMs: number | null;
  overview: string | null;
  tagline: string | null;
  contentRating: string | null;
  runtimeMs: number | null;
  durationMs: number | null;
  resolution: RestrictedResolutionBand | null;
  hdr: HdrType | null;
  images: ImageDescriptor[];
  studio: RestrictedSceneTagChip | null;
  performers: RestrictedScenePersonChip[];
  tags: RestrictedSceneTagChip[];
  chapters: RestrictedSceneChapter[];
  progress: {
    positionMs: number;
    durationMs: number | null;
    state: 'unplayed' | 'in-progress' | 'played';
    playCount: number;
    updatedAtMs: number;
  } | null;
}

/**
 * Scene detail: cover, editorial fields, studio/performer/tag chips,
 * chapter markers, and the CALLER'S OWN resume progress. `undefined` for
 * "does not exist" OR "exists but not visible to ctx" (wrong library, not
 * item_type='movie', or restricted-and-not-cleared) — INDISTINGUISHABLE by
 * design, same as getItemById (src/query/items.ts) — the caller maps this
 * to a byte-identical 404 either way. Deliberately does NOT pre-check
 * entitlement the way the list surfaces above do: applyGuard() alone
 * already produces `undefined` for a non-entitled viewer (their
 * allowedLibraryIds never contains a restricted library id at all) AND for
 * an entitled-but-locked one (content_class clause), so there is nothing
 * for a caller to distinguish here the way "zone exists but locked" vs
 * "zone doesn't exist" matters for the aggregate/list surfaces.
 */
export async function getRestrictedSceneDetail(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string
): Promise<RestrictedSceneDetail | undefined> {
  const row = await applyGuard(db.selectFrom('catalog_items').selectAll(), ctx)
    .where('catalog_items.id', '=', id)
    .where('catalog_items.item_type', '=', 'movie' satisfies ItemType)
    // Zone-exclusive (K1): without this, a GENERAL movie the viewer can
    // otherwise see (item_type='movie' is not unique to restricted
    // libraries) would resolve through this surface too — a scope leak
    // the OTHER direction from §6.4 (general content bleeding INTO the
    // dedicated zone view), caught by this lane's own leak suite
    // ("a general (non-zone) item id is ALSO undefined through this
    // surface, even fully cleared").
    .where('catalog_items.content_class', '=', 'restricted')
    .leftJoin('movie_details', 'movie_details.item_id', 'catalog_items.id')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('media_files')
          .select(['media_files.id as file_id', 'media_files.duration_ms as duration_ms'])
          .whereRef('media_files.item_id', '=', 'catalog_items.id')
          .where('media_files.missing_since_ms', 'is', null)
          .orderBy(sql`(media_files.version_label IS NULL)`, 'desc')
          .orderBy('media_files.id', 'asc')
          .limit(1)
          .as('primary_file'),
      (join) => join.onTrue()
    )
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('media_streams')
          .select(['media_streams.height as height', 'media_streams.hdr as hdr'])
          .whereRef('media_streams.file_id', '=', 'primary_file.file_id')
          .where('media_streams.stream_type', '=', 'video')
          .orderBy('media_streams.stream_index', 'asc')
          .limit(1)
          .as('primary_video'),
      (join) => join.onTrue()
    )
    .select([
      'movie_details.premiere_at_ms as premiereAtMs',
      'movie_details.overview as overview',
      'movie_details.tagline as tagline',
      'movie_details.content_rating as contentRating',
      'movie_details.runtime_ms as runtimeMs',
      'primary_file.duration_ms as durationMs',
      'primary_video.height as height',
      'primary_video.hdr as hdr',
    ])
    .executeTakeFirst();

  if (!row) return undefined;

  const [images, studioRows, performerRows, tagRows, chapterRows, progressRow] = await Promise.all([
    fetchBrowseImagesBatch(db, [row.id]),
    applyContentClassFilter(
      db
        .selectFrom('item_tags')
        .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
        .select(['tags.id as id', 'tags.name as name'])
        .where('item_tags.item_id', '=', row.id)
        .where('item_tags.kind', '=', 'studio'),
      ctx,
      'tags.content_class'
    ).execute(),
    applyContentClassFilter(
      db
        .selectFrom('item_people')
        .innerJoin('people', 'people.id', 'item_people.person_id')
        .select(['people.id as id', 'people.name as name'])
        .where('item_people.item_id', '=', row.id)
        .where('item_people.role', '=', 'performer'),
      ctx,
      'people.content_class'
    )
      .orderBy('item_people.ord', 'asc')
      .execute(),
    applyContentClassFilter(
      db
        .selectFrom('item_tags')
        .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
        .select(['tags.id as id', 'tags.name as name'])
        .where('item_tags.item_id', '=', row.id)
        .where('item_tags.kind', 'in', ['genre', 'tag']),
      ctx,
      'tags.content_class'
    ).execute(),
    db
      .selectFrom('chapter_markers')
      .select(['id', 'title', 'start_ms'])
      .where('item_id', '=', row.id)
      // `id` tiebreak on `start_ms` ties — matches src/query/chapters.ts's
      // getChaptersForItem exactly (that file is the generic bare-item-id
      // entry point for the SAME chapter_markers rows this inlines for the
      // zone detail page; the two reads must return chapters in the same
      // order for the same item, tie or not).
      .orderBy('start_ms', 'asc')
      .orderBy('id', 'asc')
      .execute(),
    db
      .selectFrom('progress')
      .select(['position_ms', 'duration_ms', 'state', 'play_count', 'updated_at_ms'])
      .where('item_id', '=', row.id)
      .where('user_id', '=', ctx.userId)
      .executeTakeFirst(),
  ]);

  return {
    id: row.id,
    libraryId: row.library_id,
    title: row.title,
    sortTitle: row.sort_title,
    year: row.year,
    communityRating: row.community_rating,
    contentClass: 'restricted',
    addedAtMs: row.added_at_ms,
    updatedAtMs: row.updated_at_ms,
    premiereAtMs: row.premiereAtMs,
    overview: row.overview,
    tagline: row.tagline,
    contentRating: row.contentRating,
    runtimeMs: row.runtimeMs,
    durationMs: row.durationMs,
    resolution: resolutionBandForHeight(row.height),
    hdr: row.hdr,
    images: images.get(row.id) ?? [],
    studio: studioRows[0] ?? null,
    performers: performerRows,
    tags: tagRows,
    chapters: chapterRows.map((c) => ({ id: c.id, title: c.title, startMs: c.start_ms })),
    progress: progressRow
      ? {
          positionMs: progressRow.position_ms,
          durationMs: progressRow.duration_ms,
          state: progressRow.state,
          playCount: progressRow.play_count,
          updatedAtMs: progressRow.updated_at_ms,
        }
      : null,
  };
}
