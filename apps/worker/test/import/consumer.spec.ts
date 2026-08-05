// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/import/consumer.spec.ts
//
// Live-DB behavioral suite for apps/worker/src/import/consumer.ts:
// empty-target ID preservation, merge-skip-existing natural-key counts,
// the P4.10 wizard self-match tolerance, fail-if-not-empty rejection,
// whole-archive transaction rollback, the missing-file placeholder +
// guard-invisibility proof, and the one-scan.completed-event-per-library
// rule. round-trip.spec.ts is the sibling suite covering the full
// export->wipe->import->diff exit bar via the real HTTP/job paths.
//
// Resource isolation (this lane's ports 3700-3799, DBs loombre_e /
// loombre_e_roundtrip): this file never touches the shared `loombre` dev
// database directly — every case runs against `loombre_e_unit`
// (ensureTestDatabase's suffix convention, @loombre/db/src/testing.ts, the
// same helper apps/server/test/auth.e2e.spec.ts already uses), reset once
// per `it` via TRUNCATE (not a full migrate reset — cheap enough for a
// per-case reset and keeps every case's target-emptiness assumptions
// exact).
//
// Connection base: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb, ensureTestDatabase, getItemById } from '@loombre/db';
import type { ViewerContext } from '@loombre/db';
import { runImport } from '../../src/import/index.js';
import {
  buildArtist,
  buildEmptyArchive,
  buildEpisode,
  buildLibrary,
  buildMovie,
  buildProgress,
  buildSeason,
  buildSeries,
  buildUser,
} from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');
const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[], databaseUrl: string): void {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

let databaseUrl: string;
let db: ReturnType<typeof createDb>;
let raw: pg.Client;

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, 'e_unit');
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset'], databaseUrl);
  db = createDb(databaseUrl);
  raw = new pg.Client({ connectionString: databaseUrl });
  await raw.connect();
});

afterAll(async () => {
  await db.destroy();
  await raw.end();
});

/** All catalog-adjacent tables truncated back to empty between cases — the
 *  consumer's own empty-target/mode logic is exactly what's under test, so
 *  each `it` needs full control over the starting state. */
async function truncateAll(): Promise<void> {
  await raw.query(
    `TRUNCATE TABLE progress, item_tags, item_people, media_streams, media_files,
      movie_details, series_details, season_details, episode_details, artist_details, album_details, track_details,
      catalog_items, library_permissions, libraries, tags, people, events, user_settings, users, scan_checkpoints
      RESTART IDENTITY CASCADE`
  );
}

beforeEach(async () => {
  await truncateAll();
});

