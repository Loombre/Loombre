// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/internal.spec.ts
//
// Live-DB tests for src/internal (P1.13, the guard-free scanner/import
// writer module — see src/internal/index.ts's header for why it is
// guard-free by design). SELF-SUFFICIENT like test/leak.spec.ts: beforeAll
// resets the schema and seeds a minimal fixture set of its own (a library,
// a user, one catalog item, one media_files row) — this suite does not
// depend on seed/seed.mjs's shape. See vitest.config.ts for why this
// package's test files run sequentially (both specs reset the schema).
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
import {
  findFileByContentHash,
  findFileByPath,
  relinkFile,
  markFileMissing,
  replaceFileStreams,
  writeEvent,
  upsertProviderCacheEntry,
  getProviderCacheEntry,
  writeCheckpoint,
  getCheckpoint,
  withTransaction,
  upsertProviderId,
  getProviderIdsForItem,
  findOrCreatePerson,
  replaceItemPeople,
  findOrCreateTag,
  replaceItemTags,
  upsertImage,
} from '../src/internal/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

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

let userId: string;
let libraryId: string;
let itemId: string;
let fileId: string;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);

  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  const now = Date.now();

  const userRow = await rawClient.query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
     VALUES ('internal-test', 'internal-test@loombre.local', 'x', $1, $1)
     RETURNING id`,
    [now]
  );
  userId = userRow.rows[0]!.id;

  const libRow = await rawClient.query<{ id: string }>(
    `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
     VALUES ('Internal Test Library', 'movie', '{}', $1, $1)
     RETURNING id`,
    [now]
  );
  libraryId = libRow.rows[0]!.id;

  const itemRow = await rawClient.query<{ id: string }>(
    `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
     VALUES ($1, 'movie', 'Internal Test Movie', 'internal test movie', $2, $2)
     RETURNING id`,
    [libraryId, now]
  );
  itemId = itemRow.rows[0]!.id;

  const fileRow = await rawClient.query<{ id: string }>(
    `INSERT INTO media_files (item_id, path, content_hash)
     VALUES ($1, '/media/original/path.mkv', 'deadbeef')
     RETURNING id`,
    [itemId]
  );
  fileId = fileRow.rows[0]!.id;

  await rawClient.query(
    `INSERT INTO progress (user_id, item_id, position_ms, state, updated_at_ms)
     VALUES ($1, $2, 12345, 'in-progress', $3)`,
    [userId, itemId, now]
  );
});

afterAll(async () => {
  await db?.destroy();
  await rawClient?.end();
});

describe('src/internal (P1.13)', () => {
  describe('relinkFile', () => {
    it('re-points path, clears missing_since_ms, and preserves the item + progress row untouched', async () => {
      await markFileMissing(db, fileId, Date.now());
      const missing = await findFileByPath(db, '/media/original/path.mkv');
      expect(missing?.missing_since_ms).not.toBeNull();

      const relinked = await relinkFile(db, fileId, '/media/renamed/path.mkv');
      expect(relinked.id).toBe(fileId);
      expect(relinked.path).toBe('/media/renamed/path.mkv');
      expect(relinked.missing_since_ms).toBeNull();
      // Content hash / item_id are untouched by relinkFile.
      expect(relinked.item_id).toBe(itemId);
      expect(relinked.content_hash).toBe('deadbeef');

      const byHash = await findFileByContentHash(db, 'deadbeef');
      expect(byHash?.id).toBe(fileId);
      expect(byHash?.path).toBe('/media/renamed/path.mkv');

      // Progress row for this item is untouched: same position, same state.
      const progressRow = await rawClient.query<{ position_ms: number; state: string }>(
        'SELECT position_ms, state FROM progress WHERE user_id = $1 AND item_id = $2',
        [userId, itemId]
      );
      expect(progressRow.rows).toHaveLength(1);
      expect(progressRow.rows[0]).toEqual({ position_ms: 12345, state: 'in-progress' });

      // relinkFile emits nothing itself: no events rows exist unless a
      // caller separately calls writeEvent.
      const eventCount = await rawClient.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM events WHERE type = 'file.relocated'"
      );
      expect(eventCount.rows[0]!.n).toBe(0);
    });
  });

  describe('replaceFileStreams', () => {
    it('atomically replaces the full stream list for a file (delete+insert in one transaction)', async () => {
      const first = await replaceFileStreams(db, fileId, [
        {
          streamIndex: 0,
          streamType: 'video',
          codec: 'hevc',
          width: 3840,
          height: 2160,
          hdr: 'hdr10',
          interlaced: false,
        },
        { streamIndex: 1, streamType: 'audio', codec: 'eac3', channels: 6, hasAtmos: true },
      ]);
      expect(first).toHaveLength(2);

      const afterFirst = await rawClient.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM media_streams WHERE file_id = $1',
        [fileId]
      );
      expect(afterFirst.rows[0]!.n).toBe(2);

      // Re-probe with a different stream count — the old rows must be gone,
      // not merged with the new ones.
      const second = await replaceFileStreams(db, fileId, [
        { streamIndex: 0, streamType: 'video', codec: 'h264', width: 1920, height: 1080 },
      ]);
      expect(second).toHaveLength(1);

      const afterSecond = await rawClient.query<{ codec: string }>(
        'SELECT codec FROM media_streams WHERE file_id = $1',
        [fileId]
      );
      expect(afterSecond.rows).toHaveLength(1);
      expect(afterSecond.rows[0]!.codec).toBe('h264');
    });

    it('rolls back cleanly if insert fails partway (atomicity): old rows survive', async () => {
      await replaceFileStreams(db, fileId, [
        { streamIndex: 0, streamType: 'video', codec: 'h264' },
      ]);

      await expect(
        replaceFileStreams(db, fileId, [
          // stream_type must be one of ('video','audio','subtitle') —
          // an invalid enum value fails the INSERT after the DELETE has
          // already run inside the same transaction, so the transaction
          // must roll back and restore the deleted row.
          { streamIndex: 0, streamType: 'bogus' as never, codec: 'h264' },
        ])
      ).rejects.toThrow();

      const rows = await rawClient.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM media_streams WHERE file_id = $1',
        [fileId]
      );
      expect(rows.rows[0]!.n).toBe(1);
    });
  });

  describe('checkpoint read/write', () => {
    it('roundtrips a scan_checkpoints row and upserts on the same job_id', async () => {
      const jobId = '018f6f1e-0000-7000-8000-00000000abcd';

      const written = await writeCheckpoint(db, {
        jobId,
        libraryId,
        phase: 'discover',
        lastProcessedPath: '/media/a.mkv',
        filesSeen: 10,
        filesProcessed: 3,
        updatedAtMs: 1000,
      });
      expect(written.job_id).toBe(jobId);

      const read = await getCheckpoint(db, jobId);
      expect(read).toBeDefined();
      expect(read?.phase).toBe('discover');
      expect(read?.files_seen).toBe(10);
      expect(read?.files_processed).toBe(3);

      const updated = await writeCheckpoint(db, {
        jobId,
        libraryId,
        phase: 'probe',
        lastProcessedPath: '/media/z.mkv',
        filesSeen: 10,
        filesProcessed: 9,
        updatedAtMs: 2000,
      });
      expect(updated.phase).toBe('probe');

      const reread = await getCheckpoint(db, jobId);
      expect(reread?.phase).toBe('probe');
      expect(reread?.files_processed).toBe(9);

      const rowCount = await rawClient.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM scan_checkpoints WHERE job_id = $1',
        [jobId]
      );
      expect(rowCount.rows[0]!.n).toBe(1);
    });
  });

  describe('provider cache roundtrip + expiry filter', () => {
    it('roundtrips a cache entry and excludes expired entries', async () => {
      const now = 1_000_000;

      await upsertProviderCacheEntry(db, {
        provider: 'tmdb',
        requestHash: 'movie:123',
        body: JSON.stringify({ title: 'Example' }),
        fetchedAtMs: now,
        expiresAtMs: now + 10_000,
      });

      const fresh = await getProviderCacheEntry(db, 'tmdb', 'movie:123', now + 5_000);
      expect(fresh).toBeDefined();
      expect(JSON.parse(fresh!.body)).toEqual({ title: 'Example' });

      const expired = await getProviderCacheEntry(db, 'tmdb', 'movie:123', now + 20_000);
      expect(expired).toBeUndefined();

      // Upsert on (provider, request_hash) replaces the body/expiry in place.
      await upsertProviderCacheEntry(db, {
        provider: 'tmdb',
        requestHash: 'movie:123',
        body: JSON.stringify({ title: 'Example v2' }),
        fetchedAtMs: now + 20_000,
        expiresAtMs: now + 30_000,
      });
      const rowCount = await rawClient.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM provider_cache WHERE provider = 'tmdb' AND request_hash = 'movie:123'"
      );
      expect(rowCount.rows[0]!.n).toBe(1);

      const refreshed = await getProviderCacheEntry(db, 'tmdb', 'movie:123', now + 25_000);
      expect(JSON.parse(refreshed!.body)).toEqual({ title: 'Example v2' });
    });
  });

  describe('writeEvent inside a transaction', () => {
    it('the event row does not survive a rolled-back transaction', async () => {
      const marker = `rollback-test-${Date.now()}`;

      await expect(
        withTransaction(db, async (trx) => {
          await writeEvent(trx, {
            type: marker,
            tsMs: Date.now(),
            actorUserId: null,
            payload: { marker },
          });
          throw new Error('deliberate rollback');
        })
      ).rejects.toThrow('deliberate rollback');

      const rows = await rawClient.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM events WHERE type = $1',
        [marker]
      );
      expect(rows.rows[0]!.n).toBe(0);
    });

    it('the event row survives a committed transaction', async () => {
      const marker = `commit-test-${Date.now()}`;

      await withTransaction(db, async (trx) => {
        await writeEvent(trx, {
          type: marker,
          tsMs: Date.now(),
          actorUserId: null,
          payload: { marker },
        });
      });

      const rows = await rawClient.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM events WHERE type = $1',
        [marker]
      );
      expect(rows.rows[0]!.n).toBe(1);
    });
  });

  describe('provider_ids', () => {
    it('upserts on (item_id, provider) and getProviderIdsForItem reads them back', async () => {
      await upsertProviderId(db, { itemId, provider: 'tmdb', externalId: '603' });
      await upsertProviderId(db, { itemId, provider: 'imdb', externalId: 'tt0133093' });
      // Re-upsert the same provider replaces the external id in place.
      await upsertProviderId(db, { itemId, provider: 'tmdb', externalId: '604' });

      const rows = await getProviderIdsForItem(db, itemId);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.provider === 'tmdb')?.external_id).toBe('604');
      expect(rows.find((r) => r.provider === 'imdb')?.external_id).toBe('tt0133093');
    });
  });

  describe('upsertImage NULL-width original (0004 NULLS NOT DISTINCT)', () => {
    it('re-running the original-image upsert updates in place instead of duplicating', async () => {
      const base = {
        entityType: 'catalog_item',
        entityId: itemId,
        kind: 'poster' as const,
        source: 'local' as const,
        width: null,
        height: null,
        blurhash: null,
        filePath: '/data/images/a/poster-orig.webp',
        createdAtMs: 1,
      };
      await upsertImage(db, base);
      await upsertImage(db, { ...base, filePath: '/data/images/a/poster-orig-v2.webp', createdAtMs: 2 });

      const rows = await db
        .selectFrom('images')
        .selectAll()
        .where('entity_id', '=', itemId)
        .where('kind', '=', 'poster')
        .where('width', 'is', null)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.file_path).toBe('/data/images/a/poster-orig-v2.webp');
    });
  });

  describe('people / item_people', () => {
    it('findOrCreatePerson is idempotent per (name, content_class), and content classes never collapse into one row', async () => {
      const first = await findOrCreatePerson(db, 'Jane Doe', 'general');
      const second = await findOrCreatePerson(db, 'Jane Doe', 'general');
      expect(second.id).toBe(first.id);

      const restricted = await findOrCreatePerson(db, 'Jane Doe', 'restricted');
      expect(restricted.id).not.toBe(first.id);
    });

    it('replaceItemPeople atomically replaces the full cast/crew list for an item', async () => {
      const alice = await findOrCreatePerson(db, 'Alice Actor', 'general');
      const bob = await findOrCreatePerson(db, 'Bob Director', 'general');

      const first = await replaceItemPeople(db, itemId, [
        { personId: alice.id, role: 'actor', credit: 'Lead', order: 0 },
        { personId: bob.id, role: 'director', order: 1 },
      ]);
      expect(first).toHaveLength(2);

      // Re-probe with a smaller cast — the old rows must be gone, not merged.
      const second = await replaceItemPeople(db, itemId, [{ personId: alice.id, role: 'actor', credit: 'Lead', order: 0 }]);
      expect(second).toHaveLength(1);

      const rows = await rawClient.query<{ n: number }>('SELECT count(*)::int AS n FROM item_people WHERE item_id = $1', [itemId]);
      expect(rows.rows[0]!.n).toBe(1);
    });
  });

  describe('tags / item_tags', () => {
    it('findOrCreateTag upserts on (name, content_class)', async () => {
      const first = await findOrCreateTag(db, 'Heist', 'general');
      const second = await findOrCreateTag(db, 'Heist', 'general');
      expect(second.id).toBe(first.id);

      const restricted = await findOrCreateTag(db, 'Heist', 'restricted');
      expect(restricted.id).not.toBe(first.id);
    });

    it('replaceItemTags atomically replaces the full genre/tag list for an item', async () => {
      const action = await findOrCreateTag(db, 'Action', 'general');
      const heist = await findOrCreateTag(db, 'Heist', 'general');

      const first = await replaceItemTags(db, itemId, [
        { tagId: action.id, kind: 'genre' },
        { tagId: heist.id, kind: 'tag' },
      ]);
      expect(first).toHaveLength(2);

      const second = await replaceItemTags(db, itemId, [{ tagId: action.id, kind: 'genre' }]);
      expect(second).toHaveLength(1);

      const rows = await rawClient.query<{ n: number }>('SELECT count(*)::int AS n FROM item_tags WHERE item_id = $1', [itemId]);
      expect(rows.rows[0]!.n).toBe(1);
    });
  });
});
