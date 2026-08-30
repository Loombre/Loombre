// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/admin-unmatched-items.spec.ts
//
// Live-DB tests for src/query/admin.ts's listUnmatchedLibraryItemsForViewer
// and getEnrichableCatalogItemForAdmin (Phosphor retheme Wave 2, Lane L2 —
// Fix Match, GET /admin/libraries/{id}/unmatched + the POST
// /admin/items/{id}/match-search|apply-match 404 gate). Seed data never
// populates provider_ids (grepped seed.mjs —
// confirmed), so every seeded movie/series/artist/album starts "unmatched"
// by this function's derived definition; these tests insert ONE provider_ids
// row for a control fixture to prove it then drops out of the list.
//
// Self-sufficient: resets + reseeds in its own beforeAll.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import type { ViewerContext } from '../src/context.js';
import {
  getEnrichableCatalogItemForAdmin,
  listUnmatchedLibraryItemsForViewer,
} from '../src/query/admin.js';
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

let adminId: string;
let moviesLibraryId: string;
let restrictedLibraryId: string;
let harborLightsItemId: string;
let harborLightsFilePath: string;
let coastlineSignalsItemId: string;
let restrictedMovieItemId: string;

let clearedCtx: ViewerContext;
let unclearedCtx: ViewerContext; // same admin USER, general-only libraries, no restricted clearance

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);

  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  adminId = (await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")).rows[0]!.id;

  moviesLibraryId = (
    await rawClient.query<{ id: string }>("SELECT id FROM libraries WHERE name = 'Movies'")
  ).rows[0]!.id;
  restrictedLibraryId = (
    await rawClient.query<{ id: string }>("SELECT id FROM libraries WHERE content_class = 'restricted' LIMIT 1")
  ).rows[0]!.id;

  const harborLights = (
    await rawClient.query<{ id: string }>("SELECT id FROM catalog_items WHERE title = 'Harbor Lights'")
  ).rows[0]!;
  harborLightsItemId = harborLights.id;
  harborLightsFilePath = (
    await rawClient.query<{ path: string }>('SELECT path FROM media_files WHERE item_id = $1', [harborLightsItemId])
  ).rows[0]!.path;

  coastlineSignalsItemId = (
    await rawClient.query<{ id: string }>("SELECT id FROM catalog_items WHERE title = 'Coastline Signals'")
  ).rows[0]!.id;

  restrictedMovieItemId = (
    await rawClient.query<{ id: string }>("SELECT id FROM catalog_items WHERE title = 'After Hours Redline'")
  ).rows[0]!.id;

  const generalLibraryIds = (
    await rawClient.query<{ id: string }>("SELECT id FROM libraries WHERE content_class = 'general'")
  ).rows.map((r) => r.id);
  const allLibraryIds = (await rawClient.query<{ id: string }>('SELECT id FROM libraries')).rows.map((r) => r.id);

  clearedCtx = { userId: adminId, allowedLibraryIds: allLibraryIds, restrictedCleared: true, surface: 'restricted' };
  unclearedCtx = { userId: adminId, allowedLibraryIds: generalLibraryIds, restrictedCleared: false, surface: 'restricted' };
});

afterAll(async () => {
  await rawClient.end();
  await db.destroy();
});

