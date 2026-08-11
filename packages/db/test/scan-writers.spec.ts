// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/scan-writers.spec.ts
//
// Live-DB tests for the scan-pipeline additions to src/internal (deliverable
// A precondition: media_files create/re-encode/probe-result/delete writers,
// the library-scoped file listers used by the missing-file sweep, the
// find-by-natural-key catalog lookups the scanner's find-or-create logic
// uses, and the library readers). SELF-SUFFICIENT like test/internal.spec.ts
// — resets the schema in its own beforeAll (see vitest.config.ts for why
// this package's specs run sequentially).
//
// Also covers the query-guard's missing-file visibility clause
// (src/query/guard.ts): an item whose media_files rows are ALL missing is
// hidden from listItems/getItemById; an item with zero media_files rows
// (a container item) is unaffected.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { getItemById, listItems } from '../src/query/items.js';
import type { ViewerContext } from '../src/context.js';
import {
  createMediaFile,
  updateMediaFileHash,
  setMediaFileProbeResult,
  deleteMediaFile,
  listMediaFilesForLibrary,
  listStaleMissingFiles,
  markFileMissing,
  findFileByPath,
  findMovieByTitleYear,
  findSeriesByTitle,
  findSeasonByNumber,
  findEpisodeByNumber,
  findArtistByName,
  findAlbumByTitle,
  findTrackByNumberOrTitle,
  upsertCatalogItem,
  upsertSatellite,
  getLibraryById,
  listLibraries,
} from '../src/internal/index.js';
import { resolveTestDatabaseUrl } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const DATABASE_URL = resolveTestDatabaseUrl();

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

let db: Kysely<DB>;
let rawClient: pg.Client;
let libraryId: string;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);

  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  const now = Date.now();
  const libRow = await rawClient.query<{ id: string }>(
    `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
     VALUES ('Scan Writers Test Library', 'movie', '{}', $1, $1)
     RETURNING id`,
    [now]
  );
  libraryId = libRow.rows[0]!.id;
});

afterAll(async () => {
  await db?.destroy();
  await rawClient?.end();
});

