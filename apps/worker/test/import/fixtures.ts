// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/import/fixtures.ts
//
// Minimal, hand-built ExportArchive fixtures for the import consumer's unit
// suite (validate.spec.ts / consumer.spec.ts) — shaped exactly like a real
// GET /export response (packages/contract/openapi.yaml's ExportArchive),
// not derived from a live export, so each test controls precisely which
// field is malformed/well-formed. round-trip.spec.ts is the sibling suite
// that instead captures a REAL archive from a REAL GET /export call.

import { randomUUID } from 'node:crypto';
import type { ExportArchive } from '../../src/import/index.js';

/** Real, valid v4 UUIDs for fixture wiring (the `label` param is kept for
 *  call-site readability only — it is not encoded into the id, since
 *  Postgres's `uuid` column type validates hex-only formatting and an
 *  empty-target import writes these ids VERBATIM). */
export function fakeId(_label: string): string {
  return randomUUID();
}

export function buildLibrary(overrides: Partial<ExportArchive['libraries'][number]> = {}): ExportArchive['libraries'][number] {
  return {
    id: fakeId('lib'),
    name: 'Movies',
    mediaKind: 'movie',
    paths: ['/data/movies'],
    contentClass: 'general',
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

export function buildMovie(libraryId: string, overrides: Partial<ExportArchive['items'][number]> = {}): ExportArchive['items'][number] {
  return {
    id: fakeId('mov'),
    libraryId,
    itemType: 'movie',
    title: 'Test Movie',
    sortTitle: 'Test Movie',
    year: 2020,
    communityRating: 7.5,
    contentClass: 'general',
    addedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    contentRating: 'PG-13',
    runtimeMs: 6_000_000,
    overview: 'A test movie.',
    tagline: 'It is a test.',
    genres: ['Drama'],
    people: [{ name: 'Test Actor', role: 'actor', credit: 'Lead', order: 0 }],
    mediaFiles: [{ id: fakeId('mf'), versionLabel: null, container: 'mkv', sizeBytes: 123456, durationMs: 6_000_000 }],
    ...overrides,
  } as ExportArchive['items'][number];
}

export function buildSeries(libraryId: string, overrides: Partial<ExportArchive['items'][number]> = {}): ExportArchive['items'][number] {
  return {
    id: fakeId('ser'),
    libraryId,
    itemType: 'series',
    title: 'Test Series',
    sortTitle: 'Test Series',
    year: 2019,
    communityRating: null,
    contentClass: 'general',
    addedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    contentRating: 'TV-14',
    overview: 'A test series.',
    status: 'continuing',
    genres: ['Sci-Fi'],
    people: [],
    ...overrides,
  } as ExportArchive['items'][number];
}

export function buildSeason(libraryId: string, seriesId: string, seasonNumber: number, overrides: Partial<ExportArchive['items'][number]> = {}): ExportArchive['items'][number] {
  return {
    id: fakeId('sea'),
    libraryId,
    itemType: 'season',
    title: `Season ${seasonNumber}`,
    sortTitle: `Season ${seasonNumber}`,
    year: null,
    communityRating: null,
    contentClass: 'general',
    addedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    seriesId,
    seasonNumber,
    ...overrides,
  } as ExportArchive['items'][number];
}

export function buildEpisode(
  libraryId: string,
  seasonId: string,
  seriesId: string,
  episodeNumber: number,
  overrides: Partial<ExportArchive['items'][number]> = {}
): ExportArchive['items'][number] {
  return {
    id: fakeId('epi'),
    libraryId,
    itemType: 'episode',
    title: `Episode ${episodeNumber}`,
    sortTitle: `Episode ${episodeNumber}`,
    year: null,
    communityRating: null,
    contentClass: 'general',
    addedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    seasonId,
    seriesId,
    episodeNumber,
    runtimeMs: 1_200_000,
    overview: 'A test episode.',
    airDateMs: 1_600_000_000_000,
    people: [],
    mediaFiles: [{ id: fakeId('mf'), versionLabel: null, container: 'mkv', sizeBytes: 654321, durationMs: 1_200_000 }],
    ...overrides,
  } as ExportArchive['items'][number];
}

export function buildArtist(libraryId: string, overrides: Partial<ExportArchive['items'][number]> = {}): ExportArchive['items'][number] {
  return {
    id: fakeId('art'),
    libraryId,
    itemType: 'artist',
    title: 'Test Artist',
    sortTitle: 'Test Artist',
    year: null,
    communityRating: null,
    contentClass: 'general',
    addedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    overview: null,
    genres: ['Rock'],
    people: [],
    ...overrides,
  } as ExportArchive['items'][number];
}

export function buildAlbum(libraryId: string, artistId: string, overrides: Partial<ExportArchive['items'][number]> = {}): ExportArchive['items'][number] {
  return {
    id: fakeId('alb'),
    libraryId,
    itemType: 'album',
    title: 'Test Album',
    sortTitle: 'Test Album',
    year: 2018,
    communityRating: null,
    contentClass: 'general',
    addedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    artistId,
    genres: ['Rock'],
    ...overrides,
  } as ExportArchive['items'][number];
}

export function buildTrack(
  libraryId: string,
  albumId: string,
  artistId: string,
  trackNumber: number,
  overrides: Partial<ExportArchive['items'][number]> = {}
): ExportArchive['items'][number] {
  return {
    id: fakeId('trk'),
    libraryId,
    itemType: 'track',
    title: `Track ${trackNumber}`,
    sortTitle: `Track ${trackNumber}`,
    year: null,
    communityRating: null,
    contentClass: 'general',
    addedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    albumId,
    artistId,
    trackNumber,
    discNumber: 1,
    durationMs: 200_000,
    mediaFiles: [],
    ...overrides,
  } as ExportArchive['items'][number];
}

export function buildUser(overrides: Partial<ExportArchive['users'][number]> = {}): ExportArchive['users'][number] {
  return {
    id: fakeId('usr'),
    username: 'historic-user',
    email: 'historic@example.com',
    isAdmin: false,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

export function buildProgress(itemId: string, overrides: Partial<ExportArchive['progress'][number]> = {}): ExportArchive['progress'][number] {
  return {
    itemId,
    positionMs: 30_000,
    durationMs: 6_000_000,
    state: 'in-progress',
    playCount: 2,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

export function buildEmptyArchive(overrides: Partial<ExportArchive> = {}): ExportArchive {
  return {
    exportedAtMs: 1_700_000_000_000,
    users: [],
    libraries: [],
    items: [],
    progress: [],
    playlists: [],
    ...overrides,
  };
}
