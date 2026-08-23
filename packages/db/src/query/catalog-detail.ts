// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/catalog-detail.ts
//
// DECISION BEYOND SPEC (logged here since STATE.md is out of scope for this
// wave): the pre-existing public barrel only exposed getItemById/listItems,
// which return bare `catalog_items` rows (id/libraryId/itemType/title/
// sortTitle/year/communityRating/contentClass/addedAtMs/updatedAtMs) — no
// satellite-table fields (movie_details.overview, series_details.status,
// season_details.season_number, ...), no genres, no images, no parent-chain
// (series->season->episode / artist->album->track) resolution, and no
// libraryId/parentId list filter. The catalog-video/catalog-music
// controllers (apps/server) cannot assemble a contract-conformant
// Movie/Series/Season/Episode/Artist/Album/Track without exactly this data,
// and CLAUDE.md invariant 4 makes it a hard requirement that EVERY such read
// goes through packages/db/query with a ViewerContext — apps/server may not
// hold a raw Kysely handle to join movie_details itself. This file is the
// additive query surface that closes that gap, built entirely from the
// SAME guard primitives (applyGuard, applyContentClassFilter) every sibling
// query file already uses, so it cannot introduce a new leak class: every
// row it returns has already passed getItemById/a hand-rolled equivalent of
// listItems's own guard+keyset-cursor logic before any satellite/genre/image
// data is attached to it.
//
// Genres: item_tags/tags joined and ADDITIONALLY content_class-isolated via
// applyContentClassFilter on tags.content_class — mirrors search.ts's
// person/tag join rule exactly (a general item can carry a restricted-class
// tag per seed.mjs's 'Drama (restricted)'/'Rare' fixtures; that tag's name
// must not leak to an uncleared viewer just because the item itself is
// visible).
//
// Images: batched directly against the `images` table for entity_type =
// 'catalog_item' once the owning item's visibility is ALREADY established
// (every id passed to fetchImagesBatch came from a guard-filtered item
// query) — this intentionally does not re-run getImageEntityAccess's own
// visibility check per row (that would be a redundant N+1 guard re-check of
// something already proven true), matching the existing precedent of
// getContinueWatching/listProgress trusting applyGuardToJoined once rather
// than re-deriving visibility per satellite fetch.
//
// Parent-chain resolution (Episode.seriesId, Track.artistId): these are the
// GRANDPARENT of the row (episode -> season -> series; track -> album ->
// artist), not directly stored on catalog_items (which only has a single
// parent_id). Resolved via one small batched lookup of
// `catalog_items(id, parent_id)` for the distinct set of parent ids in a
// page — id/parent_id are not restricted-content-sensitive on their own
// (no title/metadata), and the child rows are already guard-visible, but for
// defense in depth the lookup is still scoped with applyGuard so a
// mis-linked child could never surface a hidden parent's id.

import { sql, type Kysely } from 'kysely';
import type { DB, ItemType } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyGuard } from './guard.js';
import { getItemById, type CatalogItemRow } from './items.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';
import { deriveHdrForDisplay, toAudioCodec, toBitDepth, toSubtitleCodec, toVideoCodec } from './media-info.js';

export interface ImageDescriptor {
  kind: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  /** '#rrggbb' or null (P2.11). NULL covers both "not yet computed" and the
   *  backfill's internal '' "unavailable" sentinel (migrations/0005) —
   *  callers never see that sentinel, only a real hex value or null; the
   *  UI applies its own neutral-warm fallback when null. */
  dominantColor: string | null;
}

/** item_people/people row, guard-joined on people.content_class (P1.21 —
 *  the SAME rule fetchGenresBatch already applies to tags: a general item
 *  can carry a restricted-class credit, e.g. seed.mjs's cross-listed
 *  people fixtures, and that person's name must not leak to an uncleared
 *  viewer just because the item itself is visible). `id` is the credited
 *  PERSON's id (people.id), not the item_people join-row id — matches the
 *  contract's PersonCredit.id, which links straight to GET /people/{id}. */
