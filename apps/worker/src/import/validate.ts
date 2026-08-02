// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/import/validate.ts
//
// Narrows the job payload's `archive: unknown` (packages/jobs/src/types.ts)
// into a typed ExportArchive (./types.ts), and separately checks the
// archive's internal referential integrity (season->series,
// episode->season/series, album->artist, track->album/artist,
// item->library, progress->item — every one of these is an archive-INTERNAL
// reference; there is nothing outside the archive itself to validate
// against yet, since these rows have not been written anywhere).
//
// Both passes run BEFORE the import consumer opens its database
// transaction (apps/worker/src/import/consumer.ts) — deliberately cheap,
// in-memory-only checks (STATE.md 50k-scale note: the whole archive is
// already one fully-materialized JS object by the time a job handler runs,
// via pg-boss's own JSONB payload column — no additional streaming/parsing
// cost is introduced here) so a malformed or internally-contradictory
// archive fails FAST, with a message naming the offending section + index,
// and never opens (let alone rolls back) a database transaction at all.
// This is deliverable 4's "typed job failure with the offending
// section/index in the error (not a stack trace)" — every thrown error
// here is an ImportValidationError whose .message is what the queue's
// generic catch (packages/jobs/src/queue.ts) persists verbatim as the job
// ledger's last_error.

import type {
  ArchiveAlbum,
  ArchiveArtist,
  ArchiveEpisode,
  ArchiveItem,
  ArchiveItemType,
  ArchiveLibrary,
  ArchiveMediaFile,
  ArchiveMovie,
  ArchivePersonCredit,
  ArchivePersonRole,
  ArchiveProgress,
  ArchiveSeason,
  ArchiveSeries,
  ArchiveTrack,
  ArchiveUser,
  ExportArchive,
} from './types.js';
import { ImportValidationError } from './types.js';

