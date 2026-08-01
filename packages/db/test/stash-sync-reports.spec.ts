// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/stash-sync-reports.spec.ts
//
// Live-DB tests for src/query/stash-sync-reports.ts (STATE.md S8/K14,
// migrations/0020_stash_sync_reports.sql) — mirrors stash-inventory.spec.ts's
// own reset+reseed convention. Covers: the report create/finish round trip,
// getLatestStashSyncReport ordering across multiple historical runs,
// findRunningStashSyncReport locating the in-flight row and ignoring
// finished ones (the onTerminalFailure hook's lookup), and the K14 live
// unmatched/stale keyset lists (including pagination across a page
// boundary and the stale-flip-back-false behavior stash-inventory.ts's
// own upsert already guarantees).
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { upsertStashSceneLinksFromInventory } from '../src/query/stash-inventory.js';
import {
  createStashSyncReport,
  finishStashSyncReport,
  findRunningStashSyncReport,
  getLatestStashSyncReport,
  listStaleStashScenes,
  listUnmatchedStashScenes,
} from '../src/query/stash-sync-reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

async function makeRestrictedLibrary(): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('libraries')
    .values({ name: `stash-sync-lib-${randomUUID()}`, media_kind: 'movie', paths: [], content_class: 'restricted', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('stash-sync-reports (S8/K14)', () => {
  it('create -> finish round trip persists counts and status', async () => {
    const libraryId = await makeRestrictedLibrary();
    const jobId = randomUUID();
    const started = Date.now();

    const created = await createStashSyncReport(db, { libraryId, jobId, mode: 'full', startedAtMs: started });
    expect(created.status).toBe('running');
    expect(created.finished_at_ms).toBeNull();

    const finished = await finishStashSyncReport(db, created.id, {
      status: 'succeeded',
      matchedCount: 10,
      updatedCount: 3,
      unmatchedCount: 2,
      staleCount: 1,
      skippedCount: 0,
      finishedAtMs: started + 5000,
    });

    expect(finished.status).toBe('succeeded');
    expect(finished.matched_count).toBe(10);
    expect(finished.updated_count).toBe(3);
    expect(finished.unmatched_count).toBe(2);
    expect(finished.stale_count).toBe(1);
    expect(finished.finished_at_ms).toBe(started + 5000);
  });

  it('getLatestStashSyncReport returns the most recently STARTED row, not insertion order', async () => {
    const libraryId = await makeRestrictedLibrary();
    const older = await createStashSyncReport(db, { libraryId, jobId: randomUUID(), mode: 'full', startedAtMs: 1000 });
    await finishStashSyncReport(db, older.id, { status: 'succeeded', matchedCount: 1, updatedCount: 0, unmatchedCount: 0, staleCount: 0, skippedCount: 0, finishedAtMs: 1500 });

    const newer = await createStashSyncReport(db, { libraryId, jobId: randomUUID(), mode: 'incremental', startedAtMs: 5000 });
    await finishStashSyncReport(db, newer.id, { status: 'succeeded', matchedCount: 2, updatedCount: 1, unmatchedCount: 0, staleCount: 0, skippedCount: 0, finishedAtMs: 5200 });

    const latest = await getLatestStashSyncReport(db, libraryId);
    expect(latest?.id).toBe(newer.id);
    expect(latest?.mode).toBe('incremental');
  });

  it('getLatestStashSyncReport returns undefined when no sync has ever run for the library', async () => {
    const libraryId = await makeRestrictedLibrary();
    const latest = await getLatestStashSyncReport(db, libraryId);
    expect(latest).toBeUndefined();
  });

  it('findRunningStashSyncReport locates the in-flight row and ignores finished ones', async () => {
    const libraryId = await makeRestrictedLibrary();
    const finished = await createStashSyncReport(db, { libraryId, jobId: randomUUID(), mode: 'full', startedAtMs: 1000 });
    await finishStashSyncReport(db, finished.id, { status: 'succeeded', matchedCount: 0, updatedCount: 0, unmatchedCount: 0, staleCount: 0, skippedCount: 0, finishedAtMs: 1100 });

    expect(await findRunningStashSyncReport(db, libraryId)).toBeUndefined();

    const running = await createStashSyncReport(db, { libraryId, jobId: randomUUID(), mode: 'incremental', startedAtMs: 2000 });
    const found = await findRunningStashSyncReport(db, libraryId);
    expect(found?.id).toBe(running.id);
  });

  it('listUnmatchedStashScenes: only item_id IS NULL rows, keyset-paginated, ordered by stash_scene_id', async () => {
    const libraryId = await makeRestrictedLibrary();
    const now = Date.now();
    // 5 unmatched scenes, ids sorted lexically as strings.
    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      ['s1', 's2', 's3', 's4', 's5'].map((id) => ({ stashSceneId: id, stashPath: `/data/${id}.mp4`, stashSizeBytes: 100, stashOshash: null, stashUpdatedAtMs: now })),
      now
    );

    const page1 = await listUnmatchedStashScenes(db, libraryId, { limit: 2 });
    expect(page1.rows.map((r) => r.stashSceneId)).toEqual(['s1', 's2']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listUnmatchedStashScenes(db, libraryId, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.rows.map((r) => r.stashSceneId)).toEqual(['s3', 's4']);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listUnmatchedStashScenes(db, libraryId, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.rows.map((r) => r.stashSceneId)).toEqual(['s5']);
    expect(page3.nextCursor).toBeNull();
  });

  it('listStaleStashScenes: only stale = TRUE rows, and reappearing (a fresh inventory upsert) flips a scene back out of the list', async () => {
    const libraryId = await makeRestrictedLibrary();
    const now = Date.now();
    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: 'stale-1', stashPath: '/data/stale-1.mp4', stashSizeBytes: 100, stashOshash: null, stashUpdatedAtMs: now }],
      now
    );
    await db.updateTable('stash_scene_links').set({ stale: true }).where('library_id', '=', libraryId).where('stash_scene_id', '=', 'stale-1').execute();

    const before = await listStaleStashScenes(db, libraryId);
    expect(before.rows.map((r) => r.stashSceneId)).toEqual(['stale-1']);

    // A fresh inventory pass seeing the scene again unconditionally clears
    // `stale` (stash-inventory.ts's own documented behavior) — the live
    // list reflects that immediately, no separate "un-stale" call needed.
    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: 'stale-1', stashPath: '/data/stale-1.mp4', stashSizeBytes: 100, stashOshash: null, stashUpdatedAtMs: now + 1000 }],
      now + 1000
    );

    const after = await listStaleStashScenes(db, libraryId);
    expect(after.rows).toEqual([]);
  });
});