export interface PersonCredit {
  id: string;
  name: string;
  role: string;
  credit: string | null;
  order: number;
}

/** One media_streams audio row, for MediaFileSummary.audioTracks (Phosphor
 *  W2 L4 movie-detail METADATA "Audio" row — real per-file tracks, not a
 *  single derived summary string). */
export interface MediaFileAudioTrackSummary {
  codec: string;
  channels: number | null;
  language: string | null;
  isDefault: boolean;
}

/** One media_streams subtitle row, for MediaFileSummary.subtitleTracks
 *  (movie-detail METADATA "Subtitles" row). */
export interface MediaFileSubtitleTrackSummary {
  language: string | null;
  isForced: boolean;
}

/** One media_files row + its primary video stream's width/height
 *  (media_streams), for the version/edition picker (multi-version/
 *  multi-part items, §8.1) — deliverable D's "versions".
 *
 *  Phosphor W2 L4 (movie detail VERSIONS + METADATA cards) extended this
 *  additively: `path`, the primary video stream's codec/bitDepth/hdr, and
 *  every audio/subtitle stream on the file. All real, already-probed
 *  media_files/media_streams columns (P8.3) — nothing newly derived or
 *  invented; the "full house" contract-extension pattern (packages/contract/
 *  openapi.yaml's MediaFileSummary mirrors this 1:1). `isDefault` mirrors
 *  media-info.ts's resolvePrimaryFile() rule (the item's unlabelled file
 *  wins, else the lowest id) — media_files has no is_default COLUMN, so this
 *  is computed once per item's file list below, not read off a flag. */
export interface MediaFileSummary {
  id: string;
  versionLabel: string | null;
  container: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  durationMs: number | null;
  path: string;
  isDefault: boolean;
  videoCodec: string | null;
  bitDepth: 8 | 10 | 12 | null;
  hdr: string | null;
  audioTracks: MediaFileAudioTrackSummary[];
  subtitleTracks: MediaFileSubtitleTrackSummary[];
}

export interface CatalogDetail extends CatalogItemRow {
  genres: string[];
  images: ImageDescriptor[];
  // Satellite fields — only the ones relevant to the row's own item_type are
  // ever populated; every other field stays undefined (the controller layer
  // knows which fields a given itemType's contract schema needs).
  contentRating?: string | null;
  runtimeMs?: number | null;
  tagline?: string | null;
  overview?: string | null;
  status?: string | null;
  seasonNumber?: number;
  episodeNumber?: number;
  airedAtMs?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  durationMs?: number | null;
  /** Grandparent resolution — only set for item_type 'episode' (series id)
   *  and 'track' (artist id); see module header. */
  grandparentId?: string | null;
  /** Gap-closure lane (deliverable D): only populated (as an array, never
   *  undefined) by getCatalogDetail's single-item read for item types that
   *  carry credits in the contract (movie/series/episode/artist) — stays
   *  undefined (omitted on the wire) everywhere else, including every
   *  listCatalogItems row, to keep list-page cost unchanged (Tier-0). */
  people?: PersonCredit[];
  /** Same posture as `people` above, for item types the contract exposes
   *  mediaFiles on (movie/episode/track). */
  mediaFiles?: MediaFileSummary[];
}

/** Item types the contract's `people` field applies to (Movie/Series/
 *  Episode/Artist schemas — "+artist where sensible" per the gap-closure
 *  brief; season/album/track credits are not modeled in v1). */
const PEOPLE_ITEM_TYPES: ReadonlySet<ItemType> = new Set(['movie', 'series', 'episode', 'artist']);

/** Item types the contract's `mediaFiles` field applies to (Movie/Episode/
 *  Track schemas — the leaf item types that actually own media_files rows). */
const MEDIA_FILES_ITEM_TYPES: ReadonlySet<ItemType> = new Set(['movie', 'episode', 'track']);