describe('media_files writers (deliverable A)', () => {
  it('createMediaFile inserts a new row with NULL probe fields', async () => {
    const now = Date.now();
    const item = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Create File Test',
      sortTitle: 'create file test',
      year: 2020,
      addedAtMs: now,
      updatedAtMs: now,
    });

    const file = await createMediaFile(db, {
      itemId: item.id,
      path: '/media/create-file-test.mkv',
      contentHash: 'hash-create-1',
      sizeBytes: 12345,
    });

    expect(file.item_id).toBe(item.id);
    expect(file.content_hash).toBe('hash-create-1');
    expect(file.size_bytes).toBe(12345);
    expect(file.container).toBeNull();
    expect(file.probe).toBeNull();
    expect(file.probed_at_ms).toBeNull();
    expect(file.version_label).toBeNull();
  });

  it('createMediaFile stores an optional version_label (multi-version/editions)', async () => {
    const now = Date.now();
    const item = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Edition Test',
      sortTitle: 'edition test',
      year: 2021,
      addedAtMs: now,
      updatedAtMs: now,
    });

    const file = await createMediaFile(db, {
      itemId: item.id,
      path: "/media/edition-test-directors-cut.mkv",
      contentHash: 'hash-edition-1',
      sizeBytes: 999,
      versionLabel: "Director's Cut",
    });

    expect(file.version_label).toBe("Director's Cut");
  });

  it('updateMediaFileHash refreshes identity and nulls probe fields (re-encode path)', async () => {
    const now = Date.now();
    const item = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Re-encode Test',
      sortTitle: 're-encode test',
      year: 2022,
      addedAtMs: now,
      updatedAtMs: now,
    });
    const file = await createMediaFile(db, {
      itemId: item.id,
      path: '/media/re-encode-test.mkv',
      contentHash: 'hash-original',
      sizeBytes: 1000,
    });
    await setMediaFileProbeResult(db, file.id, {
      probe: { format: { format_name: 'matroska,webm' } },
      probedAtMs: now,
      durationMs: 60_000,
      container: 'mkv',
    });
    await markFileMissing(db, file.id, now);

    const updated = await updateMediaFileHash(db, file.id, {
      contentHash: 'hash-reencoded',
      sizeBytes: 2000,
    });

    expect(updated.id).toBe(file.id);
    expect(updated.item_id).toBe(item.id); // same item — never delete+readd
    expect(updated.path).toBe('/media/re-encode-test.mkv'); // path untouched
    expect(updated.content_hash).toBe('hash-reencoded');
    expect(updated.size_bytes).toBe(2000);
    expect(updated.container).toBeNull();
    expect(updated.duration_ms).toBeNull();
    expect(updated.probe).toBeNull();
    expect(updated.probed_at_ms).toBeNull();
    expect(updated.missing_since_ms).toBeNull();
  });

  it('setMediaFileProbeResult stores raw probe JSON + derived duration/container', async () => {
    const now = Date.now();
    const item = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Probe Result Test',
      sortTitle: 'probe result test',
      year: 2023,
      addedAtMs: now,
      updatedAtMs: now,
    });
    const file = await createMediaFile(db, {
      itemId: item.id,
      path: '/media/probe-result-test.mkv',
      contentHash: 'hash-probe-1',
      sizeBytes: 500,
    });

    const updated = await setMediaFileProbeResult(db, file.id, {
      probe: { format: { duration: '10.5' } },
      probedAtMs: now,
      durationMs: 10_500,
      container: 'mkv',
    });

    expect(updated.probe).toEqual({ format: { duration: '10.5' } });
    expect(updated.probed_at_ms).toBe(now);
    expect(updated.duration_ms).toBe(10_500);
    expect(updated.container).toBe('mkv');
  });

  it('deleteMediaFile removes only the file row, not the owning item', async () => {
    const now = Date.now();
    const item = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Delete File Test',
      sortTitle: 'delete file test',
      year: 2024,
      addedAtMs: now,
      updatedAtMs: now,
    });
    const file = await createMediaFile(db, {
      itemId: item.id,
      path: '/media/delete-file-test.mkv',
      contentHash: 'hash-delete-1',
      sizeBytes: 1,
    });

    await deleteMediaFile(db, file.id);

    expect(await findFileByPath(db, '/media/delete-file-test.mkv')).toBeUndefined();
    const itemRow = await rawClient.query('SELECT id FROM catalog_items WHERE id = $1', [item.id]);
    expect(itemRow.rows).toHaveLength(1);
  });

  it('listMediaFilesForLibrary and listStaleMissingFiles scope by library and missing-age', async () => {
    const now = Date.now();
    const otherLibRow = await rawClient.query<{ id: string }>(
      `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
       VALUES ('Other Library', 'movie', '{}', $1, $1) RETURNING id`,
      [now]
    );
    const otherLibraryId = otherLibRow.rows[0]!.id;

    const itemA = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Sweep Test A',
      sortTitle: 'sweep test a',
      year: 2025,
      addedAtMs: now,
      updatedAtMs: now,
    });
    const itemB = await upsertCatalogItem(db, {
      libraryId: otherLibraryId,
      itemType: 'movie',
      title: 'Sweep Test B (other library)',
      sortTitle: 'sweep test b',
      year: 2025,
      addedAtMs: now,
      updatedAtMs: now,
    });

    const fileA = await createMediaFile(db, {
      itemId: itemA.id,
      path: '/media/sweep-a.mkv',
      contentHash: 'hash-sweep-a',
      sizeBytes: 1,
    });
    await createMediaFile(db, {
      itemId: itemB.id,
      path: '/media/sweep-b.mkv',
      contentHash: 'hash-sweep-b',
      sizeBytes: 1,
    });

    const filesForLib = await listMediaFilesForLibrary(db, libraryId);
    expect(filesForLib.some((f) => f.id === fileA.id)).toBe(true);
    expect(filesForLib.some((f) => f.path === '/media/sweep-b.mkv')).toBe(false);

    // Not missing yet — stale-missing list is empty regardless of cutoff.
    expect(await listStaleMissingFiles(db, libraryId, now + 1_000_000)).toHaveLength(0);

    const missingSince = now - 100 * 60 * 60 * 1000; // 100h ago
    await markFileMissing(db, fileA.id, missingSince);

    const staleBefore72h = await listStaleMissingFiles(db, libraryId, now - 72 * 60 * 60 * 1000);
    expect(staleBefore72h.map((f) => f.id)).toContain(fileA.id);

    // A cutoff earlier than missingSince excludes it (not yet "older than").
    const staleTooRecent = await listStaleMissingFiles(db, libraryId, missingSince - 1);
    expect(staleTooRecent.map((f) => f.id)).not.toContain(fileA.id);
  });
});