async function insertRawUser(username: string, isAdmin = true): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('users')
    .values({
      username,
      email: `${username}@example.com`,
      password_hash: 'a-real-looking-hash-not-the-sentinel',
      birth_date: null,
      max_content_rating: null,
      is_admin: isAdmin,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

const clearedAdminCtx = (userId: string, allowedLibraryIds: string[]): ViewerContext => ({
  userId,
  allowedLibraryIds,
  restrictedCleared: true,
});

/**
 * Every realistic caller of runImport already has a users row (POST
 * /import is admin-JWT-gated — see consumer.ts's module header on
 * requestedByUserId), so a "the users table is truly, literally empty"
 * scenario cannot happen via the real HTTP path; the smallest real
 * empty-target scenario is exactly one existing user (the caller) whose
 * username the archive's own users[] also lists (which is what makes the
 * emptiness check's wizard tolerance meaningful in the first place — see
 * consumer.ts's module header). This helper sets up exactly that floor for
 * every empty-target-flavored test below, so each one only has to add
 * whatever ELSE it wants restored.
 */
async function insertRequesterWithSelfMatch(username = 'importing-admin') {
  const requesterId = await insertRawUser(username);
  const archiveSelfUser = buildUser({ username, isAdmin: true });
  return { requesterId, archiveSelfUser };
}

describe('import consumer: empty-target ID preservation', () => {
  it('preserves library/item/media_files/user ids verbatim and creates the general-library auto-grant', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();

    const lib = buildLibrary({ contentClass: 'general' });
    const movie = buildMovie(lib.id);
    const series = buildSeries(lib.id);
    const season = buildSeason(lib.id, series.id, 1);
    const episode = buildEpisode(lib.id, season.id, series.id, 1);
    // M1/M2 (E4 archive check): a null email + a real displayName both
    // round-trip through the empty-target ID-preservation restore path.
    const user = buildUser({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      username: 'restored-user',
      email: null,
      displayName: 'Restored Display Name',
    });
    const progress = buildProgress(movie.id);

    const archive = buildEmptyArchive({
      libraries: [lib],
      items: [movie, series, season, episode],
      users: [archiveSelfUser, user],
      progress: [progress],
    });

    const result = await runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-1' });

    expect(result.preservedIds).toBe(true);
    expect(result.libraries).toEqual({ created: 1, skipped: 0 });
    expect(result.items).toEqual({ created: 4, skipped: 0 });
    expect(result.users).toEqual({ created: 1, skipped: 0, selfMatched: 1 });
    expect(result.progress).toEqual({ created: 1, skipped: 0 });

    const libRow = await db.selectFrom('libraries').selectAll().where('id', '=', lib.id).executeTakeFirstOrThrow();
    expect(libRow.name).toBe(lib.name);

    const movieRow = await db.selectFrom('catalog_items').selectAll().where('id', '=', movie.id).executeTakeFirstOrThrow();
    expect(movieRow.title).toBe(movie.title);
    expect(movieRow.library_id).toBe(lib.id);

    const userRow = await db.selectFrom('users').selectAll().where('id', '=', user.id).executeTakeFirstOrThrow();
    expect(userRow.username).toBe('restored-user');
    expect(userRow.password_hash).toContain('$argon2id$'); // the unmatchable sentinel, not a real hash.
    expect(userRow.email).toBeNull(); // M1
    expect(userRow.display_name).toBe('Restored Display Name'); // M2

    const progressRow = await db
      .selectFrom('progress')
      .selectAll()
      .where('item_id', '=', movie.id)
      .where('user_id', '=', requester)
      .executeTakeFirstOrThrow();
    expect(progressRow.play_count).toBe(2);
    expect(progressRow.position_ms).toBe(30_000);

    // general-library auto-grant to the IMPORTING admin (mirrors
    // createLibrary()'s own precedent) — see consumer.ts's module header.
    const grant = await db
      .selectFrom('library_permissions')
      .selectAll()
      .where('library_id', '=', lib.id)
      .where('user_id', '=', requester)
      .executeTakeFirst();
    expect(grant).toBeDefined();

    // exactly one scan.completed event for the one touched library, zero
    // item.added/user.created events anywhere.
    const events = await db.selectFrom('events').selectAll().execute();
    expect(events.filter((e) => e.type === 'scan.completed')).toHaveLength(1);
    expect(events.some((e) => e.type === 'item.added')).toBe(false);
    expect(events.some((e) => e.type === 'user.created')).toBe(false);
    const scanEvent = events.find((e) => e.type === 'scan.completed')!;
    const scanPayload = scanEvent.payload as Record<string, unknown>;
    expect(scanPayload['libraryId']).toBe(lib.id);
    expect(scanPayload['itemsAdded']).toBe(4);
  });

  it('media_files placeholder rows: never a real path, content_hash NULL, missing_since_ms set immediately (P1.2 state)', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    const lib = buildLibrary();
    const movie = buildMovie(lib.id);
    const archive = buildEmptyArchive({ libraries: [lib], items: [movie], users: [archiveSelfUser] });

    await runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-2' });

    const fileRow = await db
      .selectFrom('media_files')
      .selectAll()
      .where('item_id', '=', movie.id)
      .executeTakeFirstOrThrow();
    expect(fileRow.content_hash).toBeNull();
    expect(fileRow.missing_since_ms).not.toBeNull();
    expect(fileRow.path).toMatch(/^loombre-import-placeholder:\/\//);
    expect(fileRow.container).toBe('mkv');
    expect(fileRow.size_bytes).toBe(123456);

    // The guard hides a leaf item whose EVERY media_files row is missing —
    // proven directly against the real guarded read, not re-derived logic.
    const ctx = clearedAdminCtx(requester, [lib.id]);
    const visible = await getItemById(db, ctx, movie.id);
    expect(visible).toBeUndefined();
  });

  it('a container item (series, no media_files) stays guard-visible after import', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    const lib = buildLibrary();
    const series = buildSeries(lib.id);
    const archive = buildEmptyArchive({ libraries: [lib], items: [series], users: [archiveSelfUser] });

    await runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-3' });

    const ctx = clearedAdminCtx(requester, [lib.id]);
    const visible = await getItemById(db, ctx, series.id);
    expect(visible).toBeDefined();
    expect(visible!.title).toBe(series.title);
  });

  it('restricted-class libraries do NOT get the auto-grant', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    const lib = buildLibrary({ contentClass: 'restricted', name: 'Restricted' });
    const archive = buildEmptyArchive({ libraries: [lib], users: [archiveSelfUser] });

    await runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-4' });

    const grant = await db
      .selectFrom('library_permissions')
      .selectAll()
      .where('library_id', '=', lib.id)
      .executeTakeFirst();
    expect(grant).toBeUndefined();
  });
});

