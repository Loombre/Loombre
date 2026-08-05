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
 * AUD-V2-M1 (merged from A2c-002 + A2c-003): every writer this consumer
 * calls for these four sections either upserts (a duplicate item id
 * silently OVERWRITES the earlier row — consumer.ts's preserveIds branch
 * calls upsertCatalogItem, whose ON CONFLICT DO UPDATE never errors) or
 * resolves collisions by an in-transaction lookup that a same-archive
 * duplicate defeats against itself (a duplicate username never reaches
 * insertUserWithId's own unique-violation catch, because
 * getUserByUsername's pre-insert SELECT already sees the FIRST duplicate's
 * write within the same transaction and silently takes the "already
 * exists, skip" branch instead — consumer.ts's users loop). Both failures
 * are SILENT: no error, no warning, the import reports success having lost
 * or absorbed a row. This is therefore the place every one of THESE FOUR
 * identity keys (.items[].id, .libraries[].id, .users[].id/.username) is
 * caught before the transaction opens (this function runs before runImport
 * ever calls withTransaction), naming the duplicate value and both
 * offending indices. A partial-import-then-fail is worse than a
 * refuse-to-start.
 *
 * Collation trap (reviewer reproduction, fix wave 2 follow-up to AUD-V2-M1):
 * `keyOf`'s return value is compared for uniqueness with a plain Map, i.e.
 * ORDINAL/case-sensitive equality — correct for the three UUID `id` keys
 * (Postgres's `uuid` type has no case-insensitive collation concern the way
 * a text type does), but WRONG for `.users[].username`, which is
 * `CITEXT NOT NULL UNIQUE` (packages/db/migrations/0001_init.sql:132) and
 * whose reader, getUserByUsername (packages/db/src/query/identity.ts:43),
 * compares with a plain `=` — so the DATABASE (and consumer.ts's
 * pre-insert lookup) treats "Bob" and "bob" as the SAME username, while a
 * bare `Map<string, number>` here did not, letting that exact pair sail
 * through and reach the silent-absorb path this function exists to close.
 * The optional `foldKey` param lets a caller normalize the COMPARISON key
 * to match the column's real collation while the diagnostic message still
 * names the RAW value from each offending row — an operator needs to see
 * "Bob" and "bob", not "bob" and "bob" twice.
 *
 * `.users[].email` is also CITEXT (nullable since migrations/0023) but is
 * deliberately NOT one of the four checks below — see checkReferentialIntegrity's
 * own doc comment for why that is a reasoned scope decision, not an
 * oversight.
 */
function checkArchiveInternalUniqueness<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  section: string,
  fieldName: string,
  foldKey: (raw: string) => string = (raw) => raw
): void {
  const firstByFoldedKey = new Map<string, { index: number; raw: string }>();
  rows.forEach((row, i) => {
    const raw = keyOf(row);
    const folded = foldKey(raw);
    const first = firstByFoldedKey.get(folded);
    if (first !== undefined) {
      fail(
        `${section}[${i}]`,
        `duplicates ${fieldName} "${raw}" already used by archive${section}[${first.index}] (there as "${first.raw}") ` +
          `— every archive${section} row must have a unique ${fieldName}`
      );
    }
    firstByFoldedKey.set(folded, { index: i, raw });
  });
}

/**
 * Archive-internal referential integrity: every parent/library reference an
 * item or progress row makes must resolve to something ELSE present in this
 * SAME archive. Run after validateArchive() (types are already trustworthy
 * here); throws ImportValidationError with the same section+index message
 * style rather than letting a dangling reference surface later as an opaque
 * Postgres foreign-key violation deep inside the import transaction.
 *
 * Uniqueness of each section's own identity key is checked FIRST (see
 * checkArchiveInternalUniqueness's doc comment, AUD-V2-M1) — every Map/Set
 * this function builds below keys off .id, so running the uniqueness pass
 * first means a duplicate is always reported as itself, never masked by
 * "last write wins" in one of these lookup structures. `.users[].username`
 * is folded to lowercase before comparison (below) to match its CITEXT
 * collation; the other three keys are UUIDs, compared as-is.
 *
 * Scope note on `.users[].email` (also CITEXT, nullable): deliberately NOT
 * checked here. Unlike username, nothing in consumer.ts's users loop does a
 * pre-insert lookup keyed on email that a same-archive duplicate could
 * defeat — a same-archive email collision (case-exact OR case-varying,
 * since the column is CITEXT) reaches insertUserWithId for BOTH rows and
 * the second one hits a real Postgres UNIQUE violation, which is caught and
 * rethrown as ImportConflictError, rolling back the whole transaction. That
 * is slower than a pre-transaction refusal (one row is attempted before the
 * failure surfaces) but never silent and never a partial commit — already
 * proven for the case-exact case by consumer.spec.ts's "two archive users
 * sharing an email" test (whole-archive transaction rollback describe
 * block), whose own comment explains this is deliberate, not an oversight.
 * If a future change adds an email pre-insert lookup to consumer.ts (mirroring
 * getUserByUsername), that lookup would reopen the exact silent-absorb hole
 * this function closes for username, and an archive-internal email
 * uniqueness check (folded the same way) should land here at the same time.
 */
export function checkReferentialIntegrity(archive: ExportArchive): void {
  checkArchiveInternalUniqueness(archive.libraries, (l) => l.id, '.libraries', 'id');
  checkArchiveInternalUniqueness(archive.items, (i) => i.id, '.items', 'id');
  checkArchiveInternalUniqueness(archive.users, (u) => u.id, '.users', 'id');
  checkArchiveInternalUniqueness(archive.users, (u) => u.username, '.users', 'username', (raw) => raw.toLowerCase());

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