describe('find-by-natural-key catalog lookups (scanner find-or-create)', () => {
  it('findMovieByTitleYear resolves the SAME item for the multi-edition case, distinguishes by year', async () => {
    const now = Date.now();
    const movie = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Blade Runner',
      sortTitle: 'blade runner',
      year: 1982,
      addedAtMs: now,
      updatedAtMs: now,
    });

    const found = await findMovieByTitleYear(db, { libraryId, title: 'BLADE runner', year: 1982 });
    expect(found?.id).toBe(movie.id);

    const differentYear = await findMovieByTitleYear(db, { libraryId, title: 'Blade Runner', year: 2049 });
    expect(differentYear).toBeUndefined();

    const nullYearMiss = await findMovieByTitleYear(db, { libraryId, title: 'Blade Runner', year: null });
    expect(nullYearMiss).toBeUndefined();
  });

  it('resolves the full series -> season -> episode hierarchy by natural key', async () => {
    const now = Date.now();
    const series = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'series',
      title: 'Test Show',
      sortTitle: 'test show',
      addedAtMs: now,
      updatedAtMs: now,
    });
    expect(await findSeriesByTitle(db, libraryId, 'test show')).toMatchObject({ id: series.id });

    const season = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'season',
      parentId: series.id,
      title: 'Season 1',
      sortTitle: 'season 1',
      addedAtMs: now,
      updatedAtMs: now,
    });
    await upsertSatellite(db, { itemType: 'season', item_id: season.id, season_number: 1 });
    expect(await findSeasonByNumber(db, series.id, 1)).toMatchObject({ id: season.id });
    expect(await findSeasonByNumber(db, series.id, 2)).toBeUndefined();

    const episode = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'episode',
      parentId: season.id,
      title: 'Pilot',
      sortTitle: 'pilot',
      addedAtMs: now,
      updatedAtMs: now,
    });
    await upsertSatellite(db, {
      itemType: 'episode',
      item_id: episode.id,
      episode_number: 1,
      aired_at_ms: null,
      overview: null,
    });
    expect(await findEpisodeByNumber(db, season.id, 1)).toMatchObject({ id: episode.id });
    expect(await findEpisodeByNumber(db, season.id, 2)).toBeUndefined();
  });

  it('resolves the full artist -> album -> track hierarchy by natural key, with a title fallback for track-number-less files', async () => {
    const now = Date.now();
    const artist = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'artist',
      title: 'Test Artist',
      sortTitle: 'test artist',
      addedAtMs: now,
      updatedAtMs: now,
    });
    expect(await findArtistByName(db, libraryId, 'test artist')).toMatchObject({ id: artist.id });

    const album = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'album',
      parentId: artist.id,
      title: 'Test Album',
      sortTitle: 'test album',
      addedAtMs: now,
      updatedAtMs: now,
    });
    await upsertSatellite(db, { itemType: 'album', item_id: album.id, year: 2019 });
    expect(await findAlbumByTitle(db, artist.id, 'TEST ALBUM')).toMatchObject({ id: album.id });

    const trackWithNumber = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'track',
      parentId: album.id,
      title: 'Track One',
      sortTitle: 'track one',
      addedAtMs: now,
      updatedAtMs: now,
    });
    await upsertSatellite(db, {
      itemType: 'track',
      item_id: trackWithNumber.id,
      track_number: 1,
      disc_number: null,
      duration_ms: null,
    });
    expect(
      await findTrackByNumberOrTitle(db, album.id, { trackNumber: 1, title: 'Track One' })
    ).toMatchObject({ id: trackWithNumber.id });

    const trackNoNumber = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'track',
      parentId: album.id,
      title: 'Untitled Track',
      sortTitle: 'untitled track',
      addedAtMs: now,
      updatedAtMs: now,
    });
    await upsertSatellite(db, {
      itemType: 'track',
      item_id: trackNoNumber.id,
      track_number: null,
      disc_number: null,
      duration_ms: null,
    });
    expect(
      await findTrackByNumberOrTitle(db, album.id, { trackNumber: null, title: 'Untitled Track' })
    ).toMatchObject({ id: trackNoNumber.id });
  });
});

