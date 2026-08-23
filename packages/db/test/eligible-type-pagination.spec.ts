// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/eligible-type-pagination.spec.ts
//
// Remediation adi-F2: `listItems`/`getRecentlyAdded`/`searchCatalog` page
// over EVERY item type; their HTTP callers (apps/server's GET
// /home/recently-added and GET /search) can only render a SUBSET of
// ItemType, and used to cut that subset out of the page the query layer had
// already limited. The keyset LIMIT was therefore spent on rows the caller
// discarded: short pages, and at limit=1 routinely EMPTY pages, each still
// carrying a non-null `nextCursor`.
//
// The `itemTypes` parameter this suite pins is the fix — the filter runs
// BEFORE ORDER BY/LIMIT, so a page is `limit` rows the caller can use.
// Pinned here rather than only over HTTP because two rules are invisible
// from the API: an OMITTED `itemTypes` must keep the every-type behaviour
// other callers depend on (src/query/export.ts pages the whole catalog
// through listItems), and an EMPTY array must mean "nothing matches"
// rather than degrading to "no filter" — kysely renders `eb.or([])` as
// `1 = 0`, and a caller computing the set dynamically must never silently
// widen back to every type.
//
// SELF-SUFFICIENT (test/continue-watching-cursor.spec.ts's shape): resets
// the schema and inserts its own library/user/items — the ordering
// assertions need exact, hand-chosen added_at_ms values, in particular a
// NEWEST row of an ineligible type (the live shape the report captured,
// where page 0 itself came back empty).
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
import type { DB, ItemType } from '../src/types.js';
import type { ViewerContext } from '../src/context.js';
import { getRecentlyAdded, listItems } from '../src/query/items.js';
import { searchCatalog } from '../src/query/search.js';
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

/** The endpoint subset under test: RecentlyAddedEntry's discriminator
 *  (packages/contract/openapi.yaml). */
const RECENTLY_ADDED_TYPES: readonly ItemType[] = ['movie', 'series', 'album'];

const BASE_MS = 1_800_000_000_000;

/** Newest LAST in this list; every title shares the token "signal" so one
 *  websearch_to_tsquery matches all of them. The two newest rows are an
 *  EPISODE and a SEASON — ineligible for both endpoints — which is what
 *  made page 0 come back empty at limit=1. */
const FIXTURES: Array<{ title: string; itemType: ItemType }> = [
  { title: 'Alpha Signal', itemType: 'movie' },
  { title: 'Bravo Signal', itemType: 'episode' },
  { title: 'Charlie Signal', itemType: 'series' },
  { title: 'Delta Signal', itemType: 'track' },
  { title: 'Echo Signal', itemType: 'album' },
  { title: 'Foxtrot Signal', itemType: 'movie' },
  { title: 'Golf Signal', itemType: 'season' },
  { title: 'Hotel Signal', itemType: 'episode' },
];

/** Ids of the eligible fixtures, newest-added first — the exact order
 *  getRecentlyAdded must return them in. */