describe('import consumer: fail-if-not-empty (the default)', () => {
  it('rejects when catalog_items already has unrelated data, and writes nothing', async () => {
    const requester = await insertRawUser('importing-admin');
    const preexistingLibId = (
      await db
        .insertInto('libraries')
        .values({ name: 'Pre-existing', media_kind: 'movie', paths: [], content_class: 'general', created_at_ms: Date.now(), updated_at_ms: Date.now() })
        .returningAll()
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('catalog_items')
      .values({ library_id: preexistingLibId, item_type: 'movie', title: 'Already here', sort_title: 'Already here', added_at_ms: Date.now(), updated_at_ms: Date.now() })
      .execute();

    const lib = buildLibrary();
    const archive = buildEmptyArchive({ libraries: [lib] });

    await expect(runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-5' })).rejects.toThrow(
      /not empty/
    );

    const libCount = await db.selectFrom('libraries').select('id').execute();
    expect(libCount).toHaveLength(1); // only the pre-existing one — nothing written.
  });

  it('tolerates a single wizard-created admin (username present in the archive) as "empty enough"', async () => {
    const wizardAdminId = await insertRawUser('admin');
    const archiveAdmin = buildUser({ id: 'aaaaaaaa-0000-4000-8000-000000000099', username: 'admin', isAdmin: true });
    const lib = buildLibrary();
    const archive = buildEmptyArchive({ libraries: [lib], users: [archiveAdmin] });

    const result = await runImport({ db }, { archive, requestedByUserId: wizardAdminId }, { jobId: 'job-6' });

    expect(result.preservedIds).toBe(true);
    expect(result.users.selfMatched).toBe(1);
    expect(result.users.created).toBe(0);
    expect(result.libraries.created).toBe(1);

    // the wizard's own real password must survive untouched.
    const row = await db.selectFrom('users').selectAll().where('id', '=', wizardAdminId).executeTakeFirstOrThrow();
    expect(row.password_hash).toBe('a-real-looking-hash-not-the-sentinel');
  });

  it('rejects when an existing user has NO counterpart in the archive at all', async () => {
    await insertRawUser('unrelated-user');
    const lib = buildLibrary();
    const archive = buildEmptyArchive({ libraries: [lib] });

    await expect(runImport({ db }, { archive, requestedByUserId: 'does-not-matter' }, { jobId: 'job-7' })).rejects.toThrow(
      /not empty/
    );
  });
});

describe('import consumer: merge-skip-existing', () => {
  it('creates non-conflicting rows and skips a natural-key match, with fresh (non-preserved) ids', async () => {
    const requester = await insertRawUser('importing-admin');
    const preexisting = await db
      .insertInto('libraries')
      .values({ name: 'Movies', media_kind: 'movie', paths: ['/local/movies'], content_class: 'general', created_at_ms: Date.now(), updated_at_ms: Date.now() })
      .returningAll()
      .executeTakeFirstOrThrow();
    const existingMovie = await db
      .insertInto('catalog_items')
      .values({
        library_id: preexisting.id,
        item_type: 'movie',
        title: 'Test Movie',
        sort_title: 'Test Movie',
        year: 2020,
        added_at_ms: Date.now(),
        updated_at_ms: Date.now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // archive.libraries[0] shares (name, mediaKind) with `preexisting`;
    // archive.items[0] shares (title, year) with `existingMovie` inside
    // that same (mapped) library — both must be skipped. archive.items[1]
    // is a brand-new movie in the SAME library and must be created fresh.
    const lib = buildLibrary({ name: 'Movies', mediaKind: 'movie', id: 'aaaaaaaa-0000-4000-8000-000000000101' });
    const dupMovie = buildMovie(lib.id, { title: 'Test Movie', year: 2020, id: 'aaaaaaaa-0000-4000-8000-000000000102' });
    const newMovie = buildMovie(lib.id, { title: 'Brand New Movie', year: 2021, id: 'aaaaaaaa-0000-4000-8000-000000000103' });
    const archive = buildEmptyArchive({ libraries: [lib], items: [dupMovie, newMovie] });

    const result = await runImport(
      { db },
      { archive, requestedByUserId: requester, mode: 'merge-skip-existing' },
      { jobId: 'job-8' }
    );

    expect(result.preservedIds).toBe(false);
    expect(result.mode).toBe('merge-skip-existing');
    expect(result.libraries).toEqual({ created: 0, skipped: 1 });
    expect(result.items).toEqual({ created: 1, skipped: 1 });

    // the archive's own ids must NOT appear verbatim in merge mode.
    const byArchiveId = await db.selectFrom('catalog_items').select('id').where('id', '=', dupMovie.id).executeTakeFirst();
    expect(byArchiveId).toBeUndefined();

    const allMovies = await db.selectFrom('catalog_items').selectAll().where('library_id', '=', preexisting.id).execute();
    expect(allMovies).toHaveLength(2); // the original "Test Movie" + the new one; no duplicate "Test Movie".
    expect(allMovies.find((m) => m.id === existingMovie.id)).toBeDefined();

    // re-running the SAME archive again: everything now skips, zero growth.
    const second = await runImport(
      { db },
      { archive, requestedByUserId: requester, mode: 'merge-skip-existing' },
      { jobId: 'job-8b' }
    );
    expect(second.libraries).toEqual({ created: 0, skipped: 1 });
    expect(second.items).toEqual({ created: 0, skipped: 2 });
    const finalMovies = await db.selectFrom('catalog_items').selectAll().where('library_id', '=', preexisting.id).execute();
    expect(finalMovies).toHaveLength(2);
  });
});

describe('import consumer: whole-archive transaction rollback', () => {
  it('two archive users sharing an email (distinct usernames, so the pre-insert lookup cannot catch it) fail cleanly and write zero rows', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    // Distinct usernames deliberately: getUserByUsername's pre-insert
    // lookup (consumer.ts's users loop) only dedupes by username, so this
    // is a genuine Postgres-level users.email UNIQUE (CITEXT) violation on
    // the SECOND insert — proving the catch-and-rewrap path AND the
    // whole-transaction rollback in one real, not-hand-waved scenario.
    const userA = buildUser({ username: 'user-a', email: 'shared@example.com', id: 'bbbbbbbb-0000-4000-8000-000000000001' });
    const userB = buildUser({ username: 'user-b', email: 'shared@example.com', id: 'bbbbbbbb-0000-4000-8000-000000000002' });
    const archive = buildEmptyArchive({ users: [archiveSelfUser, userA, userB] });

    let caught: Error | undefined;
    try {
      await runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-9' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('user-b');
    expect(caught!.message.split('\n').length).toBeLessThanOrEqual(2); // a clean message, not a multi-line stack trace.

    const users = await db.selectFrom('users').select('id').where('username', 'in', ['user-a', 'user-b']).execute();
    expect(users).toHaveLength(0); // rolled back — neither survived.
  });

  it('a later-section duplicate-key failure rolls back everything already written in the SAME transaction', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    const sharedId = 'cccccccc-0000-4000-8000-000000000001';
    const libA = buildLibrary({ id: sharedId, name: 'First Library' });
    const libB = buildLibrary({ id: sharedId, name: 'Second Library (same id)' });
    const movieInA = buildMovie(libA.id, { title: 'Should Not Survive' });
    const archive = buildEmptyArchive({ libraries: [libA, libB], items: [movieInA], users: [archiveSelfUser] });

    let caught: Error | undefined;
    try {
      await runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-10' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message.split('\n').length).toBeLessThanOrEqual(2);

    const libs = await db.selectFrom('libraries').select('id').execute();
    expect(libs).toHaveLength(0);
    const items = await db.selectFrom('catalog_items').select('id').execute();
    expect(items).toHaveLength(0);
  });
});

describe('import consumer: archive-internal uniqueness (AUD-V2-M1)', () => {
  // Before this fix, neither half of this defect threw at all: a duplicate
  // item id silently overwrote the earlier row via upsertCatalogItem's
  // ON CONFLICT DO UPDATE (preserveIds branch, consumer.ts), and a
  // duplicate username was silently absorbed as an in-transaction
  // natural-key "skip" by getUserByUsername's pre-insert lookup — in both
  // cases the whole transaction committed and the job reported success.
  // These cases prove checkReferentialIntegrity now catches BOTH before
  // runImport ever calls withTransaction — the database must be as untouched
  // as if the job had never run at all, which is the actual point of these
  // two tests (not just "it throws").
  it('rejects duplicate item ids in the archive before any write — database untouched', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    const lib = buildLibrary();
    const dupId = 'dddddddd-0000-4000-8000-000000000001';
    // mediaFiles: [] on both — otherwise the placeholder path formula
    // (`loombre-import-placeholder://<itemId>/<index>`, consumer.ts's
    // writeRelations) would ALSO collide on media_files' own path UNIQUE
    // constraint (same itemId, same index 0) and mask the real defect
    // behind an unrelated Postgres error. This case must isolate the
    // catalog_items-level silent ON CONFLICT DO UPDATE overwrite the
    // finding actually names (consumer.ts's preserveIds branch calling
    // upsertCatalogItem), not an incidental FK/unique collision elsewhere.
    const movieA = buildMovie(lib.id, { id: dupId, title: 'Original', mediaFiles: [] });
    const movieB = buildMovie(lib.id, { id: dupId, title: 'Overwriter (duplicate id)', mediaFiles: [] });
    const archive = buildEmptyArchive({ libraries: [lib], items: [movieA, movieB], users: [archiveSelfUser] });

    await expect(runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-13' })).rejects.toThrow(
      new RegExp(dupId)
    );

    const libs = await db.selectFrom('libraries').select('id').execute();
    expect(libs).toHaveLength(0); // not even the library the duplicate items belonged to.
    const items = await db.selectFrom('catalog_items').select('id').execute();
    expect(items).toHaveLength(0);
    const users = await db.selectFrom('users').select('id').execute();
    expect(users).toHaveLength(1); // only the pre-existing requester row — archiveSelfUser was never inserted either.
  });

  it('rejects duplicate usernames within the archive before any write — database untouched', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    const userA = buildUser({ username: 'duplicate-in-archive', id: 'dddddddd-0000-4000-8000-000000000002' });
    const userB = buildUser({ username: 'duplicate-in-archive', id: 'dddddddd-0000-4000-8000-000000000003' });
    const lib = buildLibrary();
    const archive = buildEmptyArchive({ libraries: [lib], users: [archiveSelfUser, userA, userB] });

    await expect(runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-14' })).rejects.toThrow(
      /duplicate-in-archive/
    );

    const libs = await db.selectFrom('libraries').select('id').execute();
    expect(libs).toHaveLength(0);
    const users = await db.selectFrom('users').select('id').execute();
    expect(users).toHaveLength(1); // only the pre-existing requester row.
  });

  // Reviewer reproduction (fix wave 2, FW2-B follow-up): users.username is
  // CITEXT NOT NULL UNIQUE and getUserByUsername compares with a plain `=`,
  // so the database — and now checkReferentialIntegrity — treat "Bob" and
  // "bob" as the same username. Before this fix, runImport() genuinely
  // returned SUCCESS for this exact archive (users: { created: 1, skipped:
  // 1, selfMatched: 1 }, only "Bob" in the table) because the raw-string Map
  // in checkArchiveInternalUniqueness let the two rows through, and
  // consumer.ts's getUserByUsername pre-insert lookup then silently matched
  // "bob" against the already-inserted "Bob" row and took the "skip" branch.
  it('rejects a same-archive username collision that differs only by case (CITEXT) before any write — database untouched', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    const userA = buildUser({ username: 'Bob', id: 'dddddddd-0000-4000-8000-000000000004', email: 'bob-a@example.com' });
    const userB = buildUser({ username: 'bob', id: 'dddddddd-0000-4000-8000-000000000005', email: 'bob-b@example.com' });
    const lib = buildLibrary();
    const archive = buildEmptyArchive({ libraries: [lib], users: [archiveSelfUser, userA, userB] });

    let caught: Error | undefined;
    try {
      await runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-15' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('Bob');
    expect(caught!.message).toContain('bob');

    const libs = await db.selectFrom('libraries').select('id').execute();
    expect(libs).toHaveLength(0);
    const users = await db.selectFrom('users').select('id').execute();
    expect(users).toHaveLength(1); // only the pre-existing requester row — neither "Bob" nor "bob" was ever inserted.
  });
});

describe('import consumer: malformed archive fails before any write', () => {
  it('an archive that fails validation throws before touching the database', async () => {
    const requester = await insertRawUser('importing-admin');
    const badArchive = { exportedAtMs: 1, users: [], libraries: [{ id: 'x' }], items: [], progress: [], playlists: [] };

    await expect(runImport({ db }, { archive: badArchive, requestedByUserId: requester }, { jobId: 'job-11' })).rejects.toThrow(
      /archive\.libraries\[0\]/
    );

    const libs = await db.selectFrom('libraries').select('id').execute();
    expect(libs).toHaveLength(0);
  });
});

describe('import consumer: music hierarchy + genres/people relations', () => {
  it('restores artist->album->track and genre/person relations for a freshly created item', async () => {
    const { requesterId: requester, archiveSelfUser } = await insertRequesterWithSelfMatch();
    const lib = buildLibrary({ mediaKind: 'music', name: 'Music' });
    const artist = buildArtist(lib.id, { genres: ['Rock', 'Indie'] });
    const archive = buildEmptyArchive({ libraries: [lib], items: [artist], users: [archiveSelfUser] });

    await runImport({ db }, { archive, requestedByUserId: requester }, { jobId: 'job-12' });

    const tags = await db
      .selectFrom('item_tags')
      .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
      .select(['tags.name', 'tags.content_class'])
      .where('item_tags.item_id', '=', artist.id)
      .execute();
    expect(tags.map((t) => t.name).sort()).toEqual(['Indie', 'Rock']);
    expect(tags.every((t) => t.content_class === 'general')).toBe(true);
  });
});