describe('library readers', () => {
  it('getLibraryById and listLibraries return unfiltered library rows', async () => {
    const found = await getLibraryById(db, libraryId);
    expect(found?.id).toBe(libraryId);

    const all = await listLibraries(db);
    expect(all.some((l) => l.id === libraryId)).toBe(true);
  });
});

describe('query-guard: missing-file visibility (P1.2, docs/PLAN.md §8.2)', () => {
  const ctx: ViewerContext = { userId: 'guard-test-user', allowedLibraryIds: [], restrictedCleared: true };

  it('an item with zero media_files rows (a container item) stays visible', async () => {
    const now = Date.now();
    const series = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'series',
      title: 'Guard Container Show',
      sortTitle: 'guard container show',
      addedAtMs: now,
      updatedAtMs: now,
    });

    const scopedCtx = { ...ctx, allowedLibraryIds: [libraryId] };
    const found = await getItemById(db, scopedCtx, series.id);
    expect(found?.id).toBe(series.id);
  });

  it('an item whose only file is missing is hidden from getItemById and listItems; reappears once the file is live again', async () => {
    const now = Date.now();
    const movie = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Guard Missing Movie',
      sortTitle: 'guard missing movie',
      year: 2030,
      addedAtMs: now,
      updatedAtMs: now,
    });
    const file = await createMediaFile(db, {
      itemId: movie.id,
      path: '/media/guard-missing-movie.mkv',
      contentHash: 'hash-guard-missing',
      sizeBytes: 1,
    });

    const scopedCtx = { ...ctx, allowedLibraryIds: [libraryId] };

    expect((await getItemById(db, scopedCtx, movie.id))?.id).toBe(movie.id);
    const beforeList = await listItems(db, scopedCtx, { itemType: 'movie' });
    expect(beforeList.rows.some((r) => r.id === movie.id)).toBe(true);

    await markFileMissing(db, file.id, now);

    expect(await getItemById(db, scopedCtx, movie.id)).toBeUndefined();
    const duringList = await listItems(db, scopedCtx, { itemType: 'movie' });
    expect(duringList.rows.some((r) => r.id === movie.id)).toBe(false);

    // Restore: file reappears (clearFileMissing via relinkFile's same-path
    // no-op semantics is exercised elsewhere; here we just clear directly).
    await rawClient.query('UPDATE media_files SET missing_since_ms = NULL WHERE id = $1', [file.id]);

    expect((await getItemById(db, scopedCtx, movie.id))?.id).toBe(movie.id);
  });

  it('an item with multiple files is hidden only once ALL of them are missing', async () => {
    const now = Date.now();
    const movie = await upsertCatalogItem(db, {
      libraryId,
      itemType: 'movie',
      title: 'Guard Multi-file Movie',
      sortTitle: 'guard multi-file movie',
      year: 2031,
      addedAtMs: now,
      updatedAtMs: now,
    });
    const fileA = await createMediaFile(db, {
      itemId: movie.id,
      path: '/media/guard-multi-a.mkv',
      contentHash: 'hash-guard-multi-a',
      sizeBytes: 1,
      versionLabel: 'part 1',
    });
    const fileB = await createMediaFile(db, {
      itemId: movie.id,
      path: '/media/guard-multi-b.mkv',
      contentHash: 'hash-guard-multi-b',
      sizeBytes: 1,
      versionLabel: 'part 2',
    });

    const scopedCtx = { ...ctx, allowedLibraryIds: [libraryId] };

    await markFileMissing(db, fileA.id, now);
    expect((await getItemById(db, scopedCtx, movie.id))?.id).toBe(movie.id);

    await markFileMissing(db, fileB.id, now);
    expect(await getItemById(db, scopedCtx, movie.id)).toBeUndefined();
  });
});
