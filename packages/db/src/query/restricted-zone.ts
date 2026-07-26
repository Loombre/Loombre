// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/restricted-zone.ts
//
// Restricted zone aggregate count (STATE.md Phosphor retheme, W1c
// "contract enablers" lane; design/phosphor/README.md "Interactions ->
// Restricted content" / U10): the zone's EXISTENCE and aggregate item
// count are deliberately visible to entitled users REGARDLESS of the
// current lock state (gate 5 / ctx.restrictedCleared) — the owner-accepted
// disclosure is "that a zone exists and how big it is", never titles or
// artwork. Restricted-profile viewers (no entitlement at all) must get
// NOTHING: for them the zone does not exist, server-side, full stop.
//
// Entitlement, ground-truthed against apps/server/src/common/
// viewer-context.provider.ts: ViewerContextProvider populates
// ctx.allowedLibraryIds with a restricted library's id iff gates 1-4 (server
// capability, age, opt-in+PIN, explicit library_permissions grant) ALL
// pass — deliberately INDEPENDENT of gate 5 (live session unlock), which
// only gates ctx.restrictedCleared. So "does ctx.allowedLibraryIds contain
// at least one restricted-class library id" is EXACTLY "gates 1-4 passed
// for this viewer", independent of whether they're currently locked —
// precisely the entitlement question this surface needs, already answered
// by the ViewerContext this package always requires (CLAUDE.md invariant
// 4), with no new field needed on that type. Verified against
// packages/db/test/leak.spec.ts's own fixtures: `casualUncleared`
// (allowedLibraryIds = general only — not entitled) vs
// `adminClearedButNotUnlocked` (allowedLibraryIds = ALL libraries incl.
// restricted, restrictedCleared: false — entitled but locked).
//
// Deliberately does NOT call applyGuard()/apply the ctx.restrictedCleared
// content_class branch at all — that branch exists to hide restricted rows
// from a LOCKED-but-entitled viewer, which is exactly the case this
// surface must NOT hide (U10: visible regardless of lock state). Instead:
// library membership is resolved to the entitled subset of
// ctx.allowedLibraryIds ourselves (a real `libraries` lookup, not trusting
// the ctx array blindly — a defense-in-depth double-check that the ids in
// question really are restricted-class libraries), content_class is
// pinned explicitly to 'restricted', and the missing-file visibility rule
// (docs/PLAN.md §8.2) is reused verbatim via applyNotMissingFilesFilter so
// the count matches what listItems()-style reads would actually surface
// once unlocked — never a raw, ungoverned `count(*)`.

import type { Kysely } from 'kysely';
import type { DB, HdrType, ItemType } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyGuard, applyNotMissingFilesFilter } from './guard.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { ImageDescriptor } from './catalog-detail.js';

export interface RestrictedZoneCount {
  count: number;
}

/**
 * The entitlement resolution both this module's surfaces share: "does `ctx`
 * hold at least one restricted-class library id in its own
 * allowedLibraryIds" (gates 1-4, independent of gate 5/restrictedCleared —
 * see module header). Returns the empty array for "not entitled" rather
 * than a boolean so callers get the actual ids to filter on, not just a
 * yes/no.
 */
async function resolveEntitledRestrictedLibraryIds(db: Kysely<DB>, ctx: ViewerContext): Promise<string[]> {
  if (ctx.allowedLibraryIds.length === 0) {
    return [];
  }
  const rows = await db
    .selectFrom('libraries')
    .select('id')
    .where('content_class', '=', 'restricted')
    .where('id', 'in', ctx.allowedLibraryIds)
    .execute();
  return rows.map((row) => row.id);
}

/**
 * Returns the restricted zone's aggregate, guard-consistent item count for
 * `ctx`, or `null` when `ctx` holds NO restricted-library entitlement at
 * all (this module's header) — the caller must turn `null` into a 404, NOT
 * `{ count: 0 }` (a zero count would itself let a restricted-profile
 * viewer infer "a zone exists with nothing in it", the exact side channel
 * U10 forbids). Only ever selects a COUNT aggregate — no title, artwork,
 * or id column is read here, by construction, so there is no code path
 * through this function that could leak zone content.
 */
export async function getRestrictedZoneCountForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext
): Promise<RestrictedZoneCount | null> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);

  if (restrictedLibraryIds.length === 0) {
    // Not entitled (gates 1-4 never all passed for this viewer) — the zone
    // does not exist for them, independent of ctx.restrictedCleared.
    return null;
  }

  const result = await applyNotMissingFilesFilter(
    db
      .selectFrom('catalog_items')
      .where('library_id', 'in', restrictedLibraryIds)
      .where('content_class', '=', 'restricted')
  )
    .select((eb) => eb.fn.countAll().as('count'))
    .executeTakeFirst();

  return { count: Number(result?.count ?? 0) };
}

