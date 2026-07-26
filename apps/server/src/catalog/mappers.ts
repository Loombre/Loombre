// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/mappers.ts
//
// Maps @loombre/db's CatalogDetail (guarded DB row + satellite fields +
// genres + images, see packages/db/src/query/catalog-detail.ts) to the
// exact contract shapes (packages/contract/openapi.yaml's Movie/Series/
// Season/Episode/Artist/Album/Track schemas, all `unevaluatedProperties:
// false` — every field these functions omit or mis-name fails Ajv
// validation in the conformance suite). One function per item type, plus a
// shared CatalogItemBase spread so the eight required base fields
// (id/libraryId/itemType/title/sortTitle/year/communityRating/contentClass/
// addedAtMs/updatedAtMs) can never drift between types.

import type { CatalogDetail, ItemType } from "@loombre/db";

function base(d: CatalogDetail) {
  return {
    id: d.id,
    libraryId: d.library_id,
    title: d.title,
    sortTitle: d.sort_title,
    year: d.year,
    communityRating: d.community_rating,
    contentClass: d.content_class,
    addedAtMs: d.added_at_ms,
    updatedAtMs: d.updated_at_ms,
  };
}

/** Gap-closure lane (deliverable D): CatalogDetail.people/mediaFiles are
 *  `undefined` (not an empty array) everywhere EXCEPT the single-item GET
 *  path (packages/db/src/query/catalog-detail.ts's includeDetail param) —
 *  spreading a mapped array only when the source field is actually present
 *  lets list responses omit the key entirely, matching the contract's
 *  "absent on list responses" field descriptions rather than sending an
 *  always-empty array. */
function peopleField(d: CatalogDetail) {
  return d.people !== undefined ? { people: d.people } : {};
}
function mediaFilesField(d: CatalogDetail) {
  return d.mediaFiles !== undefined ? { mediaFiles: d.mediaFiles } : {};
}

export function mapMovie(d: CatalogDetail) {
  return {
    ...base(d),
    itemType: "movie" as const,
    contentRating: d.contentRating ?? null,
    runtimeMs: d.runtimeMs ?? null,
    overview: d.overview ?? null,
    tagline: d.tagline ?? null,
    genres: d.genres,
    images: d.images,
    ...peopleField(d),
    ...mediaFilesField(d),
  };
}

export function mapSeries(d: CatalogDetail) {
  return {
    ...base(d),
    itemType: "series" as const,
    contentRating: d.contentRating ?? null,
    overview: d.overview ?? null,
    status: d.status ?? null,
    genres: d.genres,
    images: d.images,
    ...peopleField(d),
  };
}

export function mapSeason(d: CatalogDetail) {
  return {
    ...base(d),
    itemType: "season" as const,
    seriesId: d.parent_id,
    seasonNumber: d.seasonNumber ?? 0,
    images: d.images,
  };
}

export function mapEpisode(d: CatalogDetail) {
  return {
    ...base(d),
    itemType: "episode" as const,
    seasonId: d.parent_id,
    seriesId: d.grandparentId ?? null,
    episodeNumber: d.episodeNumber ?? 0,
    runtimeMs: d.runtimeMs ?? null,
    overview: d.overview ?? null,
    airDateMs: d.airedAtMs ?? null,
    images: d.images,
    ...peopleField(d),
    ...mediaFilesField(d),
  };
}

export function mapArtist(d: CatalogDetail) {
  return {
    ...base(d),
    itemType: "artist" as const,
    overview: d.overview ?? null,
    genres: d.genres,
    images: d.images,
    ...peopleField(d),
  };
}

export function mapAlbum(d: CatalogDetail) {
  return {
    ...base(d),
    itemType: "album" as const,
    artistId: d.parent_id,
    genres: d.genres,
    images: d.images,
  };
}

export function mapTrack(d: CatalogDetail) {
  return {
    ...base(d),
    itemType: "track" as const,
    albumId: d.parent_id,
    artistId: d.grandparentId ?? null,
    trackNumber: d.trackNumber ?? null,
    discNumber: d.discNumber ?? null,
    durationMs: d.durationMs ?? null,
    images: d.images,
    ...mediaFilesField(d),
  };
}

/** Dispatches to the right mapXxx() by itemType — shared by every
 *  controller that needs to embed a full discriminated item object
 *  (cross-type search/home rows, data-freedom export). */
export function mapByType(itemType: ItemType, detail: CatalogDetail) {
  switch (itemType) {
    case "movie":
      return mapMovie(detail);
    case "series":
      return mapSeries(detail);
    case "season":
      return mapSeason(detail);
    case "episode":
      return mapEpisode(detail);
    case "artist":
      return mapArtist(detail);
    case "album":
      return mapAlbum(detail);
    case "track":
      return mapTrack(detail);
  }
}
