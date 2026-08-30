// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/export.spec.ts
//
// V1-010 (audit fafa47f, Fix Wave 4): exportData's item loop issued TWO
// EXTRA queries PER ROW (one `provider_ids` select, one `progress` select)
// instead of batching per page — an N+1 unlike every sibling fetcher in
// this package (catalog-detail.ts's fetchGenresBatch/fetchPeopleBatch,
// restricted-performers.ts's batch-count helpers), and it's on the export
// path, which runs over the user's whole library.
//
// This pins the query-COUNT shape (functional correctness of exportData's
// output — restricted-library/item exclusion, own-progress-only — is
// already covered by leak.spec.ts's "excludes restricted libraries/items
// for an uncleared viewer..." case): however many items a page contains,
// exportData must issue exactly ONE `provider_ids` query and ONE
// `progress` query for that page, never one pair per row. Counted by
// spying on Kysely's own `selectFrom` — no query-log plumbing needed, and
// it can't be fooled by a fix that batches under a different method name
// since selectFrom is the one entry point every query in this file uses.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed) — same
// convention as catalog-detail.spec.ts / apps/server/test's e2e suites.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import { ensureTestDatabase } from '../src/testing.js';
import type { DB } from '../src/types.js';
import type { ViewerContext } from '../src/context.js';
import { exportData, type ExportChunk } from '../src/query/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;
let casualCtx: ViewerContext;
let harborLightsId: string;
let quietFrontierId: string;

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, 'export_spec_test');
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset'], databaseUrl);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), [], databaseUrl);
  db = createDb(databaseUrl);

  const rawClient = new pg.Client({ connectionString: databaseUrl });
  await rawClient.connect();
  try {
    const casual = await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'casual'");
    const generalLibs = await rawClient.query<{ id: string }>(
      "SELECT id FROM libraries WHERE content_class = 'general'"
    );
    casualCtx = {
      userId: casual.rows[0]!.id,
      allowedLibraryIds: generalLibs.rows.map((r) => r.id),
      restrictedCleared: false,
      surface: 'restricted',
    };

    // seed/seed.mjs seeds no provider_ids at all — insert a couple so the
    // batched query has real, non-empty data to prove it fetches
    // correctly, not just that it fetches fewer times.
    const harborLights = await rawClient.query<{ id: string }>(
      "SELECT id FROM catalog_items WHERE title = 'Harbor Lights'"
    );
    harborLightsId = harborLights.rows[0]!.id;
    const quietFrontier = await rawClient.query<{ id: string }>(
      "SELECT id FROM catalog_items WHERE title = 'The Quiet Frontier'"
    );
    quietFrontierId = quietFrontier.rows[0]!.id;

    await rawClient.query(
      `INSERT INTO provider_ids (item_id, provider, external_id) VALUES ($1, 'tmdb', 'tt-harbor-1'), ($1, 'imdb', 'tt-harbor-2')`,
      [harborLightsId]
    );
  } finally {
    await rawClient.end();
  }
}, 60_000);

afterAll(async () => {
  await db?.destroy();
});

describe('exportData batches per-item lookups (V1-010)', () => {
  it('issues exactly one provider_ids query and one progress query for the whole page, not one pair per item', async () => {
    const selectFromSpy = vi.spyOn(db, 'selectFrom');

    const chunks: ExportChunk[] = [];
    for await (const chunk of exportData(db, casualCtx)) chunks.push(chunk);

    const itemChunks = chunks.filter((c): c is Extract<ExportChunk, { kind: 'item' }> => c.kind === 'item');
    // Sanity: this only proves something if there's more than one row to
    // have queried per-row in the first place (seed.mjs seeds 6 movies
    // alone, all under EXPORT_ITEM_PAGE_SIZE=200 -> exactly one page).
    expect(itemChunks.length).toBeGreaterThan(1);

    const providerIdsCalls = selectFromSpy.mock.calls.filter((args) => args[0] === 'provider_ids');
    const progressCalls = selectFromSpy.mock.calls.filter((args) => args[0] === 'progress');

    expect(providerIdsCalls).toHaveLength(1);
    expect(progressCalls).toHaveLength(1);

    selectFromSpy.mockRestore();
  });

  it('the batched output is still correct per item (regression guard: batching must not change results)', async () => {
    const chunks: ExportChunk[] = [];
    for await (const chunk of exportData(db, casualCtx)) chunks.push(chunk);
    const itemChunks = chunks.filter((c): c is Extract<ExportChunk, { kind: 'item' }> => c.kind === 'item');

    const harborLights = itemChunks.find((c) => c.item.id === harborLightsId);
    expect(harborLights).toBeTruthy();
    expect(harborLights!.item.providerIds).toEqual(
      expect.arrayContaining([
        { provider: 'tmdb', externalId: 'tt-harbor-1' },
        { provider: 'imdb', externalId: 'tt-harbor-2' },
      ])
    );
    expect(harborLights!.item.providerIds).toHaveLength(2);

    // seed.mjs gives casual real progress on "The Quiet Frontier" (movies[1]).
    const quietFrontier = itemChunks.find((c) => c.item.id === quietFrontierId);
    expect(quietFrontier).toBeTruthy();
    expect(quietFrontier!.item.progress).not.toBeNull();
    expect(quietFrontier!.item.progress?.positionMs).toBe(17 * 60_000);

    // An item with neither provider_ids nor progress gets empty/null, not
    // a crash on a Map miss.
    const noProviderIds = itemChunks.find((c) => c.item.id !== harborLightsId);
    expect(noProviderIds).toBeTruthy();
    if (noProviderIds!.item.id !== quietFrontierId) {
      expect(noProviderIds!.item.providerIds).toEqual([]);
    }
  });
});
