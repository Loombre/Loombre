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