type Satellite = Pick<
  CatalogDetail,
  | 'contentRating'
  | 'runtimeMs'
  | 'tagline'
  | 'overview'
  | 'status'
  | 'seasonNumber'
  | 'episodeNumber'
  | 'airedAtMs'
  | 'trackNumber'
  | 'discNumber'
  | 'durationMs'
>;

/**
 * Episode has no runtime column of its own anywhere (episode_details lacks
 * one — 0001_init.sql/0002_phase1_catalog.sql) — STATE.md P1.23: "episode
 * ... runtime derives at read time from media_files.duration_ms". Movie and
 * Track both DO have a stored runtime/duration column on their own
 * satellite table (movie_details.runtime_ms, track_details.duration_ms,
 * copied in by the scanner/probe writer at ingest) and use that directly —
 * this helper is Episode-only. One media_files row per item in the common
 * case; if a re-encode/multi-version item somehow has more than one, the
 * first non-missing row wins (arbitrary but deterministic per query, same
 * "good enough for Phase 1" tradeoff already accepted elsewhere in this
 * file for N+1-avoidance batching).
 */
async function fetchEpisodeRuntimeBatch(db: Kysely<DB>, ids: string[]): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (ids.length === 0) return map;

  const rows = await db
    .selectFrom('media_files')
    .select(['item_id', 'duration_ms'])
    .where('item_id', 'in', ids)
    .where('missing_since_ms', 'is', null)
    .execute();

  for (const row of rows) {
    if (!map.has(row.item_id)) {
      map.set(row.item_id, row.duration_ms);
    }
  }
  return map;
}