// ============================================================================
// Restricted zone item listing (STATE.md Phosphor retheme W2 L8; design/
// phosphor/README.md "Interactions -> Restricted content"): the zone's OWN
// dedicated query surface, separate from listCatalogItems/searchCatalog so
// the zone's UI (search/genre/quality filters, all client-side over one
// fully-fetched page) never shares a code path with the general catalog.
//
// UNLIKE getRestrictedZoneCountForViewer above, this DOES route through
// applyGuard (ctx.restrictedCleared-gated content_class clause) — the zone's
// aggregate COUNT is deliberately visible while locked (U10), but the
// zone's actual ITEMS must not be, matching "opening a restricted item by
// any path while locked routes to PIN entry, never content" one level
// deeper than the client-side redirect: an entitled-but-locked caller of
// this function gets a real, guard-filtered EMPTY page (library membership
// passes, content_class = 'restricted' rows are excluded by the very same
// clause that hides them everywhere else while uncleared), never a 404
// (404 means "not entitled at all", a different, coarser signal — see
// resolveEntitledRestrictedLibraryIds above, computed BEFORE the guard
// runs, exactly like the count surface's own entitlement check).
//
// No sort/order params (contrast listCatalogItems): the zone is a small,
// curated collection by product design, and the client fetches it in full
// (paginating this cursor to completion) then sorts/searches/filters
// locally — see apps/web's zone hook. Keyset-paginated on
// (added_at_ms, id) both descending, the exact same cursor SHAPE
// src/query/items.ts's listItems uses (not shared code — a stale/foreign
// cursor decodes fine either way since the shape is identical, and the
// pagination direction is fixed, so there is no cross-endpoint cursor
// confusion risk worth guarding against here).

export interface RestrictedZoneItemQuality {
  is4k: boolean;
  hdr: HdrType;
}

export interface RestrictedZoneItemRow {
  id: string;
  libraryId: string;
  itemType: ItemType;
  title: string;
  sortTitle: string;
  year: number | null;
  communityRating: number | null;
  contentClass: 'restricted';
  addedAtMs: number;
  updatedAtMs: number;
  genres: string[];
  images: ImageDescriptor[];
  quality: RestrictedZoneItemQuality;
}

export interface ListRestrictedZoneItemsParams {
  cursor?: string;
  limit?: number;
}

export interface ListRestrictedZoneItemsResult {
  rows: RestrictedZoneItemRow[];
  nextCursor: string | null;
}

interface ZoneCursorPayload {
  addedAtMs: number;
  id: string;
}

function isZoneCursorPayload(value: unknown): value is ZoneCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['addedAtMs'] === 'number' &&
    typeof (value as Record<string, unknown>)['id'] === 'string'
  );
}

const DEFAULT_ZONE_LIMIT = 100;

/** Zone-local genre batch (mirrors catalog-detail.ts's own fetchGenresBatch
 *  exactly — that function is module-private to catalog-detail.ts, and this
 *  module already has its own defense-in-depth library re-lookup rather
 *  than importing across files, so a second small, self-contained copy
 *  here keeps that same posture rather than exporting a new cross-file
 *  seam for one caller). Same content_class join-isolation rule: a
 *  restricted item CAN carry a general-class tag (seed.mjs's 'Rare'
 *  fixture) and vice versa — applyContentClassFilter is still required
 *  even though the item itself is already guard-visible. */