describe('listUnmatchedLibraryItemsForViewer (Phosphor retheme Wave 2, Lane L2)', () => {
  it('lists a general movie with zero provider_ids rows, with its file path resolved', async () => {
    const page = await listUnmatchedLibraryItemsForViewer(db, clearedCtx, moviesLibraryId);
    const row = page.rows.find((r) => r.itemId === harborLightsItemId);
    expect(row).toBeDefined();
    expect(row!.itemType).toBe('movie');
    expect(row!.title).toBe('Harbor Lights');
    expect(row!.filePath).toBe(harborLightsFilePath);
  });

  it('resolves a representative file path two hierarchy levels down for a series (series->season->episode)', async () => {
    const tvLibraryId = (
      await rawClient.query<{ library_id: string }>('SELECT library_id FROM catalog_items WHERE id = $1', [
        coastlineSignalsItemId,
      ])
    ).rows[0]!.library_id;

    const page = await listUnmatchedLibraryItemsForViewer(db, clearedCtx, tvLibraryId);
    const row = page.rows.find((r) => r.itemId === coastlineSignalsItemId);
    expect(row).toBeDefined();
    expect(row!.itemType).toBe('series');
    expect(row!.filePath).not.toBeNull();

    const realEpisodePaths = (
      await rawClient.query<{ path: string }>(
        `SELECT mf.path FROM media_files mf
         JOIN catalog_items episode ON episode.id = mf.item_id
         JOIN catalog_items season ON season.id = episode.parent_id
         WHERE season.parent_id = $1`,
        [coastlineSignalsItemId]
      )
    ).rows.map((r) => r.path);
    expect(realEpisodePaths).toContain(row!.filePath);
  });

  it('excludes an item once it gains a provider_ids row (the derived, never-stored definition of matched)', async () => {
    const before = await listUnmatchedLibraryItemsForViewer(db, clearedCtx, moviesLibraryId);
    expect(before.rows.some((r) => r.itemId === harborLightsItemId)).toBe(true);

    await rawClient.query(`INSERT INTO provider_ids (item_id, provider, external_id) VALUES ($1, 'tmdb', '12345')`, [
      harborLightsItemId,
    ]);

    const after = await listUnmatchedLibraryItemsForViewer(db, clearedCtx, moviesLibraryId);
    expect(after.rows.some((r) => r.itemId === harborLightsItemId)).toBe(false);

    // Restore state for any later test in this file relying on the fixture.
    await rawClient.query(`DELETE FROM provider_ids WHERE item_id = $1`, [harborLightsItemId]);
  });

  it('a restricted library: visible to a cleared ctx, ABSENT (dropped, not redacted) to an uncleared ctx — SAME admin user both times', async () => {
    const clearedPage = await listUnmatchedLibraryItemsForViewer(db, clearedCtx, restrictedLibraryId);
    expect(clearedPage.rows.some((r) => r.itemId === restrictedMovieItemId)).toBe(true);

    const unclearedPage = await listUnmatchedLibraryItemsForViewer(db, unclearedCtx, restrictedLibraryId);
    expect(unclearedPage.rows).toEqual([]);
  });

  it('never returns season/episode/track rows even though they too lack provider_ids', async () => {
    const tvLibraryId = (
      await rawClient.query<{ library_id: string }>('SELECT library_id FROM catalog_items WHERE id = $1', [
        coastlineSignalsItemId,
      ])
    ).rows[0]!.library_id;
    const page = await listUnmatchedLibraryItemsForViewer(db, clearedCtx, tvLibraryId, { limit: 200 });
    for (const row of page.rows) {
      expect(['movie', 'series', 'artist', 'album']).toContain(row.itemType);
    }
  });
});

describe('getEnrichableCatalogItemForAdmin (Fix Match trigger 404 gate)', () => {
  it('returns the row for a general enrichable item, with mediaKind from the OWNING library', async () => {
    const row = await getEnrichableCatalogItemForAdmin(db, clearedCtx, harborLightsItemId);
    expect(row).toBeDefined();
    expect(row!.itemType).toBe('movie');
    expect(row!.libraryId).toBe(moviesLibraryId);
    expect(row!.mediaKind).toBe('movie');
    expect(row!.title).toBe('Harbor Lights');
  });

  it('a restricted item: visible to a cleared ctx, undefined to an uncleared one — SAME admin user both times', async () => {
    expect(await getEnrichableCatalogItemForAdmin(db, clearedCtx, restrictedMovieItemId)).toBeDefined();
    expect(await getEnrichableCatalogItemForAdmin(db, unclearedCtx, restrictedMovieItemId)).toBeUndefined();
  });

  it('returns undefined for a non-enrichable item type (season/episode/track)', async () => {
    const seasonId = (
      await rawClient.query<{ id: string }>('SELECT id FROM catalog_items WHERE parent_id = $1 LIMIT 1', [
        coastlineSignalsItemId,
      ])
    ).rows[0]!.id;
    expect(await getEnrichableCatalogItemForAdmin(db, clearedCtx, seasonId)).toBeUndefined();
  });

  it('returns undefined for a nonexistent id', async () => {
    expect(
      await getEnrichableCatalogItemForAdmin(db, clearedCtx, '00000000-0000-0000-0000-000000000000')
    ).toBeUndefined();
  });
});
