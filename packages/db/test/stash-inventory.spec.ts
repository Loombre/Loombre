// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/stash-inventory.spec.ts
//
// Live-DB tests for src/query/stash-inventory.ts (STATE.md S4/K10,
// migrations/0018_stash_provider_core.sql) — mirrors
// library-provider-chains.spec.ts's own reset+reseed convention. Covers:
// the inventory upsert never clobbering an existing match, the match-
// result writer, computePathMappingMatchPreview's counts + the CURRENT-
// mapping-config-vs-last-inventory-snapshot behavior (K10: "editing a
// mapping changes this preview immediately"), and S4's unmatched-
// visibility requirement expressed at the DB layer (an unmatched scene's
// row is never absent, never deleted).
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
import { replaceLibraryPathMappings } from '../src/query/stash-connections.js';
import {
  applyStashSceneMatchResults,
  computePathMappingMatchPreview,
  listCandidateMediaFilesForLibrary,
  listStashSceneLinksForLibrary,
  upsertStashSceneLinksFromInventory,
} from '../src/query/stash-inventory.js';

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
    .values({ name: `stash-lib-${randomUUID()}`, media_kind: 'movie', paths: [], content_class: 'restricted', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makeCatalogItemWithFile(libraryId: string, filePath: string, sizeBytes: number): Promise<{ itemId: string; mediaFileId: string }> {
  const now = Date.now();
  const item = await db
    .insertInto('catalog_items')
    .values({
      library_id: libraryId,
      item_type: 'movie',
      title: `item-${randomUUID()}`,
      sort_title: 'item',
      added_at_ms: now,
      updated_at_ms: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const file = await db
    .insertInto('media_files')
    .values({ item_id: item.id, path: filePath, size_bytes: sizeBytes })
    .returningAll()
    .executeTakeFirstOrThrow();

  return { itemId: item.id, mediaFileId: file.id };
}

describe('stash-inventory (S4/K10)', () => {
  it('upsertStashSceneLinksFromInventory creates one row per scene and never touches item_id on a re-run', async () => {
    const libraryId = await makeRestrictedLibrary();
    const now = Date.now();

    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: 'scene-1', stashPath: '/stash/a.mp4', stashSizeBytes: 100, stashOshash: 'h1', stashUpdatedAtMs: now }],
      now
    );

    await applyStashSceneMatchResults(db, libraryId, [{ stashSceneId: 'scene-1', itemId: null, matchedBy: null }], now);
    // Simulate a real match having been applied out-of-band (as the S4
    // matcher would) so the next assertion can prove inventory re-runs
    // leave it alone.
    await db.updateTable('stash_scene_links').set({ item_id: null, matched_by: null }).where('stash_scene_id', '=', 'scene-1').execute();

    const { itemId } = await makeCatalogItemWithFile(libraryId, '/media/a.mp4', 100);
    await applyStashSceneMatchResults(db, libraryId, [{ stashSceneId: 'scene-1', itemId, matchedBy: 'path' }], now);

    // Re-run the inventory pass with an updated path — must NOT clobber
    // the item_id/matched_by set above.
    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: 'scene-1', stashPath: '/stash/a-renamed.mp4', stashSizeBytes: 100, stashOshash: 'h1', stashUpdatedAtMs: now + 1000 }],
      now + 1000
    );

    const rows = await listStashSceneLinksForLibrary(db, libraryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stash_path: '/stash/a-renamed.mp4', item_id: itemId, matched_by: 'path', stale: false });
  });

  it('an unmatched scene remains VISIBLE as a row (never deleted) after inventory + a failed match attempt', async () => {
    const libraryId = await makeRestrictedLibrary();
    const now = Date.now();
    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: 'scene-unmatched', stashPath: '/stash/nope.mp4', stashSizeBytes: 999, stashOshash: null, stashUpdatedAtMs: now }],
      now
    );
    await applyStashSceneMatchResults(db, libraryId, [{ stashSceneId: 'scene-unmatched', itemId: null, matchedBy: null }], now);

    const rows = await listStashSceneLinksForLibrary(db, libraryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item_id: null, matched_by: null });
  });

  it('listCandidateMediaFilesForLibrary scopes strictly to the given library', async () => {
    const libA = await makeRestrictedLibrary();
    const libB = await makeRestrictedLibrary();
    const { mediaFileId } = await makeCatalogItemWithFile(libA, '/media/only-in-a.mp4', 10);
    await makeCatalogItemWithFile(libB, '/media/only-in-b.mp4', 20);

    const candidates = await listCandidateMediaFilesForLibrary(db, libA);
    expect(candidates.map((c) => c.mediaFileId)).toEqual([mediaFileId]);
  });

  describe('computePathMappingMatchPreview (K10)', () => {
    it('counts matched vs unmatched using the path-mapping rewrite, and reflects a mapping change immediately', async () => {
      const libraryId = await makeRestrictedLibrary();
      const now = Date.now();

      const { mediaFileId: matchedFileId } = await makeCatalogItemWithFile(libraryId, '/media/adult/scene-a.mp4', 111);
      await makeCatalogItemWithFile(libraryId, '/media/adult/unrelated.mp4', 222);

      await upsertStashSceneLinksFromInventory(
        db,
        libraryId,
        [
          { stashSceneId: 'scene-a', stashPath: '/mnt/stash/scene-a.mp4', stashSizeBytes: 111, stashOshash: null, stashUpdatedAtMs: now },
          { stashSceneId: 'scene-b', stashPath: '/mnt/stash/scene-b.mp4', stashSizeBytes: 333, stashOshash: null, stashUpdatedAtMs: now },
        ],
        now
      );

      // No mapping configured yet — nothing can rewrite, so everything is
      // unmatched (visible, with rewrittenPath: null).
      const beforeMapping = await computePathMappingMatchPreview(db, libraryId);
      expect(beforeMapping.totalStashScenes).toBe(2);
      expect(beforeMapping.candidateMatchCount).toBe(0);
      expect(beforeMapping.unmatchedCount).toBe(2);
      expect(beforeMapping.unmatchedScenes.find((s) => s.stashSceneId === 'scene-a')?.rewrittenPath).toBeNull();

      await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: '/mnt/stash', loombrePrefix: '/media/adult' }]);

      const afterMapping = await computePathMappingMatchPreview(db, libraryId);
      expect(afterMapping.totalStashScenes).toBe(2);
      expect(afterMapping.candidateMatchCount).toBe(1); // scene-a rewrites to an existing media_files.path
      expect(afterMapping.unmatchedCount).toBe(1);
      const unmatchedB = afterMapping.unmatchedScenes.find((s) => s.stashSceneId === 'scene-b');
      expect(unmatchedB?.rewrittenPath).toBe('/media/adult/scene-b.mp4'); // mapped, but no such Loombre file exists
      expect(unmatchedB).toBeDefined();

      void matchedFileId; // referenced for clarity of the fixture's intent
    });
  });
});