let expectedEligible: string[] = [];

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({
      name: 'Eligible Type Pagination Test Library',
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
      username: `eligible-types-${randomUUID()}`,
      email: `eligible-types-${randomUUID()}@example.invalid`,
      password_hash: 'test-fixture-not-a-real-hash',
      is_admin: false,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  ctx = { userId: user.id, allowedLibraryIds: [lib.id], restrictedCleared: false };

  const inserted: Array<{ id: string; itemType: ItemType; addedAtMs: number }> = [];
  for (const [i, fixture] of FIXTURES.entries()) {
    const addedAtMs = BASE_MS + i * 1000;
    const item = await db
      .insertInto('catalog_items')
      .values({
        library_id: lib.id,
        item_type: fixture.itemType,
        title: fixture.title,
        sort_title: fixture.title.toLowerCase(),
        added_at_ms: addedAtMs,
        updated_at_ms: addedAtMs,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    inserted.push({ id: item.id, itemType: fixture.itemType, addedAtMs });
  }

  expectedEligible = inserted
    .filter((r) => RECENTLY_ADDED_TYPES.includes(r.itemType))
    .sort((a, b) => b.addedAtMs - a.addedAtMs)
    .map((r) => r.id);
});

afterAll(async () => {
  await db?.destroy();
});

interface WalkedPage {
  count: number;
  nextCursor: string | null;
}

async function walk(
  read: (cursor: string | undefined) => Promise<{ rows: Array<{ id: string }>; nextCursor: string | null }>,
  maxHops = 40
): Promise<{ ids: string[]; pages: WalkedPage[] }> {
  const ids: string[] = [];
  const pages: WalkedPage[] = [];
  let cursor: string | undefined;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const page = await read(cursor);
    ids.push(...page.rows.map((r) => r.id));
    pages.push({ count: page.rows.length, nextCursor: page.nextCursor });
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  expect(pages[pages.length - 1]!.nextCursor).toBeNull();
  return { ids, pages };
}

/** A page that advertises more must be a FULL page. Short/empty is allowed
 *  only as the terminal page — including the trailing empty page a
 *  boundary-exact result set mints, which is listItems' long-standing
 *  behaviour (see continue-watching-cursor.spec.ts's last case). */
function shortWhileAdvertisingMore(pages: WalkedPage[], limit: number): WalkedPage[] {
  return pages.filter((p) => p.nextCursor !== null && p.count !== limit);
}

describe('adi-F2: listItems/getRecentlyAdded page over the ELIGIBLE item types', () => {
  it('page 0 at limit=1 carries an eligible row even though the newest item is an ineligible episode', async () => {
    const page = await getRecentlyAdded(db, ctx, { itemTypes: RECENTLY_ADDED_TYPES, limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(expectedEligible[0]);
  });

  it('a limit=1 walk visits every eligible row in order, and no page that advertises more is short', async () => {
    const { ids, pages } = await walk((cursor) =>
      getRecentlyAdded(db, ctx, {
        itemTypes: RECENTLY_ADDED_TYPES,
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      })
    );
    expect(ids).toEqual(expectedEligible);
    expect(shortWhileAdvertisingMore(pages, 1)).toEqual([]);
  });

  it('an ineligible type never appears, at any page size', async () => {
    const page = await listItems(db, ctx, { itemTypes: RECENTLY_ADDED_TYPES, limit: 100 });
    expect(page.rows.map((r) => r.item_type).sort()).toEqual(['album', 'movie', 'movie', 'series']);
  });

  it('OMITTING itemTypes keeps the every-type behaviour src/query/export.ts depends on', async () => {
    const page = await listItems(db, ctx, { limit: 100 });
    expect(page.rows).toHaveLength(FIXTURES.length);
  });

  it('an EMPTY itemTypes array matches nothing — it must never degrade to "no filter"', async () => {
    const page = await listItems(db, ctx, { itemTypes: [], limit: 100 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('adi-F2: searchCatalog pages over the ELIGIBLE item types', () => {
  // SearchResult's discriminator: no season, no episode.
  const SEARCH_TYPES: readonly ItemType[] = ['movie', 'series', 'artist', 'album', 'track'];

  it('a limit=1 walk over a query matching BOTH eligible and ineligible rows never yields an empty page mid-walk', async () => {
    const { ids, pages } = await walk((cursor) =>
      searchCatalog(db, ctx, {
        q: 'signal',
        itemTypes: SEARCH_TYPES,
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      })
    );
    expect(shortWhileAdvertisingMore(pages, 1)).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);

    const all = await searchCatalog(db, ctx, { q: 'signal', itemTypes: SEARCH_TYPES, limit: 100 });
    expect(all.rows.map((r) => r.itemType).includes('episode')).toBe(false);
    expect(all.rows.map((r) => r.itemType).includes('season')).toBe(false);
    expect(ids).toEqual(all.rows.map((r) => r.id));
  });

  it('OMITTING itemTypes still searches every type (the pre-adi-F2 contract)', async () => {
    const all = await searchCatalog(db, ctx, { q: 'signal', limit: 100 });
    expect(all.rows).toHaveLength(FIXTURES.length);
  });

  it('an EMPTY itemTypes array matches nothing', async () => {
    const all = await searchCatalog(db, ctx, { q: 'signal', itemTypes: [], limit: 100 });
    expect(all.rows).toEqual([]);
    expect(all.nextCursor).toBeNull();
  });
});