async function fetchZoneGenresBatch(db: Kysely<DB>, ctx: ViewerContext, ids: string[]): Promise<Map<string, string[]>> {
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

/** Zone-local images batch (mirrors catalog-detail.ts's fetchImagesBatch —
 *  see fetchZoneGenresBatch's doc comment for why this is a second small
 *  copy rather than a cross-file export). No additional guard needed: every
 *  id passed in already came from a guard-filtered zone item query. */
async function fetchZoneImagesBatch(db: Kysely<DB>, ids: string[]): Promise<Map<string, ImageDescriptor[]>> {
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

const IS_4K_WIDTH_THRESHOLD = 3840;
const IS_4K_HEIGHT_THRESHOLD = 2160;

/** Per-item quality signal (4K/HDR filter chips) from each item's PRIMARY
 *  non-missing media file's PRIMARY (lowest stream_index) video stream —
 *  same "first non-missing file, first video stream" precedent
 *  catalog-detail.ts's fetchMediaFilesBatch/fetchEpisodeRuntimeBatch
 *  already establish. An item with no probed video stream yet (not
 *  scanned, or audio-only) gets the honest default { is4k: false, hdr:
 *  'none' } — "no evidence of 4K/HDR", never a fabricated signal. No guard
 *  needed beyond the caller's ids already being guard-visible (media_files/
 *  media_streams carry no title/metadata of their own). */
async function fetchZoneQualityBatch(db: Kysely<DB>, ids: string[]): Promise<Map<string, RestrictedZoneItemQuality>> {
  const map = new Map<string, RestrictedZoneItemQuality>();
  if (ids.length === 0) return map;

  const files = await db
    .selectFrom('media_files')
    .select(['id', 'item_id'])
    .where('item_id', 'in', ids)
    .where('missing_since_ms', 'is', null)
    .execute();
  if (files.length === 0) return map;

  const fileIds = files.map((f) => f.id);
  const videoStreams = await db
    .selectFrom('media_streams')
    .select(['file_id', 'width', 'height', 'hdr', 'stream_index'])
    .where('file_id', 'in', fileIds)
    .where('stream_type', '=', 'video')
    .orderBy('stream_index', 'asc')
    .execute();

  const primaryStreamByFile = new Map<string, { width: number | null; height: number | null; hdr: HdrType | null }>();
  for (const s of videoStreams) {
    if (!primaryStreamByFile.has(s.file_id)) {
      primaryStreamByFile.set(s.file_id, { width: s.width, height: s.height, hdr: s.hdr });
    }
  }

  for (const f of files) {
    if (map.has(f.item_id)) continue; // first non-missing file per item wins
    const stream = primaryStreamByFile.get(f.id);
    const is4k = (stream?.width ?? 0) >= IS_4K_WIDTH_THRESHOLD || (stream?.height ?? 0) >= IS_4K_HEIGHT_THRESHOLD;
    map.set(f.item_id, { is4k, hdr: stream?.hdr ?? 'none' });
  }
  return map;
}

/**
 * Lists the restricted zone's own items for `ctx` — `undefined` when `ctx`
 * holds no restricted-library entitlement at all (caller: 404, same
 * posture as getRestrictedZoneCountForViewer), otherwise a real
 * guard-filtered page (empty while locked, real content once unlocked —
 * see this section's header). Genres/images/quality are attached per row,
 * batched (never N+1).
 */
export async function listRestrictedZoneItemsForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListRestrictedZoneItemsParams = {}
): Promise<ListRestrictedZoneItemsResult | undefined> {
  const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(db, ctx);
  if (restrictedLibraryIds.length === 0) {
    return undefined;
  }

  const limit = params.limit ?? DEFAULT_ZONE_LIMIT;

  let query = applyGuard(db.selectFrom('catalog_items').selectAll(), ctx)
    .where('library_id', 'in', restrictedLibraryIds)
    // Top-level browsable types only (a restricted library's grid shows
    // movies/series, never their season/episode children) — mirrors what
    // itemType filter Browse's own listMovies/listSeries would apply.
    .where('item_type', 'in', ['movie', 'series']);

  if (params.cursor) {
    const { addedAtMs, id } = decodeCursor(params.cursor, isZoneCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('added_at_ms', '<', addedAtMs),
        eb.and([eb('added_at_ms', '=', addedAtMs), eb('id', '<', id)]),
      ])
    );
  }

  const rows = await query.orderBy('added_at_ms', 'desc').orderBy('id', 'desc').limit(limit).execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ addedAtMs: last.added_at_ms, id: last.id }) : null;

  const ids = rows.map((r) => r.id);
  const [genresMap, imagesMap, qualityMap] = await Promise.all([
    fetchZoneGenresBatch(db, ctx, ids),
    fetchZoneImagesBatch(db, ids),
    fetchZoneQualityBatch(db, ids),
  ]);

  const items: RestrictedZoneItemRow[] = rows.map((row) => ({
    id: row.id,
    libraryId: row.library_id,
    itemType: row.item_type,
    title: row.title,
    sortTitle: row.sort_title,
    year: row.year,
    communityRating: row.community_rating,
    contentClass: 'restricted',
    addedAtMs: row.added_at_ms,
    updatedAtMs: row.updated_at_ms,
    genres: genresMap.get(row.id) ?? [],
    images: imagesMap.get(row.id) ?? [],
    quality: qualityMap.get(row.id) ?? { is4k: false, hdr: 'none' },
  }));

  return { rows: items, nextCursor };
}
