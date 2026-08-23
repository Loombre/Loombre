// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/continue-watching-cursor.spec.ts
//
// Remediation adi-F1: `getContinueWatching` is reachable over HTTP as
// `GET /home/continue-watching`, whose contract (packages/contract/
// openapi.yaml, operation `getContinueWatching`) declares
// `#/components/parameters/Cursor` and a `ContinueWatchingPage` with a
// REQUIRED `nextCursor` — i.e. keyset pagination. The query function was
// written `{limit?}`-only ("not cursor-paginated ... a bounded home row"),
// so with `limit` < the number of in-progress rows every later entry was
// unreachable and a supplied cursor was silently ignored — the exact
// failure mode src/query/cursor.ts's decodeCursor header warns callers
// never to produce ("a confusing 'page 1 again' result").
//
// This suite pins the keyset contract on the SAME (updated_at_ms desc,
// item_id desc) ordering listProgress already pages on (see cursor.ts's
// "tie-break law" header): a full walk at limit=1 visits every row exactly
// once in the same order a single unbounded read returns, a same-
// millisecond tie is broken by item_id rather than skipping/duplicating a
// row, the final page reports `nextCursor: null`, and a cursor this server
// did not mint raises MalformedCursorError (which apps/server's
// ProblemJsonExceptionFilter renders as 422) instead of being ignored.
//
// SELF-SUFFICIENT (test/chapter-markers.spec.ts's shape): resets the
// schema and inserts its own library/user/items/progress rows — no
// seed/seed.mjs dependency, because the ordering assertions below need
// exact, hand-chosen updated_at_ms values (including a deliberate tie).
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import type { ViewerContext } from '../src/context.js';
import { getContinueWatching } from '../src/query/progress.js';
import { MalformedCursorError } from '../src/query/cursor.js';
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
let ctx: ViewerContext;

/** Titles in the order getContinueWatching must return them: updated_at_ms
 *  DESC, then item_id DESC. "Tie A"/"Tie B" share one updated_at_ms on
 *  purpose — which of the two sorts first is decided by item_id and is
 *  resolved at insert time below, so the expectation is built from the
 *  inserted ids rather than hardcoded. */
const BASE_MS = 1_800_000_000_000;
let expectedOrder: string[] = []; // item ids, newest-first

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({
      name: 'Continue Watching Cursor Test Library',
      media_kind: 'movie',
      paths: [],
      content_class: 'general',
      created_at_ms: now,
      updated_at_ms: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const user = await db
    .insertInto('users')
    .values({
      username: `cw-cursor-${randomUUID()}`,
      email: `cw-cursor-${randomUUID()}@example.invalid`,
      password_hash: 'test-fixture-not-a-real-hash',
      is_admin: false,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  ctx = { userId: user.id, allowedLibraryIds: [lib.id], restrictedCleared: false };

  // Five in-progress rows. Two of them (Tie A/Tie B) share an
  // updated_at_ms so the secondary item_id key is load-bearing.
  const fixtures: Array<{ title: string; updatedAtMs: number }> = [
    { title: 'Newest', updatedAtMs: BASE_MS + 5_000 },
    { title: 'Tie A', updatedAtMs: BASE_MS + 4_000 },
    { title: 'Tie B', updatedAtMs: BASE_MS + 4_000 },
    { title: 'Older', updatedAtMs: BASE_MS + 3_000 },
    { title: 'Oldest', updatedAtMs: BASE_MS + 2_000 },
  ];

  const inserted: Array<{ id: string; updatedAtMs: number }> = [];
  for (const fixture of fixtures) {
    const item = await db
      .insertInto('catalog_items')
      .values({
        library_id: lib.id,
        item_type: 'movie',
        title: fixture.title,
        sort_title: fixture.title.toLowerCase(),
        added_at_ms: now,
        updated_at_ms: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto('progress')
      .values({
        user_id: user.id,
        item_id: item.id,
        position_ms: 1_000,
        state: 'in-progress',
        play_count: 0,
        updated_at_ms: fixture.updatedAtMs,
      })
      .execute();

    inserted.push({ id: item.id, updatedAtMs: fixture.updatedAtMs });
  }

  // A 'played' row must never appear in continue-watching — it is what
  // keeps the walk below from silently paging over the wrong result set.
  const playedItem = await db
    .insertInto('catalog_items')
    .values({
      library_id: lib.id,
      item_type: 'movie',
      title: 'Played',
      sort_title: 'played',
      added_at_ms: now,
      updated_at_ms: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto('progress')
    .values({
      user_id: user.id,
      item_id: playedItem.id,
      position_ms: 9_000,
      state: 'played',
      play_count: 1,
      updated_at_ms: BASE_MS + 6_000,
    })
    .execute();

  expectedOrder = inserted
    .slice()
    .sort((a, b) => (b.updatedAtMs - a.updatedAtMs) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((r) => r.id);
});

afterAll(async () => {
  await db?.destroy();
});

function forge(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('adi-F1: getContinueWatching is keyset-paginated like every other list surface', () => {
  it('an unbounded read returns every in-progress row, newest-updated first, with nextCursor null', async () => {
    const page = await getContinueWatching(db, ctx, { limit: 100 });
    expect(page.rows.map((r) => r.itemId)).toEqual(expectedOrder);
    expect(page.nextCursor).toBeNull();
  });

  it('a limit=1 walk reaches EVERY entry exactly once, in the same order (the defect: page 2+ was unreachable)', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let hop = 0; hop < 20; hop += 1) {
      const page: { rows: Array<{ itemId: string }>; nextCursor: string | null } = await getContinueWatching(
        db,
        ctx,
        cursor === undefined ? { limit: 1 } : { limit: 1, cursor }
      );
      seen.push(...page.rows.map((r) => r.itemId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(expectedOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a limit=2 walk (page boundary lands inside the same-millisecond tie) neither skips nor duplicates a row', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let hop = 0; hop < 20; hop += 1) {
      const page = await getContinueWatching(db, ctx, cursor === undefined ? { limit: 2 } : { limit: 2, cursor });
      seen.push(...page.rows.map((r) => r.itemId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(expectedOrder);
  });

  it('the last page reports nextCursor null even when it is exactly full', async () => {
    // 5 rows, limit 5: the page is full, but there is nothing after it.
    const page = await getContinueWatching(db, ctx, { limit: 5 });
    expect(page.rows).toHaveLength(5);
    // A full page may optimistically mint a cursor (listProgress does);
    // following it must then yield an EMPTY page with nextCursor null,
    // never a repeat of page 1.
    if (page.nextCursor !== null) {
      const after = await getContinueWatching(db, ctx, { limit: 5, cursor: page.nextCursor });
      expect(after.rows).toHaveLength(0);
      expect(after.nextCursor).toBeNull();
    }
  });

  it('a cursor this server did not mint raises MalformedCursorError (apps/server renders 422), never a silent page 1', async () => {
    // NOT included: the empty string. `?cursor=` reaches the query layer as
    // `''`, which listProgress's own `if (params.cursor)` treats as "no
    // cursor supplied" — matching that is deliberate, not an oversight.
    for (const cursor of ['@@@', 'not-base64url-json', forge({ nope: true }), forge({ updatedAtMs: 1, itemId: 'not-a-uuid' })]) {
      await expect(getContinueWatching(db, ctx, { limit: 2, cursor })).rejects.toThrow(MalformedCursorError);
    }
  });
});