function fail(path: string, reason: string): never {
  throw new ImportValidationError(`import: archive${path} ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqArray(obj: Record<string, unknown>, key: string, path: string): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) fail(path, `must have an array "${key}" field`);
  return v;
}

function reqString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string') fail(path, `field "${key}" must be a string`);
  return v;
}

function reqNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `field "${key}" must be a finite number`);
  return v;
}

function reqBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') fail(path, `field "${key}" must be a boolean`);
  return v;
}

function nullableString(obj: Record<string, unknown>, key: string, path: string): string | null {
  const v = obj[key];
  if (v === null) return null;
  if (typeof v !== 'string') fail(path, `field "${key}" must be a string or null`);
  return v;
}

function nullableNumber(obj: Record<string, unknown>, key: string, path: string): number | null {
  const v = obj[key];
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `field "${key}" must be a finite number or null`);
  return v;
}

function reqStringArray(obj: Record<string, unknown>, key: string, path: string): string[] {
  const arr = reqArray(obj, key, path);
  return arr.map((v, i) => {
    if (typeof v !== 'string') fail(path, `field "${key}"[${i}] must be a string`);
    return v;
  });
}

const CONTENT_CLASSES = new Set(['general', 'restricted']);
function reqContentClass(obj: Record<string, unknown>, key: string, path: string): 'general' | 'restricted' {
  const v = reqString(obj, key, path);
  if (!CONTENT_CLASSES.has(v)) fail(path, `field "${key}" must be "general" or "restricted", got "${v}"`);
  return v as 'general' | 'restricted';
}

const MEDIA_KINDS = new Set(['movie', 'tv', 'music']);
function validateLibrary(raw: unknown, index: number): ArchiveLibrary {
  const path = `.libraries[${index}]`;
  if (!isRecord(raw)) fail(path, 'must be an object');
  const mediaKind = reqString(raw, 'mediaKind', path);
  if (!MEDIA_KINDS.has(mediaKind)) fail(path, `field "mediaKind" must be one of movie/tv/music, got "${mediaKind}"`);
  return {
    id: reqString(raw, 'id', path),
    name: reqString(raw, 'name', path),
    mediaKind: mediaKind as ArchiveLibrary['mediaKind'],
    paths: reqStringArray(raw, 'paths', path),
    contentClass: reqContentClass(raw, 'contentClass', path),
    createdAtMs: reqNumber(raw, 'createdAtMs', path),
  };
}

function validateMediaFiles(obj: Record<string, unknown>, path: string): ArchiveMediaFile[] {
  const arr = reqArray(obj, 'mediaFiles', path);
  return arr.map((raw, i) => {
    const p = `${path}.mediaFiles[${i}]`;
    if (!isRecord(raw)) fail(p, 'must be an object');
    return {
      id: reqString(raw, 'id', p),
      versionLabel: nullableString(raw, 'versionLabel', p),
      container: nullableString(raw, 'container', p),
      sizeBytes: nullableNumber(raw, 'sizeBytes', p),
      durationMs: nullableNumber(raw, 'durationMs', p),
    };
  });
}

const PERSON_ROLES = new Set(['actor', 'director', 'writer', 'artist', 'album_artist', 'performer', 'guest']);
function validatePeople(obj: Record<string, unknown>, path: string): ArchivePersonCredit[] {
  const arr = reqArray(obj, 'people', path);
  return arr.map((raw, i) => {
    const p = `${path}.people[${i}]`;
    if (!isRecord(raw)) fail(p, 'must be an object');
    const role = reqString(raw, 'role', p);
    if (!PERSON_ROLES.has(role)) fail(p, `field "role" is not a known PersonRole: "${role}"`);
    return {
      name: reqString(raw, 'name', p),
      role: role as ArchivePersonRole,
      credit: nullableString(raw, 'credit', p),
      order: reqNumber(raw, 'order', p),
    };
  });
}

function base(raw: Record<string, unknown>, path: string) {
  return {
    id: reqString(raw, 'id', path),
    libraryId: reqString(raw, 'libraryId', path),
    title: reqString(raw, 'title', path),
    sortTitle: reqString(raw, 'sortTitle', path),
    year: nullableNumber(raw, 'year', path),
    communityRating: nullableNumber(raw, 'communityRating', path),
    contentClass: reqContentClass(raw, 'contentClass', path),
    addedAtMs: reqNumber(raw, 'addedAtMs', path),
    updatedAtMs: reqNumber(raw, 'updatedAtMs', path),
  };
}

const ITEM_TYPES = new Set(['movie', 'series', 'season', 'episode', 'artist', 'album', 'track']);

function validateItem(raw: unknown, index: number): ArchiveItem {
  const path = `.items[${index}]`;
  if (!isRecord(raw)) fail(path, 'must be an object');
  const itemType = reqString(raw, 'itemType', path);
  if (!ITEM_TYPES.has(itemType)) fail(path, `field "itemType" is not a known item type: "${itemType}"`);

  const b = base(raw, path);

  switch (itemType as ArchiveItemType) {
    case 'movie':
      return {
        ...b,
        itemType: 'movie',
        contentRating: nullableString(raw, 'contentRating', path),
        runtimeMs: nullableNumber(raw, 'runtimeMs', path),
        overview: nullableString(raw, 'overview', path),
        tagline: raw['tagline'] === undefined ? null : nullableString(raw, 'tagline', path),
        genres: reqStringArray(raw, 'genres', path),
        people: raw['people'] === undefined ? [] : validatePeople(raw, path),
        mediaFiles: raw['mediaFiles'] === undefined ? [] : validateMediaFiles(raw, path),
      } satisfies ArchiveMovie;
    case 'series':
      return {
        ...b,
        itemType: 'series',
        contentRating: nullableString(raw, 'contentRating', path),
        overview: nullableString(raw, 'overview', path),
        status: (() => {
          const s = raw['status'];
          if (s === null) return null;
          if (s !== 'continuing' && s !== 'ended' && s !== 'cancelled') fail(path, 'field "status" is invalid');
          return s;
        })(),
        genres: reqStringArray(raw, 'genres', path),
        people: raw['people'] === undefined ? [] : validatePeople(raw, path),
      } satisfies ArchiveSeries;
    case 'season':
      return {
        ...b,
        itemType: 'season',
        seriesId: reqString(raw, 'seriesId', path),
        seasonNumber: reqNumber(raw, 'seasonNumber', path),
      } satisfies ArchiveSeason;
    case 'episode':
      return {
        ...b,
        itemType: 'episode',
        seasonId: reqString(raw, 'seasonId', path),
        seriesId: reqString(raw, 'seriesId', path),
        episodeNumber: reqNumber(raw, 'episodeNumber', path),
        runtimeMs: nullableNumber(raw, 'runtimeMs', path),
        overview: nullableString(raw, 'overview', path),
        airDateMs: raw['airDateMs'] === undefined ? null : nullableNumber(raw, 'airDateMs', path),
        people: raw['people'] === undefined ? [] : validatePeople(raw, path),
        mediaFiles: raw['mediaFiles'] === undefined ? [] : validateMediaFiles(raw, path),
      } satisfies ArchiveEpisode;
    case 'artist':
      return {
        ...b,
        itemType: 'artist',
        overview: nullableString(raw, 'overview', path),
        genres: reqStringArray(raw, 'genres', path),
        people: raw['people'] === undefined ? [] : validatePeople(raw, path),
      } satisfies ArchiveArtist;
    case 'album':
      return {
        ...b,
        itemType: 'album',
        artistId: reqString(raw, 'artistId', path),
        genres: reqStringArray(raw, 'genres', path),
      } satisfies ArchiveAlbum;
    case 'track':
      return {
        ...b,
        itemType: 'track',
        albumId: reqString(raw, 'albumId', path),
        artistId: reqString(raw, 'artistId', path),
        trackNumber: nullableNumber(raw, 'trackNumber', path),
        discNumber: raw['discNumber'] === undefined ? null : nullableNumber(raw, 'discNumber', path),
        durationMs: nullableNumber(raw, 'durationMs', path),
        mediaFiles: raw['mediaFiles'] === undefined ? [] : validateMediaFiles(raw, path),
      } satisfies ArchiveTrack;
  }
  /* istanbul ignore next -- ITEM_TYPES already exhausts ArchiveItemType */
  fail(path, 'unreachable itemType branch');
}

function validateUser(raw: unknown, index: number): ArchiveUser {
  const path = `.users[${index}]`;
  if (!isRecord(raw)) fail(path, 'must be an object');
  return {
    id: reqString(raw, 'id', path),
    username: reqString(raw, 'username', path),
    // M1: email is nullable now — every pre-M1 archive still has it as a
    // real string (the column was NOT NULL then), so nullableString's
    // "value must be present" behavior is exactly right here (unlike
    // displayName below, no `undefined`-tolerance is needed).
    email: nullableString(raw, 'email', path),
    // M2: a genuinely NEW optional field — archives written before this
    // migration never had it at all, so a missing key must be tolerated
    // exactly like an explicit `null` (same convention validateTrack's
    // discNumber uses above).
    displayName: raw['displayName'] === undefined ? null : nullableString(raw, 'displayName', path),
    isAdmin: reqBoolean(raw, 'isAdmin', path),
    createdAtMs: reqNumber(raw, 'createdAtMs', path),
  };
}

const WATCH_STATES = new Set(['unplayed', 'in-progress', 'played']);
function validateProgress(raw: unknown, index: number): ArchiveProgress {
  const path = `.progress[${index}]`;
  if (!isRecord(raw)) fail(path, 'must be an object');
  const state = reqString(raw, 'state', path);
  if (!WATCH_STATES.has(state)) fail(path, `field "state" is not a known WatchState: "${state}"`);
  return {
    itemId: reqString(raw, 'itemId', path),
    positionMs: reqNumber(raw, 'positionMs', path),
    // Optional per packages/contract/openapi.yaml's Progress schema
    // (`required` omits it) — and, as-built, GET /export's progress
    // entries (apps/server/src/catalog/data-freedom.controller.ts) never
    // include this key at all, only positionMs/state/playCount/updatedAtMs
    // — so `undefined` (the key absent) must be tolerated exactly like an
    // explicit `null`, not treated as malformed.
    durationMs: raw['durationMs'] === undefined ? null : nullableNumber(raw, 'durationMs', path),
    state: state as ArchiveProgress['state'],
    playCount: reqNumber(raw, 'playCount', path),
    updatedAtMs: reqNumber(raw, 'updatedAtMs', path),
  };
}

/** Structural validation only — see module header. Throws
 *  ImportValidationError naming the first offending section + index. */
export function validateArchive(rawArchive: unknown): ExportArchive {
  if (!isRecord(rawArchive)) fail('', 'must be an object');

  const exportedAtMs = reqNumber(rawArchive, 'exportedAtMs', '');
  const libraries = reqArray(rawArchive, 'libraries', '').map((raw, i) => validateLibrary(raw, i));
  const items = reqArray(rawArchive, 'items', '').map((raw, i) => validateItem(raw, i));
  const users = reqArray(rawArchive, 'users', '').map((raw, i) => validateUser(raw, i));
  const progress = reqArray(rawArchive, 'progress', '').map((raw, i) => validateProgress(raw, i));
  const playlists = reqArray(rawArchive, 'playlists', '');

  return { exportedAtMs, users, libraries, items, progress, playlists };
}

/**
 * Archive-internal referential integrity: every parent/library reference an
 * item or progress row makes must resolve to something ELSE present in this
 * SAME archive. Run after validateArchive() (types are already trustworthy
 * here); throws ImportValidationError with the same section+index message
 * style rather than letting a dangling reference surface later as an opaque
 * Postgres foreign-key violation deep inside the import transaction.
 */
export function checkReferentialIntegrity(archive: ExportArchive): void {
  const libraryIds = new Set(archive.libraries.map((l) => l.id));
  const seriesIds = new Set<string>();
  const seasonById = new Map<string, ArchiveSeason>();
  const artistIds = new Set<string>();
  const albumById = new Map<string, ArchiveAlbum>();

  for (const item of archive.items) {
    if (item.itemType === 'series') seriesIds.add(item.id);
    if (item.itemType === 'season') seasonById.set(item.id, item);
    if (item.itemType === 'artist') artistIds.add(item.id);
    if (item.itemType === 'album') albumById.set(item.id, item);
  }

  archive.items.forEach((item, i) => {
    const path = `.items[${i}]`;
    if (!libraryIds.has(item.libraryId)) {
      fail(path, `references libraryId "${item.libraryId}" not present in archive.libraries`);
    }
    if (item.itemType === 'season') {
      if (!seriesIds.has(item.seriesId)) fail(path, `references seriesId "${item.seriesId}" not present among archive.items`);
    }
    if (item.itemType === 'episode') {
      const season = seasonById.get(item.seasonId);
      if (!season) fail(path, `references seasonId "${item.seasonId}" not present among archive.items`);
      if (!seriesIds.has(item.seriesId)) fail(path, `references seriesId "${item.seriesId}" not present among archive.items`);
      if (season.seriesId !== item.seriesId) {
        fail(path, `seriesId "${item.seriesId}" is inconsistent with its season's own seriesId "${season.seriesId}"`);
      }
    }
    if (item.itemType === 'album') {
      if (!artistIds.has(item.artistId)) fail(path, `references artistId "${item.artistId}" not present among archive.items`);
    }
    if (item.itemType === 'track') {
      const album = albumById.get(item.albumId);
      if (!album) fail(path, `references albumId "${item.albumId}" not present among archive.items`);
      if (!artistIds.has(item.artistId)) fail(path, `references artistId "${item.artistId}" not present among archive.items`);
      if (album.artistId !== item.artistId) {
        fail(path, `artistId "${item.artistId}" is inconsistent with its album's own artistId "${album.artistId}"`);
      }
    }
  });

  const itemIds = new Set(archive.items.map((i) => i.id));
  archive.progress.forEach((p, i) => {
    if (!itemIds.has(p.itemId)) {
      fail(`.progress[${i}]`, `references itemId "${p.itemId}" not present among archive.items`);
    }
  });
}
