// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/chapter-markers.spec.ts
//
// Live-DB tests for src/internal/chapter-markers.ts (migrations/0019 K9/S7
// — Stash scene markers become player chapters). SELF-SUFFICIENT like
// test/internal.spec.ts.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { getChapterMarkers, replaceChapterMarkers } from '../src/internal/index.js';
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
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;
let itemId: string;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({ name: 'Chapter Markers Test Library', media_kind: 'movie', paths: [], content_class: 'restricted', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  const item = await db
    .insertInto('catalog_items')
    .values({ library_id: lib.id, item_type: 'movie', title: 'Markers Movie', sort_title: 'markers movie', added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  itemId = item.id;
});

afterAll(async () => {
  await db?.destroy();
});

describe('chapter-markers', () => {
  it('replaceChapterMarkers inserts the full marker set, ordered by start_ms on read', async () => {
    const rows = await replaceChapterMarkers(db, itemId, [
      { title: 'Second', startMs: 45_000, source: 'stash' },
      { title: 'First', startMs: 30_500, source: 'stash' },
    ]);
    expect(rows).toHaveLength(2);

    const read = await getChapterMarkers(db, itemId);
    expect(read.map((r) => r.title)).toEqual(['First', 'Second']);
    expect(read.map((r) => r.start_ms)).toEqual([30_500, 45_000]);
    expect(read.every((r) => r.source === 'stash')).toBe(true);
  });

  it('a second call wholesale-REPLACES the set — old rows are gone, not merged', async () => {
    await replaceChapterMarkers(db, itemId, [{ title: 'Only', startMs: 1_000, source: 'stash' }]);
    const rows = await getChapterMarkers(db, itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Only');
  });

  it('an empty marker list clears every existing row for the item', async () => {
    await replaceChapterMarkers(db, itemId, [{ title: 'Will be cleared', startMs: 500, source: 'stash' }]);
    const cleared = await replaceChapterMarkers(db, itemId, []);
    expect(cleared).toHaveLength(0);
    expect(await getChapterMarkers(db, itemId)).toHaveLength(0);
  });

  it('two markers at the identical offset are both preserved (no uniqueness on (item_id, start_ms))', async () => {
    const rows = await replaceChapterMarkers(db, itemId, [
      { title: 'A', startMs: 10_000, source: 'stash' },
      { title: 'B', startMs: 10_000, source: 'stash' },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('getChapterMarkers: two markers at the identical start_ms sort deterministically by id (Task #9 Class A fix), not by an unspecified tie order', async () => {
    await replaceChapterMarkers(db, itemId, []); // clear this item's rows first
    // Explicit ids (bypassing replaceChapterMarkers, which cannot pin an
    // id) chosen so lexicographic (id ASC) order is the REVERSE of insert
    // order — same forced-tie technique as packages/jobs/test/
    // ledger-events.spec.ts for migration 0039_events_seq.sql, applied to
    // start_ms instead of a timestamp column.
    await db
      .insertInto('chapter_markers')
      .values([
        { id: 'ffffffff-ffff-7fff-8fff-ffffffffffd1', item_id: itemId, title: 'Inserted first, greatest id', start_ms: 20_000, source: 'stash' },
        { id: '00000000-0000-7000-8000-000000000d01', item_id: itemId, title: 'Inserted second, smallest id', start_ms: 20_000, source: 'stash' },
      ])
      .execute();

    const first = await getChapterMarkers(db, itemId);
    expect(first.map((r) => r.title)).toEqual(['Inserted second, smallest id', 'Inserted first, greatest id']);

    // Repeatability, not a single lucky observation.
    const second = await getChapterMarkers(db, itemId);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it('markers are scoped per item — replacing one item never touches another\'s rows', async () => {
    const now = Date.now();
    const lib = await db.selectFrom('libraries').selectAll().executeTakeFirstOrThrow();
    const otherItem = await db
      .insertInto('catalog_items')
      .values({ library_id: lib.id, item_type: 'movie', title: 'Other Markers Movie', sort_title: 'other markers movie', added_at_ms: now, updated_at_ms: now })
      .returningAll()
      .executeTakeFirstOrThrow();

    await replaceChapterMarkers(db, itemId, [{ title: 'Mine', startMs: 1_000, source: 'stash' }]);
    await replaceChapterMarkers(db, otherItem.id, [{ title: 'Theirs', startMs: 2_000, source: 'stash' }]);

    expect((await getChapterMarkers(db, itemId)).map((r) => r.title)).toEqual(['Mine']);
    expect((await getChapterMarkers(db, otherItem.id)).map((r) => r.title)).toEqual(['Theirs']);
  });
});
