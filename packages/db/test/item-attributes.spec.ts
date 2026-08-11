// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/item-attributes.spec.ts
//
// Live-DB tests for src/internal/item-attributes.ts (Stash mission,
// STATE.md S5/K11 — item_attributes had no internal writer module before
// this). SELF-SUFFICIENT like test/internal.spec.ts: beforeAll resets the
// schema and seeds a minimal fixture of its own.
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
import { getItemAttributes, upsertItemAttribute } from '../src/internal/index.js';
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
let otherItemId: string;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({ name: 'Item Attributes Test Library', media_kind: 'movie', paths: [], content_class: 'restricted', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();

  const item = await db
    .insertInto('catalog_items')
    .values({ library_id: lib.id, item_type: 'movie', title: 'Attrs Movie', sort_title: 'attrs movie', added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  itemId = item.id;

  const other = await db
    .insertInto('catalog_items')
    .values({ library_id: lib.id, item_type: 'movie', title: 'Other Movie', sort_title: 'other movie', added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  otherItemId = other.id;
});

afterAll(async () => {
  await db?.destroy();
});

describe('item-attributes', () => {
  it('upsertItemAttribute inserts a new (item_id, namespace, key) row', async () => {
    const row = await upsertItemAttribute(db, { itemId, namespace: 'stash', key: 'sceneId', value: { sceneId: '42' } });
    expect(row.item_id).toBe(itemId);
    expect(row.namespace).toBe('stash');
    expect(row.key).toBe('sceneId');
    expect(row.value).toEqual({ sceneId: '42' });
  });

  it('re-upserting the SAME key updates value in place — same row id, no duplicate row', async () => {
    const first = await upsertItemAttribute(db, { itemId, namespace: 'stash', key: 'rating100', value: { rating100: 85 } });
    const second = await upsertItemAttribute(db, { itemId, namespace: 'stash', key: 'rating100', value: { rating100: 90 } });
    expect(second.id).toBe(first.id);
    expect(second.value).toEqual({ rating100: 90 });

    const rows = await getItemAttributes(db, itemId, 'stash');
    expect(rows.filter((r) => r.key === 'rating100')).toHaveLength(1);
  });

  it('re-upserting with the IDENTICAL value is a no-op observably (same id, same value, no extra row)', async () => {
    const first = await upsertItemAttribute(db, { itemId, namespace: 'stash', key: 'code', value: { code: 'ABC-123' } });
    const second = await upsertItemAttribute(db, { itemId, namespace: 'stash', key: 'code', value: { code: 'ABC-123' } });
    expect(second.id).toBe(first.id);
    expect(second.value).toEqual({ code: 'ABC-123' });

    const rows = await getItemAttributes(db, itemId, 'stash');
    expect(rows.filter((r) => r.key === 'code')).toHaveLength(1);
  });

  it('different namespaces on the same item never collide', async () => {
    await upsertItemAttribute(db, { itemId, namespace: 'stash', key: 'director', value: { director: 'A' } });
    await upsertItemAttribute(db, { itemId, namespace: 'other-namespace', key: 'director', value: { director: 'B' } });

    const stashRows = await getItemAttributes(db, itemId, 'stash');
    const otherRows = await getItemAttributes(db, itemId, 'other-namespace');
    expect(stashRows.find((r) => r.key === 'director')?.value).toEqual({ director: 'A' });
    expect(otherRows.find((r) => r.key === 'director')?.value).toEqual({ director: 'B' });
  });

  it('attributes are scoped per item — a second item never sees the first item\'s rows', async () => {
    await upsertItemAttribute(db, { itemId, namespace: 'stash', key: 'organized', value: { organized: true } });
    const otherRows = await getItemAttributes(db, otherItemId, 'stash');
    expect(otherRows.find((r) => r.key === 'organized')).toBeUndefined();
  });
});
