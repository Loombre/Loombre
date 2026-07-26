// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Find-or-create catalog hierarchy resolution (docs/PLAN.md §8.1's "find
 * or create item hierarchy via internal writers: series→season→episode;
 * artist→album→track; movie"). Pure orchestration over the natural-key
 * finders + upsert writers @loombre/db/internal exports — this module
 * itself never touches kysely/pg directly (dependency-cruiser forbids that
 * outside packages/db; @loombre/db/internal is the allowed door, same
 * pattern packages/jobs/src/ledger.ts already uses).
 *
 * Every resolver reports `isNew` so the caller (./scanner.ts) knows whether
 * to emit `item.added` (freshly created row) or fold the resolution into an
 * `item.updated` (an existing item gaining a new/relocated file) — this
 * module never writes events itself, only catalog_items/satellite rows, so
 * event-emission stays co-located with the transaction boundary in
 * scanner.ts (docs/PLAN.md §4.3's outbox-in-the-same-tx rule).
 */
import {
  findMovieByTitleYear,
  findSeriesByTitle,
  findSeasonByNumber,
  findEpisodeByNumber,
  findArtistByName,
  findAlbumByTitle,
  findTrackByNumberOrTitle,
  upsertCatalogItem,
  upsertSatellite,
  type DbOrTx,
  type CatalogItemRow,
} from "@loombre/db/internal";

export interface ResolvedItem {
  item: CatalogItemRow;
  isNew: boolean;
}

/** Deterministic, dependency-free sort-title derivation: lowercased,
 * whitespace-trimmed. No article-stripping ("The", "A") — kept simple and
 * documented rather than guessing at a locale-specific convention the spec
 * doesn't prescribe. */
export function toSortTitle(title: string): string {
  return title.trim().toLowerCase();
}

export async function resolveMovieItem(
  db: DbOrTx,
  params: { libraryId: string; title: string; year: number | null; nowMs: number }
): Promise<ResolvedItem> {
  const existing = await findMovieByTitleYear(db, {
    libraryId: params.libraryId,
    title: params.title,
    year: params.year,
  });
  if (existing) return { item: existing, isNew: false };

  const item = await upsertCatalogItem(db, {
    libraryId: params.libraryId,
    itemType: "movie",
    title: params.title,
    sortTitle: toSortTitle(params.title),
    year: params.year,
    addedAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
  });
  await upsertSatellite(db, {
    itemType: "movie",
    item_id: item.id,
    content_rating: null,
    runtime_ms: null,
    tagline: null,
    overview: null,
  });
  return { item, isNew: true };
}

export interface ResolveEpisodeParams {
  libraryId: string;
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  nowMs: number;
}

export interface ResolvedEpisodeHierarchy {
  series: ResolvedItem;
  season: ResolvedItem;
  episode: ResolvedItem;
}

export async function resolveEpisodeItem(
  db: DbOrTx,
  params: ResolveEpisodeParams
): Promise<ResolvedEpisodeHierarchy> {
  let series = await findSeriesByTitle(db, params.libraryId, params.seriesTitle);
  let seriesIsNew = false;
  if (!series) {
    series = await upsertCatalogItem(db, {
      libraryId: params.libraryId,
      itemType: "series",
      title: params.seriesTitle,
      sortTitle: toSortTitle(params.seriesTitle),
      addedAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
    });
    await upsertSatellite(db, {
      itemType: "series",
      item_id: series.id,
      content_rating: null,
      status: null,
      overview: null,
    });
    seriesIsNew = true;
  }

  const seasonTitle = `Season ${params.seasonNumber}`;
  let season = await findSeasonByNumber(db, series.id, params.seasonNumber);
  let seasonIsNew = false;
  if (!season) {
    season = await upsertCatalogItem(db, {
      libraryId: params.libraryId,
      itemType: "season",
      parentId: series.id,
      title: seasonTitle,
      sortTitle: toSortTitle(seasonTitle),
      addedAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
    });
    await upsertSatellite(db, {
      itemType: "season",
      item_id: season.id,
      season_number: params.seasonNumber,
    });
    seasonIsNew = true;
  }

  const episodeTitle = params.episodeTitle ?? `Episode ${params.episodeNumber}`;
  let episode = await findEpisodeByNumber(db, season.id, params.episodeNumber);
  let episodeIsNew = false;
  if (!episode) {
    episode = await upsertCatalogItem(db, {
      libraryId: params.libraryId,
      itemType: "episode",
      parentId: season.id,
      title: episodeTitle,
      sortTitle: toSortTitle(episodeTitle),
      addedAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
    });
    await upsertSatellite(db, {
      itemType: "episode",
      item_id: episode.id,
      episode_number: params.episodeNumber,
      aired_at_ms: null,
      overview: null,
    });
    episodeIsNew = true;
  }

  return {
    series: { item: series, isNew: seriesIsNew },
    season: { item: season, isNew: seasonIsNew },
    episode: { item: episode, isNew: episodeIsNew },
  };
}

export interface ResolveTrackParams {
  libraryId: string;
  artistName: string;
  /** null falls back to a per-artist "Unknown Album" bucket (see module
   *  docstring / scanner.ts callers) — a track always lives under an album
   *  layer in this schema (D9's item_type set has no bare artist->track
   *  edge), so untagged/unparsed album info still needs SOME album item. */
  albumTitle: string | null;
  albumYear: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  title: string;
  nowMs: number;
}

export interface ResolvedTrackHierarchy {
  artist: ResolvedItem;
  album: ResolvedItem;
  track: ResolvedItem;
}

const UNKNOWN_ALBUM_TITLE = "Unknown Album";

export async function resolveTrackItem(
  db: DbOrTx,
  params: ResolveTrackParams
): Promise<ResolvedTrackHierarchy> {
  let artist = await findArtistByName(db, params.libraryId, params.artistName);
  let artistIsNew = false;
  if (!artist) {
    artist = await upsertCatalogItem(db, {
      libraryId: params.libraryId,
      itemType: "artist",
      title: params.artistName,
      sortTitle: toSortTitle(params.artistName),
      addedAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
    });
    await upsertSatellite(db, { itemType: "artist", item_id: artist.id, overview: null });
    artistIsNew = true;
  }

  const albumTitle = params.albumTitle ?? UNKNOWN_ALBUM_TITLE;
  let album = await findAlbumByTitle(db, artist.id, albumTitle);
  let albumIsNew = false;
  if (!album) {
    album = await upsertCatalogItem(db, {
      libraryId: params.libraryId,
      itemType: "album",
      parentId: artist.id,
      title: albumTitle,
      sortTitle: toSortTitle(albumTitle),
      year: params.albumYear,
      addedAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
    });
    await upsertSatellite(db, { itemType: "album", item_id: album.id, year: params.albumYear });
    albumIsNew = true;
  }

  let track = await findTrackByNumberOrTitle(db, album.id, {
    trackNumber: params.trackNumber,
    title: params.title,
  });
  let trackIsNew = false;
  if (!track) {
    track = await upsertCatalogItem(db, {
      libraryId: params.libraryId,
      itemType: "track",
      parentId: album.id,
      title: params.title,
      sortTitle: toSortTitle(params.title),
      addedAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
    });
    await upsertSatellite(db, {
      itemType: "track",
      item_id: track.id,
      track_number: params.trackNumber,
      disc_number: params.discNumber,
      duration_ms: null,
    });
    trackIsNew = true;
  }

  return {
    artist: { item: artist, isNew: artistIsNew },
    album: { item: album, isNew: albumIsNew },
    track: { item: track, isNew: trackIsNew },
  };
}