async function fetchGenresBatch(
  db: Kysely<DB>,
  ctx: ViewerContext,
  ids: string[]
): Promise<Map<string, string[]>> {
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

async function fetchImagesBatch(db: Kysely<DB>, ids: string[]): Promise<Map<string, ImageDescriptor[]>> {
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
    // '' is the backfill's internal "unavailable" sentinel (migrations/0005)
    // — collapse it to null here, same as a genuine NULL.
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

async function fetchSatelliteBatch(
  db: Kysely<DB>,
  itemType: ItemType,
  ids: string[]
): Promise<Map<string, Satellite>> {
  const map = new Map<string, Satellite>();
  if (ids.length === 0) return map;

  switch (itemType) {
    case 'movie': {
      const rows = await db
        .selectFrom('movie_details')
        .select(['item_id', 'content_rating', 'runtime_ms', 'tagline', 'overview'])
        .where('item_id', 'in', ids)
        .execute();
      for (const r of rows) {
        map.set(r.item_id, {
          contentRating: r.content_rating,
          runtimeMs: r.runtime_ms,
          tagline: r.tagline,
          overview: r.overview,
        });
      }
      return map;
    }
    case 'series': {
      const rows = await db
        .selectFrom('series_details')
        .select(['item_id', 'content_rating', 'status', 'overview'])
        .where('item_id', 'in', ids)
        .execute();
      for (const r of rows) {
        map.set(r.item_id, { contentRating: r.content_rating, status: r.status, overview: r.overview });
      }
      return map;
    }
    case 'season': {
      const rows = await db
        .selectFrom('season_details')
        .select(['item_id', 'season_number'])
        .where('item_id', 'in', ids)
        .execute();
      for (const r of rows) {
        map.set(r.item_id, { seasonNumber: r.season_number });
      }
      return map;
    }
    case 'episode': {
      const rows = await db
        .selectFrom('episode_details')
        .select(['item_id', 'episode_number', 'aired_at_ms', 'overview'])
        .where('item_id', 'in', ids)
        .execute();
      for (const r of rows) {
        map.set(r.item_id, { episodeNumber: r.episode_number, airedAtMs: r.aired_at_ms, overview: r.overview });
      }
      return map;
    }
    case 'artist': {
      const rows = await db
        .selectFrom('artist_details')
        .select(['item_id', 'overview'])
        .where('item_id', 'in', ids)
        .execute();
      for (const r of rows) {
        map.set(r.item_id, { overview: r.overview });
      }
      return map;
    }
    case 'album': {
      // No album-specific satellite fields the contract needs beyond what
      // catalog_items already carries (year) — album_details.year is a
      // scan-time duplicate of it, not a separate contract field.
      return map;
    }
    case 'track': {
      const rows = await db
        .selectFrom('track_details')
        .select(['item_id', 'track_number', 'disc_number', 'duration_ms'])
        .where('item_id', 'in', ids)
        .execute();
      for (const r of rows) {
        map.set(r.item_id, { trackNumber: r.track_number, discNumber: r.disc_number, durationMs: r.duration_ms });
      }
      return map;
    }
  }
}

/** Guard-joined item_people/people batch, ordered by item_people.ord within
 *  each item (see PersonCredit's doc comment for the content_class rule). */
async function fetchPeopleBatch(
  db: Kysely<DB>,
  ctx: ViewerContext,
  ids: string[]
): Promise<Map<string, PersonCredit[]>> {
  const map = new Map<string, PersonCredit[]>();
  if (ids.length === 0) return map;

  const rows = await applyContentClassFilter(
    db
      .selectFrom('item_people')
      .innerJoin('people', 'people.id', 'item_people.person_id')
      .select([
        'item_people.item_id as itemId',
        'people.id as personId',
        'people.name as name',
        'item_people.role as role',
        'item_people.credit as credit',
        'item_people.ord as ord',
      ])
      .where('item_people.item_id', 'in', ids),
    ctx,
    'people.content_class'
  )
    .orderBy('item_people.ord', 'asc')
    .execute();

  for (const row of rows) {
    const arr = map.get(row.itemId) ?? [];
    arr.push({ id: row.personId, name: row.name, role: row.role, credit: row.credit, order: row.ord });
    map.set(row.itemId, arr);
  }
  return map;
}

/** Batched media_files + each file's primary (lowest stream_index) video
 *  stream (width/height/codec/bitDepth/hdr) and every audio/subtitle stream.
 *  Missing files (missing_since_ms set) are excluded — same "hidden while
 *  fileless" posture as everywhere else in this package (P1.2). No guard
 *  needed beyond the caller's item already being guard-visible: a
 *  media_files row carries no title/metadata of its own, only file-level
 *  facts already implied by the (already-guarded) item — that includes
 *  `path`: it's a filesystem location, not catalog metadata, and every
 *  existing caller of this batch (getMovie/getEpisode/getTrack) already
 *  requires the viewer to see the owning item. */
async function fetchMediaFilesBatch(db: Kysely<DB>, ids: string[]): Promise<Map<string, MediaFileSummary[]>> {
  const map = new Map<string, MediaFileSummary[]>();
  if (ids.length === 0) return map;

  const files = await db
    .selectFrom('media_files')
    .select(['id', 'item_id', 'version_label', 'container', 'size_bytes', 'duration_ms', 'path'])
    .where('item_id', 'in', ids)
    .where('missing_since_ms', 'is', null)
    .orderBy('id', 'asc')
    .execute();
  if (files.length === 0) return map;

  const fileIds = files.map((f) => f.id);
  const streams = await db
    .selectFrom('media_streams')
    .select([
      'file_id',
      'stream_type',
      'stream_index',
      'width',
      'height',
      'codec',
      'bit_depth',
      'hdr',
      // browser-items-F6: deriveHdrForDisplay() (media-info.ts) needs the
      // raw color_transfer to fall back on when hdr itself is NULL — see
      // its doc comment for why this can't just re-trust `hdr`.
      'color_transfer',
      'channels',
      'language',
      'is_default',
      'is_forced',
    ])
    .where('file_id', 'in', fileIds)
    .orderBy('stream_index', 'asc')
    .execute();

  interface PrimaryVideo {
    width: number | null;
    height: number | null;
    codec: string | null;
    bitDepth: number | null;
    hdr: string | null;
    colorTransfer: string | null;
  }
  const videoByFile = new Map<string, PrimaryVideo>();
  const audioByFile = new Map<string, MediaFileAudioTrackSummary[]>();
  const subtitleByFile = new Map<string, MediaFileSubtitleTrackSummary[]>();

  for (const s of streams) {
    if (s.stream_type === 'video') {
      // Lowest stream_index wins (query is already stream_index-ordered) —
      // same "first non-missing/first-seen" tiebreak the old width/height-
      // only version of this loop used.
      if (!videoByFile.has(s.file_id)) {
        videoByFile.set(s.file_id, {
          width: s.width,
          height: s.height,
          codec: s.codec,
          bitDepth: s.bit_depth,
          hdr: s.hdr,
          colorTransfer: s.color_transfer,
        });
      }
    } else if (s.stream_type === 'audio') {
      const arr = audioByFile.get(s.file_id) ?? [];
      arr.push({ codec: toAudioCodec(s.codec), channels: s.channels, language: s.language, isDefault: s.is_default });
      audioByFile.set(s.file_id, arr);
    } else if (s.stream_type === 'subtitle') {
      const arr = subtitleByFile.get(s.file_id) ?? [];
      arr.push({ language: s.language, isForced: s.is_forced });
      subtitleByFile.set(s.file_id, arr);
    }
  }

  // Default-file resolution mirrors media-info.ts's resolvePrimaryFile: the
  // unlabelled row wins if present among an item's (non-missing) files, else
  // the lowest id (the query above is already id-ascending, i.e.
  // earliest-ingested-first) — media_files has no is_default COLUMN, so this
  // is the same convention-not-column rule used to pick a playback default.
  const filesByItem = new Map<string, typeof files>();
  for (const f of files) {
    const arr = filesByItem.get(f.item_id) ?? [];
    arr.push(f);
    filesByItem.set(f.item_id, arr);
  }
  const defaultFileIdByItem = new Map<string, string>();
  for (const [itemId, itemFiles] of filesByItem) {
    const unlabelled = itemFiles.find((f) => f.version_label === null);
    defaultFileIdByItem.set(itemId, (unlabelled ?? itemFiles[0]!).id);
  }

  for (const f of files) {
    const video = videoByFile.get(f.id);
    const arr = map.get(f.item_id) ?? [];
    arr.push({
      id: f.id,
      versionLabel: f.version_label,
      container: f.container,
      width: video?.width ?? null,
      height: video?.height ?? null,
      sizeBytes: f.size_bytes,
      durationMs: f.duration_ms,
      path: f.path,
      isDefault: defaultFileIdByItem.get(f.item_id) === f.id,
      videoCodec: video ? toVideoCodec(video.codec) : null,
      bitDepth: video ? toBitDepth(video.bitDepth) : null,
      // browser-items-F6: deriveHdrForDisplay (not toHdr) — falls back to
      // color_transfer when the stored hdr column is NULL, so an
      // unset-but-probed-PQ stream renders "HDR10" instead of a
      // fabricated-confident "SDR". See its doc comment (media-info.ts).
      hdr: video ? deriveHdrForDisplay(video.hdr, video.colorTransfer) : null,
      audioTracks: audioByFile.get(f.id) ?? [],
      subtitleTracks: subtitleByFile.get(f.id) ?? [],
    });
    map.set(f.item_id, arr);
  }
  return map;
}

/** Grandparent (parent-of-parent) id lookup for episode->series / track->artist,
 *  scoped by applyGuard for defense in depth (see module header). */
async function fetchGrandparentBatch(
  db: Kysely<DB>,
  ctx: ViewerContext,
  parentIds: string[]
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (parentIds.length === 0) return map;

  const rows = await applyGuard(
    db.selectFrom('catalog_items').select(['id', 'parent_id']),
    ctx
  )
    .where('id', 'in', parentIds)
    .execute();

  for (const r of rows) {
    map.set(r.id, r.parent_id);
  }
  return map;
}

async function attachDetails(
  db: Kysely<DB>,
  ctx: ViewerContext,
  itemType: ItemType,
  rows: CatalogItemRow[],
  /** Gap-closure lane: true only from getCatalogDetail (the single-item
   *  GET) — listCatalogItems never sets this, so `people`/`mediaFiles`
   *  stay undefined (omitted on the wire) on every list/page response. */
  includeDetail = false
): Promise<CatalogDetail[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const wantsPeople = includeDetail && PEOPLE_ITEM_TYPES.has(itemType);
  const wantsMediaFiles = includeDetail && MEDIA_FILES_ITEM_TYPES.has(itemType);

  const [genresMap, imagesMap, satMap, episodeRuntimeMap, peopleMap, mediaFilesMap] = await Promise.all([
    fetchGenresBatch(db, ctx, ids),
    fetchImagesBatch(db, ids),
    fetchSatelliteBatch(db, itemType, ids),
    itemType === 'episode' ? fetchEpisodeRuntimeBatch(db, ids) : Promise.resolve(new Map<string, number | null>()),
    wantsPeople ? fetchPeopleBatch(db, ctx, ids) : Promise.resolve(new Map<string, PersonCredit[]>()),
    wantsMediaFiles ? fetchMediaFilesBatch(db, ids) : Promise.resolve(new Map<string, MediaFileSummary[]>()),
  ]);

  let grandparentMap = new Map<string, string | null>();
  if (itemType === 'episode' || itemType === 'track') {
    const parentIds = [...new Set(rows.map((r) => r.parent_id).filter((id): id is string => id !== null))];
    grandparentMap = await fetchGrandparentBatch(db, ctx, parentIds);
  }

  return rows.map((row) => ({
    ...row,
    genres: genresMap.get(row.id) ?? [],
    images: imagesMap.get(row.id) ?? [],
    ...(satMap.get(row.id) ?? {}),
    ...(itemType === 'episode' ? { runtimeMs: episodeRuntimeMap.get(row.id) ?? null } : {}),
    ...(row.parent_id !== null && grandparentMap.has(row.parent_id)
      ? { grandparentId: grandparentMap.get(row.parent_id) ?? null }
      : {}),
    ...(wantsPeople ? { people: peopleMap.get(row.id) ?? [] } : {}),
    ...(wantsMediaFiles ? { mediaFiles: mediaFilesMap.get(row.id) ?? [] } : {}),
  }));
}

export interface GetCatalogDetailOptions {
  /** Gap-closure lane (deliverable D): attach people[]/mediaFiles[]
   *  (fetchPeopleBatch/fetchMediaFilesBatch) for the item types the
   *  contract exposes them on. Defaults to FALSE — several existing
   *  callers (cross-type.controller.ts's search/continue-watching/
   *  recently-added rows, data-freedom.controller.ts's export) already
   *  call getCatalogDetail once PER ROW of what is semantically a list
   *  surface, not a single-item detail page; defaulting this on would
   *  silently add a people/mediaFiles join to every one of those rows
   *  (Tier-0 cost regression) even though nothing asked for it there.
   *  Only apps/server's true single-item GET handlers (getMovie/
   *  getSeries/getEpisode/getArtist/getTrack) opt in explicitly. */
  includeDetail?: boolean;
}

export async function getCatalogDetail(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string,
  options: GetCatalogDetailOptions = {}
): Promise<CatalogDetail | undefined> {
  const item = await getItemById(db, ctx, id);
  if (!item) return undefined;
  const [detail] = await attachDetails(db, ctx, item.item_type, [item], options.includeDetail ?? false);
  return detail;
}

// ============================================================================
// Sort (gap-closure lane: browse Sort control, additive `sort`/`order`
// query params — packages/contract/openapi.yaml's Sort/Order parameters).
// ============================================================================

export type ListCatalogItemsSort = 'title' | 'added' | 'rating' | 'year';
export type ListCatalogItemsOrder = 'asc' | 'desc';

/** `order`'s default depends on which sort is active — alphabetical sorts
 *  naturally read A→Z (asc); recency/rating/year sorts naturally read
 *  newest/highest first (desc). Matches the contract's Sort parameter
 *  description verbatim. */
const DEFAULT_ORDER_BY_SORT: Record<ListCatalogItemsSort, ListCatalogItemsOrder> = {
  title: 'asc',
  added: 'desc',
  rating: 'desc',
  year: 'desc',
};

// community_rating/year are nullable columns with no CHECK constraint,
// but real values never approach these bounds (rating is contract-bounded
// [0,10]; year is scan/provider-derived, realistically 1880-2100) — used
// to push NULLs to the end of the result set regardless of sort direction
// (product decision: unrated/undated items sort last, never interleaved
// with real values, matching what a Sort control's user expects). This is
// a documented convention, not a DB-enforced one.
const RATING_LOW_SENTINEL = -1;
const RATING_HIGH_SENTINEL = 11;
const YEAR_LOW_SENTINEL = -1;
const YEAR_HIGH_SENTINEL = 9999;

/** The ONE place the ORDER BY expression, the cursor's encoded sortKey
 *  value, and the cursor's keyset WHERE comparison all derive from — so
 *  they can never drift apart per sort. `title`/`added` map straight to a
 *  NOT NULL column; `rating`/`year` are the nullable columns wrapped in
 *  the sentinel-COALESCE above. */
function sortKeyExpr(sort: ListCatalogItemsSort, order: ListCatalogItemsOrder) {
  switch (sort) {
    case 'title':
      return sql<string>`catalog_items.sort_title`;
    case 'added':
      return sql<number>`catalog_items.added_at_ms`;
    case 'rating':
      return sql<number>`COALESCE(catalog_items.community_rating, ${
        order === 'desc' ? RATING_LOW_SENTINEL : RATING_HIGH_SENTINEL
      })`;
    case 'year':
      return sql<number>`COALESCE(catalog_items.year, ${
        order === 'desc' ? YEAR_LOW_SENTINEL : YEAR_HIGH_SENTINEL
      })`;
  }
}

export interface ListCatalogItemsParams {
  itemType: ItemType;
  /** Restricts to direct children of this item (seasons of a series,
   *  episodes of a season, albums of an artist, tracks of an album). */
  parentId?: string;
  libraryId?: string;
  cursor?: string;
  limit?: number;
  /** Defaults to 'added' (the pre-existing, unchanged default behavior). */
  sort?: ListCatalogItemsSort;
  /** Defaults per-sort — see DEFAULT_ORDER_BY_SORT. */
  order?: ListCatalogItemsOrder;
}

export interface ListCatalogItemsResult {
  rows: CatalogDetail[];
  nextCursor: string | null;
}

/** A cursor is only valid for the EXACT (sort, order) pair it was issued
 *  under — carrying both in the payload lets a stale/mismatched cursor
 *  (e.g. the client changed the Sort control mid-pagination) fail
 *  decodeCursor's shape check loudly rather than silently paginating a
 *  now-nonsensical keyset. */
interface ListCursorPayload {
  sort: ListCatalogItemsSort;
  order: ListCatalogItemsOrder;
  sortKey: string | number;
  id: string;
}

const VALID_SORTS: ReadonlySet<string> = new Set<ListCatalogItemsSort>(['title', 'added', 'rating', 'year']);
const VALID_ORDERS: ReadonlySet<string> = new Set<ListCatalogItemsOrder>(['asc', 'desc']);

/** Postgres's own `uuid` input format (RFC 4122 8-4-4-4-12 hex, any
 *  version/variant octet) — the same pattern apps/server's
 *  gateway/require-uuid-param.ts applies to :id PATH params, repeated here
 *  because `parentId`/`libraryId`/a cursor's `id` reach this function as
 *  QUERY input, which that helper never sees. Binding a non-UUID string
 *  into a `uuid` column comparison makes Postgres throw 22P02 (invalid
 *  input syntax for type uuid) — a raw 500 with an unhandled_exception log
 *  line for what is a client input mistake. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isListCursorPayload(
  value: unknown,
  activeSort: ListCatalogItemsSort,
  activeOrder: ListCatalogItemsOrder
): value is ListCursorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isCursorRowId(v.id)) return false;
  if (typeof v.sort !== 'string' || !VALID_SORTS.has(v.sort)) return false;
  if (typeof v.order !== 'string' || !VALID_ORDERS.has(v.order)) return false;
  if (v.sort !== activeSort || v.order !== activeOrder) return false;
  return v.sort === 'title' ? typeof v.sortKey === 'string' : typeof v.sortKey === 'number';
}

const DEFAULT_LIMIT = 50;

/**
 * The itemType/parentId/libraryId-filterable analogue of listItems (see
 * module header for why this is a separate, self-contained implementation
 * rather than an edit to src/query/items.ts) — same guard, keyset
 * pagination on (sortKey, id) both in the SAME direction, with satellite/
 * genre/image data attached per row. `sort`/`order` (gap-closure lane) pick
 * which column drives the keyset — see sortKeyExpr above.
 */
export async function listCatalogItems(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListCatalogItemsParams
): Promise<ListCatalogItemsResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const sort = params.sort ?? 'added';
  const order = params.order ?? DEFAULT_ORDER_BY_SORT[sort];
  const keyExpr = sortKeyExpr(sort, order);
  const cmp = order === 'desc' ? '<' : '>';

  // A malformed filter id can never match a row, so it answers exactly the
  // way a syntactically valid but nonexistent/unentitled one already does —
  // an empty page ("invisible == nonexistent") — rather than reaching
  // Postgres's uuid cast (see UUID_PATTERN above). Dropping the filter
  // instead would silently WIDEN the result set to the whole library set.
  if (
    (params.parentId && !UUID_PATTERN.test(params.parentId)) ||
    (params.libraryId && !UUID_PATTERN.test(params.libraryId))
  ) {
    return { rows: [], nextCursor: null };
  }

  let query = applyGuard(db.selectFrom('catalog_items').selectAll(), ctx).where(
    'item_type',
    '=',
    params.itemType
  );

  if (params.parentId) {
    query = query.where('parent_id', '=', params.parentId);
  }
  if (params.libraryId) {
    query = query.where('library_id', '=', params.libraryId);
  }

  if (params.cursor) {
    const { sortKey, id } = decodeCursor(params.cursor, (v): v is ListCursorPayload =>
      isListCursorPayload(v, sort, order)
    );
    // ROW-comparison keyset, not the classic `k < v OR (k = v AND id < i)`
    // OR-form: both are semantically identical for same-direction keys, but
    // Postgres can only push a row comparison into an Index Cond (a direct
    // b-tree seek to the cursor position). The OR-form is applied as a
    // per-row Filter, so every deep page re-walked the whole prefix — at the
    // 50k seed that meant page N skipped N×limit rows and the ENFORCING CI
    // perf job measured browse p95 at 209ms (budget 100ms). With ROW(): an
    // index seek, 0.06ms flat regardless of page depth (EXPLAIN-verified
    // against migration 0009's composite keyset indexes).
    query = query.where(
      sql<boolean>`(${keyExpr}, catalog_items.id) ${sql.raw(cmp)} (${sortKey}, ${id})`
    );
  }

  const rows = await query
    .orderBy(keyExpr, order)
    .orderBy('id', order)
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
          : (last?.year ?? (order === 'desc' ? YEAR_LOW_SENTINEL : YEAR_HIGH_SENTINEL));
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor({ sort, order, sortKey: lastSortKey as string | number, id: last.id })
      : null;

  const detailRows = await attachDetails(db, ctx, params.itemType, rows);
  return { rows: detailRows, nextCursor };
}
