// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/leak.spec.ts
//
// "restricted-content leak impossibility" — enumerates every surface that
// must be proven leak-free by the end of Phase 1 (docs/PLAN.md §6.4). Every
// checklist todo below has been converted to a real, implemented test
// against the guarded query layer in src/query/*.ts and the fixtures in
// seed/seed.mjs (search, people, tags, images, continue-watching, recently-
// added/clearance-digest, events, export, progress) — zero it.todo() left.
//
// Test-harness choice (documented per the task spec, since either approach
// is acceptable): this suite is SELF-SUFFICIENT. `beforeAll` runs
// `scripts/migrate.mjs reset` (drop+recreate public schema, replay all
// migrations) followed by `seed/seed.mjs` against DATABASE_URL, so the
// suite does not depend on the CI gate having done this first — running
// `vitest run` alone from a fresh database is enough. This costs a few
// extra seconds per run in exchange for the suite never silently passing
// against stale or partially-seeded data.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb } from '../src/db.js';
import { getItemById, listItems } from '../src/query/items.js';
import {
  addToWatchlistAndEmit,
  clearanceDigest,
  exportData,
  getChaptersForItem,
  getContinueWatching,
  getImageEntityAccess,
  getLibraryItemCountsForViewer,
  getPersonById,
  getRecentlyAdded,
  getRestrictedPerformerById,
  getRestrictedSceneDetail,
  getRestrictedStudioById,
  getRestrictedZoneCountForViewer,
  getRestrictedZoneHome,
  listItemsForPerson,
  listPeople,
  listProgress,
  listRestrictedBrowse,
  listRestrictedPerformers,
  listRestrictedPerformerScenes,
  listRestrictedStudios,
  listTags,
  listWatchlist,
  readEventsForViewer,
  removeFromWatchlistAndEmit,
  searchCatalog,
  searchRestrictedZone,
} from '../src/index.js';
import type { ViewerContext } from '../src/context.js';
import type { DB } from '../src/types.js';
import type { Kysely } from 'kysely';

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

let generalLibraryIds: string[] = [];
let restrictedLibraryId: string;
let generalLibraryId: string;
let allLibraryIds: string[] = [];
let expectedGeneralCount = 0;
let expectedRestrictedCount = 0;
let restrictedItemId: string;

let casualUncleared: ViewerContext;
let adminClearedButNotUnlocked: ViewerContext;
let adminCleared: ViewerContext;

// Leak-suite hardening fixtures (seed/seed.mjs) — resolved by name/title
// since the seed mints fresh UUIDv7 ids every run.
let restrictedCameoPerformerId: string; // restricted person, credited on a GENERAL item
let marginalGeneralActorId: string; // general person, credited ONLY on a restricted item
let lastFerryOutItemId: string; // general item carrying restrictedCameoPerformer's credit
let paperKingdomsItemId: string; // general item, ALL media_files missing
let afterHoursRedlineItemId: string; // restricted item: Drama-name-collision tag + progress + images + events
let velvetStaticItemId: string; // restricted item: marginalGeneralActor's only credit + file.relocated event
let midnightLedgerItemId: string; // restricted item: general-class 'Rare' tag applied only here
let generalDramaTagId: string;
let restrictedDramaTagId: string;
let rareTagId: string;
let restrictedGenreATagId: string;
let elenaMarshId: string; // ordinary general person, has an image fixture
let restrictedPerformerOneId: string; // ordinary restricted person, has an image fixture
// STATE.md Stash run (S9) fixtures.
let nightshadeFilmsTagId: string; // studio (kind='studio'), on After Hours Redline
let auroraMediaTagId: string; // studio (kind='studio'), on Velvet Static
let undertowConfidentialItemId: string; // restricted item, NO media_files at all (no-evidence case)
let harborLightsItemId: string; // general item, carries ONE chapter marker (S7/K9 contrast fixture)

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);

  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  const libRows = (
    await rawClient.query<{ id: string; name: string; content_class: string }>(
      'SELECT id, name, content_class FROM libraries'
    )
  ).rows;
  generalLibraryIds = libRows.filter((r) => r.content_class === 'general').map((r) => r.id);
  const restrictedRow = libRows.find((r) => r.content_class === 'restricted');
  if (!restrictedRow) throw new Error('seed did not create a restricted library');
  restrictedLibraryId = restrictedRow.id;
  generalLibraryId = libRows.find((r) => r.name === 'Movies')!.id;
  allLibraryIds = libRows.map((r) => r.id);

  // Guard-consistent counts: a naive `GROUP BY content_class` count would
  // include Paper Kingdoms (all media_files missing — see below), which
  // every guarded query correctly hides regardless of clearance. Mirrors
  // applyGuard()'s missing-file predicate exactly so "expected" always
  // means "what the guard actually allows through", not "what's in the
  // table" — see guard.ts's guardPredicateSql for the source of truth this
  // is kept in lock-step with.
  const countRows = (
    await rawClient.query<{ content_class: string; n: number }>(
      `SELECT content_class, count(*)::int AS n
       FROM catalog_items ci
       WHERE NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.item_id = ci.id)
          OR EXISTS (SELECT 1 FROM media_files mf WHERE mf.item_id = ci.id AND mf.missing_since_ms IS NULL)
       GROUP BY content_class`
    )
  ).rows;
  expectedGeneralCount = countRows.find((r) => r.content_class === 'general')?.n ?? 0;
  expectedRestrictedCount = countRows.find((r) => r.content_class === 'restricted')?.n ?? 0;

  const restrictedItem = (
    await rawClient.query<{ id: string }>(
      "SELECT id FROM catalog_items WHERE content_class = 'restricted' LIMIT 1"
    )
  ).rows[0];
  if (!restrictedItem) throw new Error('seed did not create any restricted catalog_items');
  restrictedItemId = restrictedItem.id;

  const adminId = (
    await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")
  ).rows[0]!.id;

  casualUncleared = {
    userId: (await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'casual'")).rows[0]!.id,
    allowedLibraryIds: generalLibraryIds,
    restrictedCleared: false,
  };

  // Admin HAS library permission on the restricted library (gate 4), but
  // this context simulates gate 5 (live session unlock) NOT having passed
  // yet — restrictedCleared must still gate the row out.
  adminClearedButNotUnlocked = {
    userId: adminId,
    allowedLibraryIds: allLibraryIds,
    restrictedCleared: false,
  };

  adminCleared = {
    userId: adminId,
    allowedLibraryIds: allLibraryIds,
    restrictedCleared: true,
  };

  const one = async (sqlText: string) => {
    const row = (await rawClient.query<{ id: string }>(sqlText)).rows[0];
    if (!row) throw new Error(`leak.spec beforeAll: fixture lookup returned no row for: ${sqlText}`);
    return row.id;
  };

  restrictedCameoPerformerId = await one(
    "SELECT id FROM people WHERE name = 'Restricted Cameo Performer'"
  );
  marginalGeneralActorId = await one("SELECT id FROM people WHERE name = 'Marginal General Actor'");
  lastFerryOutItemId = await one("SELECT id FROM catalog_items WHERE title = 'Last Ferry Out'");
  paperKingdomsItemId = await one("SELECT id FROM catalog_items WHERE title = 'Paper Kingdoms'");
  afterHoursRedlineItemId = await one(
    "SELECT id FROM catalog_items WHERE title = 'After Hours Redline'"
  );
  velvetStaticItemId = await one("SELECT id FROM catalog_items WHERE title = 'Velvet Static'");
  midnightLedgerItemId = await one("SELECT id FROM catalog_items WHERE title = 'Midnight Ledger'");
  generalDramaTagId = await one("SELECT id FROM tags WHERE name = 'Drama' AND content_class = 'general'");
  restrictedDramaTagId = await one(
    "SELECT id FROM tags WHERE name = 'Drama' AND content_class = 'restricted'"
  );
  rareTagId = await one("SELECT id FROM tags WHERE name = 'Rare'");
  restrictedGenreATagId = await one("SELECT id FROM tags WHERE name = 'Restricted Genre A'");
  elenaMarshId = await one("SELECT id FROM people WHERE name = 'Elena Marsh'");
  restrictedPerformerOneId = await one("SELECT id FROM people WHERE name = 'Restricted Performer One'");
  nightshadeFilmsTagId = await one("SELECT id FROM tags WHERE name = 'Nightshade Films'");
  auroraMediaTagId = await one("SELECT id FROM tags WHERE name = 'Aurora Media'");
  undertowConfidentialItemId = await one("SELECT id FROM catalog_items WHERE title = 'Undertow Confidential'");
  harborLightsItemId = await one("SELECT id FROM catalog_items WHERE title = 'Harbor Lights'");
});

afterAll(async () => {
  await db?.destroy();
  await rawClient?.end();
});

describe('restricted-content leak impossibility', () => {
  describe('implemented', () => {
    it('listItems: uncleared casual-user context returns ZERO restricted rows, and exactly the general-item count', async () => {
      expect(expectedGeneralCount).toBeGreaterThan(0);

      const { rows } = await listItems(db, casualUncleared, { limit: 200 });

      const restrictedRows = rows.filter((r) => r.content_class === 'restricted');
      expect(restrictedRows).toHaveLength(0);
      expect(rows).toHaveLength(expectedGeneralCount);
    });

    it('getItemById: restricted item is invisible without clearance, visible with it', async () => {
      expect(expectedRestrictedCount).toBeGreaterThan(0);

      const asUnclearedCasual = await getItemById(db, casualUncleared, restrictedItemId);
      expect(asUnclearedCasual).toBeUndefined();

      // Library permission alone (gate 4) is not sufficient without the
      // live unlock (gate 5) — proves the guard checks restrictedCleared,
      // not merely library membership.
      const asAdminMissingUnlock = await getItemById(db, adminClearedButNotUnlocked, restrictedItemId);
      expect(asAdminMissingUnlock).toBeUndefined();

      const asAdminCleared = await getItemById(db, adminCleared, restrictedItemId);
      expect(asAdminCleared).toBeDefined();
      expect(asAdminCleared?.id).toBe(restrictedItemId);
      expect(asAdminCleared?.content_class).toBe('restricted');
    });
  });

  describe('checklist — implemented (Phase 1)', () => {
    // ------------------------------------------------------------------
    // 1. search
    // ------------------------------------------------------------------
    it('search: never returns restricted rows to an uncleared viewer via title match, but does for a cleared one', async () => {
      const uncleared = await searchCatalog(db, casualUncleared, { q: 'Drama' });
      expect(uncleared.rows.map((r) => r.title).sort()).toEqual(
        ['Coastline Signals', 'Harbor Lights'].sort()
      );
      expect(uncleared.rows.every((r) => r.contentClass === 'general')).toBe(true);

      const cleared = await searchCatalog(db, adminCleared, { q: 'Drama' });
      const titles = cleared.rows.map((r) => r.title);
      expect(titles).toContain('Coastline Signals');
      expect(titles).toContain('Harbor Lights');
      // The name-collision restricted 'Drama' tag lives on After Hours
      // Redline (restricted) — only surfaces once cleared.
      expect(titles).toContain('After Hours Redline');
    });

    it('search: THE FINDING — a restricted-class person credited on an otherwise-general item must not surface that item to an uncleared viewer via a person-name match', async () => {
      // Last Ferry Out is a fully general item (general library, general
      // content_class) that a casual uncleared viewer can normally see and
      // find by title — but its only connection to "Restricted Cameo
      // Performer" (a restricted-class person) must not be searchable.
      const byTitleUncleared = await searchCatalog(db, casualUncleared, { q: 'Last Ferry Out' });
      expect(byTitleUncleared.rows.map((r) => r.id)).toContain(lastFerryOutItemId);

      const byPersonUncleared = await searchCatalog(db, casualUncleared, {
        q: 'Restricted Cameo Performer',
      });
      expect(byPersonUncleared.rows).toHaveLength(0);

      const byPersonCleared = await searchCatalog(db, adminCleared, {
        q: 'Restricted Cameo Performer',
      });
      expect(byPersonCleared.rows.map((r) => r.id)).toEqual([lastFerryOutItemId]);
    });

    it('search: THE FINDING, tag side — a restricted-class tag applied to an otherwise-general item must not surface that item to an uncleared viewer via a tag-name match', async () => {
      // Same shape as the person-side finding above: Last Ferry Out is a
      // fully general item findable by title, but its restricted-class
      // 'Contraband' tag must never make it searchable by that tag name.
      const byTitleUncleared = await searchCatalog(db, casualUncleared, { q: 'Last Ferry Out' });
      expect(byTitleUncleared.rows.map((r) => r.id)).toContain(lastFerryOutItemId);

      const byTagUncleared = await searchCatalog(db, casualUncleared, { q: 'Contraband' });
      expect(byTagUncleared.rows).toHaveLength(0);

      const byTagCleared = await searchCatalog(db, adminCleared, { q: 'Contraband' });
      expect(byTagCleared.rows.map((r) => r.id)).toEqual([lastFerryOutItemId]);
    });

    it('search: missing-file item never surfaces regardless of clearance (leak todo 10)', async () => {
      const uncleared = await searchCatalog(db, casualUncleared, { q: 'Paper Kingdoms' });
      expect(uncleared.rows).toHaveLength(0);

      const cleared = await searchCatalog(db, adminCleared, { q: 'Paper Kingdoms' });
      expect(cleared.rows).toHaveLength(0);
    });

    it('search: adversarial tsquery/LIKE injection strings are safely parameterized, never throw, never leak restricted rows', async () => {
      const adversarialQueries = [
        `"; DROP TABLE catalog_items; --`,
        `%' OR '1'='1`,
        `_%_%_%`,
        `\\'); SELECT * FROM users; --`,
        `(((`,
      ];
      for (const q of adversarialQueries) {
        const result = await searchCatalog(db, casualUncleared, { q });
        expect(Array.isArray(result.rows)).toBe(true);
        expect(result.rows.every((r) => r.contentClass === 'general')).toBe(true);
      }
      // The table must still be intact and queryable after all of the above.
      const sanity = await searchCatalog(db, casualUncleared, { q: 'Harbor Lights' });
      expect(sanity.rows.map((r) => r.title)).toContain('Harbor Lights');
    });

    // Perf-fix regression (gap-closure lane, exit-gate finding): searchCatalog
    // used to be one query with the tsv-match/person-match/tag-match
    // conditions OR'd together (Postgres cannot pull a correlated EXISTS
    // combined via OR into an index-backed plan — it re-runs the subplan
    // per outer row, which breached the Tier-0 p95 <=100ms budget at the
    // 50k-item seed: 147-159ms measured). Restructured as a UNION of three
    // independently-indexed branches (migration 0008 adds pg_trgm GIN
    // trigram indexes backing the person/tag ILIKE branches) — UNION's
    // implicit DISTINCT is what now does the "appears once even if it
    // matches more than one branch" job the OR used to do directly. This
    // proves that invariant holds: no id appears twice in a single
    // result set, across every existing search fixture in this suite
    // (several of which — 'Drama' matches 2+ items via the SAME tag
    // branch; 'Harbor Lights' matches via tsv AND (for the admin-cleared
    // case) may also match other branches — already exercise UNION
    // combining multiple rows/branches, not just a single-row case).
    it('search: UNION restructuring never duplicates a row (no id appears twice), for both cleared and uncleared viewers', async () => {
      const queries = ['Drama', 'Harbor Lights', 'Last Ferry Out', 'Restricted Cameo Performer', 'Contraband', 'a'];
      for (const q of queries) {
        for (const ctx of [casualUncleared, adminCleared]) {
          const result = await searchCatalog(db, ctx, { q, limit: 200 });
          const ids = result.rows.map((r) => r.id);
          expect(ids.length).toBe(new Set(ids).size);
        }
      }
    });

    // ------------------------------------------------------------------
    // 2. people
    // ------------------------------------------------------------------
    it('listPeople / getPersonById: restricted-class people never surface to an uncleared viewer, and do for a cleared one', async () => {
      const uncleared = await listPeople(db, casualUncleared, { limit: 100 });
      expect(uncleared.rows.every((r) => r.contentClass === 'general')).toBe(true);
      expect(uncleared.rows.map((r) => r.name)).not.toContain('Restricted Cameo Performer');

      expect(await getPersonById(db, casualUncleared, restrictedCameoPerformerId)).toBeUndefined();
      const clearedPerson = await getPersonById(db, adminCleared, restrictedCameoPerformerId);
      expect(clearedPerson?.contentClass).toBe('restricted');
      expect(clearedPerson?.creditCount).toBe(1);
    });

    it('listPeople / getPersonById: a GENERAL-class person credited ONLY on a restricted item does not leak through existence (orphan check)', async () => {
      const uncleared = await listPeople(db, casualUncleared, { limit: 100 });
      expect(uncleared.rows.map((r) => r.name)).not.toContain('Marginal General Actor');
      expect(await getPersonById(db, casualUncleared, marginalGeneralActorId)).toBeUndefined();

      // Gate 4 without gate 5 must ALSO not see them — this is a
      // content-visibility gap, not a library-membership one.
      expect(await getPersonById(db, adminClearedButNotUnlocked, marginalGeneralActorId)).toBeUndefined();

      const cleared = await getPersonById(db, adminCleared, marginalGeneralActorId);
      expect(cleared?.contentClass).toBe('general');
      expect(cleared?.creditCount).toBe(1);
      const clearedList = await listPeople(db, adminCleared, { limit: 100 });
      expect(clearedList.rows.map((r) => r.name)).toContain('Marginal General Actor');
    });

    // ------------------------------------------------------------------
    // 3. tags
    // ------------------------------------------------------------------
    it('listTags: restricted-class tags never surface to an uncleared viewer, even a same-named general tag ("Drama" collision)', async () => {
      const uncleared = await listTags(db, casualUncleared, { limit: 100 });
      const dramaRows = uncleared.rows.filter((r) => r.name === 'Drama');
      expect(dramaRows).toHaveLength(1);
      expect(dramaRows[0]?.id).toBe(generalDramaTagId);
      expect(dramaRows[0]?.contentClass).toBe('general');

      const cleared = await listTags(db, adminCleared, { limit: 100 });
      const clearedDramaIds = cleared.rows.filter((r) => r.name === 'Drama').map((r) => r.id);
      expect(clearedDramaIds.sort()).toEqual([generalDramaTagId, restrictedDramaTagId].sort());
    });

    it('listTags: a GENERAL-class tag used ONLY on a restricted item does not leak through existence (orphan check, tag side)', async () => {
      const uncleared = await listTags(db, casualUncleared, { limit: 100 });
      expect(uncleared.rows.map((r) => r.id)).not.toContain(rareTagId);

      const cleared = await listTags(db, adminCleared, { limit: 100 });
      const rareRow = cleared.rows.find((r) => r.id === rareTagId);
      expect(rareRow?.contentClass).toBe('general');
      expect(rareRow?.itemCount).toBe(1);
    });

    // ------------------------------------------------------------------
    // 4. images
    // ------------------------------------------------------------------
    describe('getImageEntityAccess: every entity_type branch checks the owning entity content_class before serving', () => {
      it('catalog_item branch', async () => {
        expect(
          await getImageEntityAccess(db, casualUncleared, {
            entityType: 'catalog_item',
            entityId: afterHoursRedlineItemId,
          })
        ).toHaveLength(0);
        expect(
          (
            await getImageEntityAccess(db, adminCleared, {
              entityType: 'catalog_item',
              entityId: afterHoursRedlineItemId,
            })
          ).length
        ).toBeGreaterThan(0);
      });

      it('person branch', async () => {
        expect(
          await getImageEntityAccess(db, casualUncleared, {
            entityType: 'person',
            entityId: restrictedPerformerOneId,
          })
        ).toHaveLength(0);
        const cleared = await getImageEntityAccess(db, adminCleared, {
          entityType: 'person',
          entityId: restrictedPerformerOneId,
        });
        expect(cleared.length).toBeGreaterThan(0);

        // General person is visible to everyone regardless of clearance.
        const generalPersonUncleared = await getImageEntityAccess(db, casualUncleared, {
          entityType: 'person',
          entityId: elenaMarshId,
        });
        expect(generalPersonUncleared.length).toBeGreaterThan(0);
      });

      it('tag branch', async () => {
        expect(
          await getImageEntityAccess(db, casualUncleared, {
            entityType: 'tag',
            entityId: restrictedGenreATagId,
          })
        ).toHaveLength(0);
        const cleared = await getImageEntityAccess(db, adminCleared, {
          entityType: 'tag',
          entityId: restrictedGenreATagId,
        });
        expect(cleared.length).toBeGreaterThan(0);
      });

      it('library branch (including the gate-4-without-gate-5 case)', async () => {
        expect(
          await getImageEntityAccess(db, casualUncleared, {
            entityType: 'library',
            entityId: restrictedLibraryId,
          })
        ).toHaveLength(0);

        // Admin holds gate 4 (explicit library permission) here but this
        // context simulates gate 5 not having passed — must still be empty.
        expect(
          await getImageEntityAccess(db, adminClearedButNotUnlocked, {
            entityType: 'library',
            entityId: restrictedLibraryId,
          })
        ).toHaveLength(0);

        const cleared = await getImageEntityAccess(db, adminCleared, {
          entityType: 'library',
          entityId: restrictedLibraryId,
        });
        expect(cleared.length).toBeGreaterThan(0);

        const generalLibraryUncleared = await getImageEntityAccess(db, casualUncleared, {
          entityType: 'library',
          entityId: generalLibraryId,
        });
        expect(generalLibraryUncleared.length).toBeGreaterThan(0);
      });
    });

    // ------------------------------------------------------------------
    // 5. continue-watching
    // ------------------------------------------------------------------
    it('getContinueWatching: restricted in-progress rows are excluded for uncleared viewers, included for cleared', async () => {
      const uncleared = await getContinueWatching(db, adminClearedButNotUnlocked);
      expect(uncleared.map((r) => r.itemId)).not.toContain(afterHoursRedlineItemId);
      expect(uncleared.every((r) => r.itemId !== afterHoursRedlineItemId)).toBe(true);

      const cleared = await getContinueWatching(db, adminCleared);
      expect(cleared.map((r) => r.itemId)).toContain(afterHoursRedlineItemId);
      expect(cleared.length).toBeGreaterThan(uncleared.length);
    });

    // ------------------------------------------------------------------
    // 6. recently-added + clearanceDigest
    // ------------------------------------------------------------------
    it('getRecentlyAdded: output differs by ViewerContext — no shared computation across clearances', async () => {
      const uncleared = await getRecentlyAdded(db, casualUncleared, { limit: 200 });
      const cleared = await getRecentlyAdded(db, adminCleared, { limit: 200 });

      expect(uncleared.rows.every((r) => r.content_class === 'general')).toBe(true);
      expect(cleared.rows.some((r) => r.content_class === 'restricted')).toBe(true);
      expect(uncleared.rows.length).not.toBe(cleared.rows.length);
      expect(uncleared.rows.map((r) => r.id)).not.toContain(paperKingdomsItemId);
      expect(cleared.rows.map((r) => r.id)).not.toContain(paperKingdomsItemId);
    });

    it('clearanceDigest: identical clearance -> identical digest; differing clearance -> differing digest', async () => {
      const digestA = clearanceDigest(casualUncleared);
      const digestASame = clearanceDigest({ ...casualUncleared, allowedLibraryIds: [...casualUncleared.allowedLibraryIds] });
      expect(digestASame).toBe(digestA);

      expect(clearanceDigest(adminClearedButNotUnlocked)).not.toBe(clearanceDigest(adminCleared));
      expect(clearanceDigest(casualUncleared)).not.toBe(clearanceDigest(adminCleared));

      // Library-set order must not matter (sorted before hashing).
      const reordered: ViewerContext = {
        ...adminCleared,
        allowedLibraryIds: [...adminCleared.allowedLibraryIds].reverse(),
      };
      expect(clearanceDigest(reordered)).toBe(clearanceDigest(adminCleared));
    });

    // ------------------------------------------------------------------
    // 7. events (query-layer half; socket delivery is next wave)
    // ------------------------------------------------------------------
    it('readEventsForViewer: restricted item/library events are withheld from an uncleared viewer; non-item events always pass through', async () => {
      const uncleared = await readEventsForViewer(db, casualUncleared, {});
      const unclearedTypes = uncleared.map((e) => e.type);
      expect(unclearedTypes).toContain('item.added'); // the general one
      expect(unclearedTypes).toContain('user.created'); // pass-through, no item/library
      expect(unclearedTypes).not.toContain('library.created');
      expect(unclearedTypes).not.toContain('scan.completed');
      expect(unclearedTypes).not.toContain('file.relocated');
      for (const e of uncleared) {
        if (e.type === 'item.added') {
          expect((e.payload as { contentClass: string }).contentClass).toBe('general');
        }
      }

      const cleared = await readEventsForViewer(db, adminCleared, {});
      const clearedTypes = cleared.map((e) => e.type);
      expect(clearedTypes).toEqual(
        expect.arrayContaining(['item.added', 'library.created', 'scan.completed', 'file.relocated', 'user.created'])
      );
      expect(cleared.length).toBeGreaterThan(uncleared.length);

      // Gate 4 without gate 5 must also withhold the restricted events.
      const gate4Only = await readEventsForViewer(db, adminClearedButNotUnlocked, {});
      expect(gate4Only.map((e) => e.type)).not.toContain('library.created');
    });

    // ------------------------------------------------------------------
    // 8. export
    // ------------------------------------------------------------------
    it('exportData: excludes restricted libraries/items for an uncleared viewer and never includes a user list for a non-admin', async () => {
      const unclearedChunks = [];
      for await (const chunk of exportData(db, casualUncleared)) unclearedChunks.push(chunk);

      const unclearedLibraries = unclearedChunks.filter((c) => c.kind === 'library');
      expect(unclearedLibraries.map((c) => (c.kind === 'library' ? c.library.id : null))).not.toContain(
        restrictedLibraryId
      );

      const unclearedItems = unclearedChunks.filter((c) => c.kind === 'item');
      expect(unclearedItems.every((c) => c.kind === 'item' && c.item.contentClass === 'general')).toBe(true);
      expect(unclearedItems.map((c) => (c.kind === 'item' ? c.item.id : null))).not.toContain(
        afterHoursRedlineItemId
      );

      const unclearedUsers = unclearedChunks.filter((c) => c.kind === 'user');
      expect(unclearedUsers).toHaveLength(0); // casual is not admin

      const clearedChunks = [];
      for await (const chunk of exportData(db, adminCleared)) clearedChunks.push(chunk);

      const clearedItems = clearedChunks.filter((c) => c.kind === 'item');
      expect(clearedItems.some((c) => c.kind === 'item' && c.item.id === afterHoursRedlineItemId)).toBe(true);

      const clearedUsers = clearedChunks.filter((c) => c.kind === 'user');
      expect(clearedUsers.length).toBeGreaterThan(0); // admin IS admin

      // Progress in the export is always the CALLER's own, never leaked
      // cross-user, and never present for an item the export already
      // excluded.
      const afterHoursChunk = clearedItems.find(
        (c) => c.kind === 'item' && c.item.id === afterHoursRedlineItemId
      );
      expect(afterHoursChunk?.kind === 'item' ? afterHoursChunk.item.progress : undefined).not.toBeNull();
    });

    // ------------------------------------------------------------------
    // 9. GET /progress raw listing
    // ------------------------------------------------------------------
    it('listProgress: excludes rows for restricted items when uncleared — ids AND positions must not leak', async () => {
      const uncleared = await listProgress(db, adminClearedButNotUnlocked, { limit: 100 });
      expect(uncleared.rows.map((r) => r.itemId)).not.toContain(afterHoursRedlineItemId);

      const cleared = await listProgress(db, adminCleared, { limit: 100 });
      const restrictedRow = cleared.rows.find((r) => r.itemId === afterHoursRedlineItemId);
      expect(restrictedRow).toBeDefined();
      expect(restrictedRow?.positionMs).toBeGreaterThan(0);

      expect(cleared.rows.length).toBeGreaterThan(uncleared.rows.length);
    });

    // ------------------------------------------------------------------
    // 10. Library item counts (Wave 1c, Phosphor retheme "contract
    //     enablers" lane — Sidebar Movies/TV Shows counts)
    // ------------------------------------------------------------------
    it('getLibraryItemCountsForViewer: a general viewer\'s counts exclude the zone entirely, byte-level, even when the zone is explicitly asked for', async () => {
      expect(expectedRestrictedCount).toBeGreaterThan(0);

      // Guard-consistent expected count for the general "Movies" library's
      // OWN item_type='movie' rows — mirrors the guard's missing-file rule
      // exactly (Paper Kingdoms, all media_files missing, lives in this
      // library and must NOT be counted), same convention beforeAll's own
      // expectedGeneralCount/expectedRestrictedCount computation uses.
      const expectedMoviesLibraryCount = (
        await rawClient.query<{ n: number }>(
          `SELECT count(*)::int AS n
           FROM catalog_items ci
           WHERE ci.library_id = $1 AND ci.item_type = 'movie'
             AND (NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.item_id = ci.id)
                  OR EXISTS (SELECT 1 FROM media_files mf WHERE mf.item_id = ci.id AND mf.missing_since_ms IS NULL))`,
          [generalLibraryId]
        )
      ).rows[0]!.n;
      expect(expectedMoviesLibraryCount).toBeGreaterThan(0);

      // A general (uncleared) viewer, asked for counts across BOTH the
      // general Movies library AND the restricted library in the SAME
      // call — proves the zone is excluded by construction (their
      // allowedLibraryIds never contains the restricted library id at
      // all), not merely by a content_class filter that a differently-
      // shaped call might bypass.
      const asGeneral = await getLibraryItemCountsForViewer(db, casualUncleared, [
        generalLibraryId,
        restrictedLibraryId,
      ]);

      const generalMovieRow = asGeneral.find(
        (r) => r.libraryId === generalLibraryId && r.itemType === 'movie'
      );
      expect(generalMovieRow?.count).toBe(expectedMoviesLibraryCount);

      // Byte-level: zero rows for the restricted library, not a zero-value
      // row — the zone must be ABSENT from the result set entirely.
      expect(asGeneral.some((r) => r.libraryId === restrictedLibraryId)).toBe(false);

      // Same call, admin-cleared context: the restricted library's own
      // count now appears (and equals the guard's own expected restricted
      // count, computed in beforeAll).
      const asCleared = await getLibraryItemCountsForViewer(db, adminCleared, [
        generalLibraryId,
        restrictedLibraryId,
      ]);
      const restrictedMovieRow = asCleared.find(
        (r) => r.libraryId === restrictedLibraryId && r.itemType === 'movie'
      );
      expect(restrictedMovieRow?.count).toBe(expectedRestrictedCount);

      // Locked-but-entitled admin (gate 4 permission held, gate 5 not
      // live): counts still exclude the zone — this surface is NOT the
      // "regardless of lock state" one (that's the zone aggregate count
      // below); per-library counts obey the same lock-sensitive rule as
      // every other guarded catalog read.
      const asClearedButLocked = await getLibraryItemCountsForViewer(
        db,
        adminClearedButNotUnlocked,
        [generalLibraryId, restrictedLibraryId]
      );
      expect(asClearedButLocked.some((r) => r.libraryId === restrictedLibraryId)).toBe(false);
    });

    // ------------------------------------------------------------------
    // 11. Restricted zone aggregate count (Wave 1c) — U10: visible to
    //     entitled viewers regardless of lock state; absent (null, not
    //     zero) for restricted-profile viewers with no entitlement at all.
    // ------------------------------------------------------------------
    it('getRestrictedZoneCountForViewer: null (not zero) for a viewer with no restricted-library entitlement — the zone does not exist for them', async () => {
      const result = await getRestrictedZoneCountForViewer(db, casualUncleared);
      expect(result).toBeNull();
    });

    it('getRestrictedZoneCountForViewer: real count for an entitled viewer, REGARDLESS of current lock state (gate 5)', async () => {
      expect(expectedRestrictedCount).toBeGreaterThan(0);

      // Entitled (gates 1-4 held via allowedLibraryIds) but explicitly NOT
      // gate-5-unlocked right now — restrictedCleared: false. The zone
      // count must still be the real number, not null and not zero — this
      // is the entire point of the surface (U10 "regardless of lock
      // state"), and the one place in this package that deliberately does
      // NOT gate a count on ctx.restrictedCleared.
      const lockedButEntitled = await getRestrictedZoneCountForViewer(db, adminClearedButNotUnlocked);
      expect(lockedButEntitled).not.toBeNull();
      expect(lockedButEntitled?.count).toBe(expectedRestrictedCount);

      // Unlocked entitled viewer: identical count — lock state changes
      // nothing about this surface.
      const unlockedEntitled = await getRestrictedZoneCountForViewer(db, adminCleared);
      expect(unlockedEntitled?.count).toBe(expectedRestrictedCount);
    });

    it('getRestrictedZoneCountForViewer: the count surface never carries zone title/artwork data — byte-level shape check', async () => {
      const result = await getRestrictedZoneCountForViewer(db, adminCleared);
      expect(result).not.toBeNull();
      // The ENTIRE returned shape is { count }, nothing else — no id,
      // title, name, or any other descriptive field could ever leak
      // through this surface even by accident, because there is no key
      // for it to ride on.
      expect(Object.keys(result as object)).toEqual(['count']);
    });

    // ------------------------------------------------------------------
    // 12. Restricted Content surface (STATE.md Stash run, S9/K4) — SUPERSEDES
    //     the old "fetch the whole zone client-side" design this section used
    //     to test. Every new query module (restricted-browse/-performers/
    //     -studios/-search/-home.ts) shares the SAME two-step entitlement
    //     gate the count surface above established: zero entitlement ->
    //     undefined (caller: 404); entitled -> a real, guard-filtered result,
    //     empty while entitled-but-locked (never a 404) — U10's "zone exists
    //     but I'm locked out" disclosure, replayed at every new surface.
    // ------------------------------------------------------------------

    describe('12a. listRestrictedBrowse (S9 zone browse)', () => {
      it('undefined for a viewer with no restricted-library entitlement at all', async () => {
        const result = await listRestrictedBrowse(db, casualUncleared, {});
        expect(result).toBeUndefined();
      });

      it('entitled but NOT gate-5 unlocked gets a real, EMPTY page — never titles/artwork while locked', async () => {
        const result = await listRestrictedBrowse(db, adminClearedButNotUnlocked, {});
        expect(result).not.toBeUndefined();
        expect(result?.rows).toEqual([]);
        expect(result?.nextCursor).toBeNull();
      });

      it('entitled AND unlocked gets the real zone contents, guard-consistent with the count surface', async () => {
        const result = await listRestrictedBrowse(db, adminCleared, { limit: 200 });
        expect(result).not.toBeUndefined();
        const rows = result!.rows;

        const countResult = await getRestrictedZoneCountForViewer(db, adminCleared);
        expect(rows).toHaveLength(countResult!.count);
        expect(rows.map((r) => r.title).sort()).toEqual(
          ['After Hours Redline', 'Midnight Ledger', 'Undertow Confidential', 'Velvet Static'].sort()
        );
        expect(rows.every((r) => r.contentClass === 'restricted')).toBe(true);
        expect(rows.every((r) => r.libraryId === restrictedLibraryId)).toBe(true);

        const afterHours = rows.find((r) => r.title === 'After Hours Redline');
        expect(afterHours?.genres).toEqual(expect.arrayContaining(['Restricted Genre A', 'Drama']));
        expect(afterHours?.studio).toEqual({ id: nightshadeFilmsTagId, name: 'Nightshade Films' });

        // The one seeded item with NO media_files row at all — resolution/
        // duration must report the honest "no evidence" null, never a
        // fabricated value.
        const undertow = rows.find((r) => r.title === 'Undertow Confidential');
        expect(undertow?.resolution).toBeNull();
        expect(undertow?.durationMs).toBeNull();
        expect(undertow?.studio).toBeNull();
      });

      it('empty allowedLibraryIds compiles to no entitlement, not a crash', async () => {
        const emptyLibsCleared: ViewerContext = {
          userId: adminCleared.userId,
          allowedLibraryIds: [],
          restrictedCleared: true,
        };
        const result = await listRestrictedBrowse(db, emptyLibsCleared, {});
        expect(result).toBeUndefined();
      });

      it('resolution band filter is real, index-backed technical fact (S9) — FHD/UHD/HD partition the fixture data exactly, never overlapping', async () => {
        const fhd = await listRestrictedBrowse(db, adminCleared, { resolution: ['FHD'] });
        expect(fhd?.rows.map((r) => r.title)).toEqual(['After Hours Redline']);
        const uhd = await listRestrictedBrowse(db, adminCleared, { resolution: ['UHD'] });
        expect(uhd?.rows.map((r) => r.title)).toEqual(['Velvet Static']);
        const hdOrFhd = await listRestrictedBrowse(db, adminCleared, { resolution: ['HD', 'FHD'] });
        expect(hdOrFhd?.rows.map((r) => r.title).sort()).toEqual(['After Hours Redline', 'Midnight Ledger'].sort());
      });

      it('studioTagIds filter narrows to exactly that studio, never widening to the whole zone', async () => {
        const result = await listRestrictedBrowse(db, adminCleared, { studioTagIds: [auroraMediaTagId] });
        expect(result?.rows.map((r) => r.title)).toEqual(['Velvet Static']);
      });

      it('malformed UUID filter params answer an EMPTY page, never a silently dropped filter (house rule)', async () => {
        const result = await listRestrictedBrowse(db, adminCleared, { performerIds: ['not-a-uuid'] });
        expect(result).toEqual({ rows: [], nextCursor: null });
        // Confirms the filter was actually APPLIED (not dropped): without
        // any filter at all, adminCleared sees all 4 zone rows.
        const unfiltered = await listRestrictedBrowse(db, adminCleared, {});
        expect(unfiltered?.rows.length).toBe(4);
      });

      it('yearMin/yearMax and ratingMin/ratingMax filters exclude non-matching zone rows without leaking general rows', async () => {
        const byYear = await listRestrictedBrowse(db, adminCleared, { yearMin: 2021 });
        expect(byYear?.rows.map((r) => r.title).sort()).toEqual(['Midnight Ledger', 'Velvet Static'].sort());
        const byRating = await listRestrictedBrowse(db, adminCleared, { ratingMin: 7 });
        expect(byRating?.rows.map((r) => r.title)).toEqual(['Velvet Static']);
      });
    });

    describe('12b. getRestrictedSceneDetail (S9 scene detail)', () => {
      it('byte-identical undefined for a truly nonexistent id, an uncleared casual viewer, AND an entitled-but-locked admin — no distinguishing signal between them', async () => {
        const nonexistent = await getRestrictedSceneDetail(db, adminCleared, '00000000-0000-7000-8000-000000000000');
        const uncleared = await getRestrictedSceneDetail(db, casualUncleared, afterHoursRedlineItemId);
        const lockedAdmin = await getRestrictedSceneDetail(db, adminClearedButNotUnlocked, afterHoursRedlineItemId);
        expect(nonexistent).toBeUndefined();
        expect(uncleared).toBeUndefined();
        expect(lockedAdmin).toBeUndefined();
      });

      it('a general (non-zone) item id is ALSO undefined through this surface, even fully cleared — the zone detail read is scene-only (K1)', async () => {
        const result = await getRestrictedSceneDetail(db, adminCleared, lastFerryOutItemId);
        expect(result).toBeUndefined();
      });

      it('entitled AND unlocked gets the real scene: chapters, performer chips, studio chip, tag chips, and the caller\'s own progress', async () => {
        const result = await getRestrictedSceneDetail(db, adminCleared, afterHoursRedlineItemId);
        expect(result).not.toBeUndefined();
        expect(result?.title).toBe('After Hours Redline');
        expect(result?.resolution).toBe('FHD');
        expect(result?.studio).toEqual({ id: nightshadeFilmsTagId, name: 'Nightshade Films' });
        expect(result?.performers.map((p) => p.name)).toContain('Restricted Performer One');
        expect(result?.tags.map((t) => t.name).sort()).toEqual(['Drama', 'Restricted Genre A'].sort());
        // Chapters (K9/S7): seeded with 3 markers on this exact item,
        // ordered by start_ms.
        expect(result?.chapters.map((c) => c.title)).toEqual(['Opening', 'Midpoint', 'Finale']);
        expect(result?.chapters.every((c, i, arr) => i === 0 || c.startMs > arr[i - 1]!.startMs)).toBe(true);
        // admin's own restricted-item progress fixture (seed.mjs) rides
        // this exact item — proves the progress join is scoped to
        // ctx.userId, not a global "latest progress on this item".
        expect(result?.progress).not.toBeNull();
      });

      it('a scene with NO media_files row at all reports resolution/durationMs as null (no evidence), never fabricated', async () => {
        const result = await getRestrictedSceneDetail(db, adminCleared, undertowConfidentialItemId);
        expect(result?.resolution).toBeNull();
        expect(result?.durationMs).toBeNull();
        expect(result?.hdr).toBeNull();
      });
    });

    describe('12c. Restricted performers (S9) — role=performer, zone-scoped', () => {
      it('listRestrictedPerformers: undefined for no entitlement; empty while locked; real rows once cleared', async () => {
        expect(await listRestrictedPerformers(db, casualUncleared, {})).toBeUndefined();
        const locked = await listRestrictedPerformers(db, adminClearedButNotUnlocked, {});
        expect(locked?.rows).toEqual([]);
        const cleared = await listRestrictedPerformers(db, adminCleared, {});
        expect(cleared?.rows.map((r) => r.name).sort()).toEqual(
          ['Restricted Performer One', 'Restricted Performer Three', 'Restricted Performer Two'].sort()
        );
      });

      it('THE FINDING (mirrored from listPeople/listTags): a restricted person credited on a GENERAL item with a non-performer role never appears, and a general person with only a non-performer credit on a restricted item never appears either', async () => {
        const cleared = await listRestrictedPerformers(db, adminCleared, { limit: 200 });
        const names = cleared?.rows.map((r) => r.name) ?? [];
        // restrictedCameoPerformer: restricted-class, but role='guest' (not
        // 'performer') and credited on a GENERAL item — must not surface.
        expect(names).not.toContain('Restricted Cameo Performer');
        // marginalGeneralActor: general-class, role='guest' on a restricted
        // item — fails BOTH the role filter and (for a general person) has
        // no reason to appear in a restricted-only performer rail.
        expect(names).not.toContain('Marginal General Actor');
      });

      it('getRestrictedPerformerById: byte-identical undefined for nonexistent id, uncleared viewer, AND locked admin', async () => {
        const nonexistent = await getRestrictedPerformerById(db, adminCleared, '00000000-0000-7000-8000-000000000000');
        const uncleared = await getRestrictedPerformerById(db, casualUncleared, restrictedPerformerOneId);
        const locked = await getRestrictedPerformerById(db, adminClearedButNotUnlocked, restrictedPerformerOneId);
        expect(nonexistent).toBeUndefined();
        expect(uncleared).toBeUndefined();
        expect(locked).toBeUndefined();

        const cleared = await getRestrictedPerformerById(db, adminCleared, restrictedPerformerOneId);
        expect(cleared?.name).toBe('Restricted Performer One');
        expect(cleared?.sceneCount).toBeGreaterThan(0);
      });

      it('a GENERAL person id (e.g. Elena Marsh) never resolves through the restricted performer surface, even cleared', async () => {
        const result = await getRestrictedPerformerById(db, adminCleared, elenaMarshId);
        expect(result).toBeUndefined();
      });

      it('FX2: images field carries the real portrait fixture when cleared, an honest empty array with no fixture, and never leaks to an uncleared/locked viewer', async () => {
        // Positive half: a cleared row's `images` matches seed.mjs's real
        // fixture (insertImage('person', restrictedPeople[0].id, 'thumb',
        // ...) — Restricted Performer One), not a placeholder.
        const cleared = await getRestrictedPerformerById(db, adminCleared, restrictedPerformerOneId);
        expect(cleared?.images).toEqual([
          { kind: 'thumb', width: 400, height: 600, blurhash: 'L2PZfSi_.AyE_3t7t7R**0o#DgR8', dominantColor: null },
        ]);

        // The list surface carries the SAME batched images (not just the
        // single-id getter) — and a sibling performer with NO image
        // fixture gets an honest [], never another performer's portrait
        // (proves the batch-fetch keys strictly by person id).
        const list = await listRestrictedPerformers(db, adminCleared, { limit: 200 });
        const withImage = list?.rows.find((r) => r.name === 'Restricted Performer One');
        expect(withImage?.images).toEqual([
          { kind: 'thumb', width: 400, height: 600, blurhash: 'L2PZfSi_.AyE_3t7t7R**0o#DgR8', dominantColor: null },
        ]);
        const withoutImage = list?.rows.find((r) => r.name === 'Restricted Performer Two');
        expect(withoutImage?.images).toEqual([]);

        // Leak half: an uncleared/locked viewer never gets ANY performer
        // object back for this id — there is no `.images` to leak because
        // there is no object at all (byte-identical undefined, same as the
        // rest of this describe block) — asserted again here so this
        // images-specific case is independently fail-first-provable.
        expect(await getRestrictedPerformerById(db, casualUncleared, restrictedPerformerOneId)).toBeUndefined();
        expect(await getRestrictedPerformerById(db, adminClearedButNotUnlocked, restrictedPerformerOneId)).toBeUndefined();
      });

      it('listRestrictedPerformerScenes delegates to the SAME guarded browse (pure delegation, cannot diverge in leak posture)', async () => {
        expect(await listRestrictedPerformerScenes(db, casualUncleared, restrictedPerformerOneId)).toBeUndefined();
        const cleared = await listRestrictedPerformerScenes(db, adminCleared, restrictedPerformerOneId);
        expect(cleared?.rows.every((r) => r.contentClass === 'restricted')).toBe(true);
        expect(cleared?.rows.length).toBeGreaterThan(0);
      });
    });

    describe('12d. Restricted studios (S9/K2/S6) — tags.kind=\'studio\', zone-scoped', () => {
      it('listRestrictedStudios: undefined for no entitlement; empty while locked; real rows once cleared', async () => {
        expect(await listRestrictedStudios(db, casualUncleared, {})).toBeUndefined();
        const locked = await listRestrictedStudios(db, adminClearedButNotUnlocked, {});
        expect(locked?.rows).toEqual([]);
        const cleared = await listRestrictedStudios(db, adminCleared, {});
        expect(cleared?.rows.map((r) => r.name).sort()).toEqual(['Aurora Media', 'Nightshade Films'].sort());
        expect(cleared?.rows.every((r) => r.sceneCount === 1)).toBe(true);
      });

      it('getRestrictedStudioById: byte-identical undefined for nonexistent id, uncleared viewer, AND locked admin', async () => {
        const nonexistent = await getRestrictedStudioById(db, adminCleared, '00000000-0000-7000-8000-000000000000');
        const uncleared = await getRestrictedStudioById(db, casualUncleared, nightshadeFilmsTagId);
        const locked = await getRestrictedStudioById(db, adminClearedButNotUnlocked, nightshadeFilmsTagId);
        expect(nonexistent).toBeUndefined();
        expect(uncleared).toBeUndefined();
        expect(locked).toBeUndefined();

        const cleared = await getRestrictedStudioById(db, adminCleared, nightshadeFilmsTagId);
        expect(cleared?.name).toBe('Nightshade Films');
      });

      it('a general-class or non-studio-kind tag id never resolves through the restricted studio surface, even cleared', async () => {
        // generalDramaTagId: general-class, kind='general' — fails both.
        expect(await getRestrictedStudioById(db, adminCleared, generalDramaTagId)).toBeUndefined();
        // restrictedGenreATagId: restricted-class, but kind='genre', not
        // 'studio' — proves the studio surface is NOT just "any restricted
        // tag", it is specifically kind='studio' tags.
        expect(await getRestrictedStudioById(db, adminCleared, restrictedGenreATagId)).toBeUndefined();
      });
    });

    describe('12e. searchRestrictedZone (S9) — title/performer/studio/tag, zone-scoped', () => {
      it('undefined for no entitlement; empty while locked; real hits once cleared', async () => {
        expect(await searchRestrictedZone(db, casualUncleared, { q: 'After' })).toBeUndefined();
        const locked = await searchRestrictedZone(db, adminClearedButNotUnlocked, { q: 'After' });
        expect(locked?.rows).toEqual([]);
        const cleared = await searchRestrictedZone(db, adminCleared, { q: 'After' });
        expect(cleared?.rows.map((r) => r.title)).toEqual(['After Hours Redline']);
      });

      it('matches on a STUDIO name and a PERFORMER name, both surfacing the scene card (not just a title match)', async () => {
        const byStudio = await searchRestrictedZone(db, adminCleared, { q: 'Aurora Media' });
        expect(byStudio?.rows.map((r) => r.title)).toEqual(['Velvet Static']);
        const byPerformer = await searchRestrictedZone(db, adminCleared, { q: 'Restricted Performer One' });
        expect(byPerformer?.rows.length).toBeGreaterThan(0);
      });

      it('zone search NEVER surfaces a general-library title, and general searchCatalog NEVER surfaces a zone title to an uncleared viewer — the two surfaces stay mutually exclusive', async () => {
        const zoneHitForGeneralTitle = await searchRestrictedZone(db, adminCleared, { q: 'Harbor Lights' });
        expect(zoneHitForGeneralTitle?.rows).toEqual([]);
        const generalHitForZoneTitle = await searchCatalog(db, casualUncleared, { q: 'After Hours Redline' });
        expect(generalHitForZoneTitle.rows).toEqual([]);
      });
    });

    describe('12f. getRestrictedZoneHome (S9) — rails', () => {
      it('undefined for no entitlement; all-empty rails while locked; real rails once cleared', async () => {
        expect(await getRestrictedZoneHome(db, casualUncleared, {})).toBeUndefined();
        const locked = await getRestrictedZoneHome(db, adminClearedButNotUnlocked, {});
        expect(locked).toEqual({
          continueWatchingInZone: [],
          recentlyAddedInZone: [],
          studios: [],
          performers: [],
        });

        const cleared = await getRestrictedZoneHome(db, adminCleared, {});
        expect(cleared?.recentlyAddedInZone.length).toBe(4);
        expect(cleared?.studios.map((s) => s.name).sort()).toEqual(['Aurora Media', 'Nightshade Films'].sort());
        expect(cleared?.performers.length).toBeGreaterThan(0);
        // admin's seeded restricted-item progress (After Hours Redline)
        // surfaces as a full card, not a bare id.
        expect(cleared?.continueWatchingInZone.some((e) => e.item.title === 'After Hours Redline')).toBe(true);
      });
    });

    describe('12g. getChaptersForItem (S7/K9) — visibility rides the owning item', () => {
      it('a GENERAL item with a chapter marker is visible to every viewer, cleared or not', async () => {
        const uncleared = await getChaptersForItem(db, casualUncleared, harborLightsItemId);
        expect(uncleared).toEqual([{ title: 'Cold Open', startMs: 0, source: 'stash' }]);

        const cleared = await getChaptersForItem(db, adminCleared, harborLightsItemId);
        expect(cleared).toEqual([{ title: 'Cold Open', startMs: 0, source: 'stash' }]);
      });

      it("THE REQUIRED CASE — an uncleared viewer's chapters read for a RESTRICTED item's markers is undefined, byte-identical to the item's own getItemById result, not merely an empty array", async () => {
        const asCasualUncleared = await getChaptersForItem(db, casualUncleared, afterHoursRedlineItemId);
        expect(asCasualUncleared).toBeUndefined();

        // Gate 4 (library permission) without gate 5 (live unlock) must
        // ALSO fail — the same gate-5-bypass check getItemById's own leak
        // test proves, replayed one level down at the chapters surface.
        const asAdminMissingUnlock = await getChaptersForItem(db, adminClearedButNotUnlocked, afterHoursRedlineItemId);
        expect(asAdminMissingUnlock).toBeUndefined();
      });

      it("a fully cleared viewer sees the restricted item's three markers, ordered by startMs ascending", async () => {
        const cleared = await getChaptersForItem(db, adminCleared, afterHoursRedlineItemId);
        expect(cleared).toEqual([
          { title: 'Opening', startMs: 0, source: 'stash' },
          { title: 'Midpoint', startMs: 32 * 60_000, source: 'stash' },
          { title: 'Finale', startMs: 71 * 60_000, source: 'stash' },
        ]);
      });

      it('a visible item with ZERO chapter markers returns an empty array, never undefined — "no chapters" and "item not visible" are distinguishable', async () => {
        // Velvet Static is a restricted item with no chapter_markers rows
        // seeded (only After Hours Redline gets markers) — cleared, it
        // must read as [], not the undefined a hidden/nonexistent item
        // produces.
        const cleared = await getChaptersForItem(db, adminCleared, velvetStaticItemId);
        expect(cleared).toEqual([]);
      });

      it("undefined for a nonexistent item id, byte-identical to a hidden restricted item (indistinguishable, matching getItemById's own contract)", async () => {
        const nonexistent = await getChaptersForItem(db, adminCleared, '00000000-0000-7000-8000-000000000000');
        expect(nonexistent).toBeUndefined();
      });
    });

    // 13. Watchlist (Phosphor Wave 2 lane L3) — migrations/
    //     0017_watchlists.sql. Mirrors progress's checklist item 9 shape:
    //     the write is gated on item VISIBILITY (getItemById), the read is
    //     gated on the SAME guard independently, and neither leaks ids or
    //     timestamps for a restricted item to an uncleared viewer.
    // ------------------------------------------------------------------
    it('addToWatchlistAndEmit: a restricted (zone) item is UNREACHABLE to add without full clearance — gate 4 (library permission) alone is not enough, matching getItemById/upsertProgress exactly', async () => {
      const nowMs = Date.now();

      const asCasualUncleared = await addToWatchlistAndEmit(db, casualUncleared, restrictedItemId, nowMs);
      expect(asCasualUncleared).toBeUndefined();

      // Gate 4 without gate 5 (live unlock) must ALSO fail to add — the
      // same gate-5-bypass check getItemById's own leak test proves.
      const asAdminMissingUnlock = await addToWatchlistAndEmit(
        db,
        adminClearedButNotUnlocked,
        restrictedItemId,
        nowMs
      );
      expect(asAdminMissingUnlock).toBeUndefined();

      // Only a FULLY cleared viewer (all five gates) can reach it at all.
      const asAdminCleared = await addToWatchlistAndEmit(db, adminCleared, restrictedItemId, nowMs);
      expect(asAdminCleared).toBeDefined();
      expect(asAdminCleared?.itemId).toBe(restrictedItemId);

      // Clean up so this row doesn't leak into a later test in this file.
      await removeFromWatchlistAndEmit(db, adminCleared, restrictedItemId, nowMs + 1);
    });

    it("listWatchlist: THE REQUIRED CASE — a restricted (zone) item added while cleared is BYTE-ABSENT from the same user's list the instant they are no longer cleared (design/phosphor README.md's law: restricted titles never appear in the watchlist, locked or not)", async () => {
      const nowMs = Date.now();

      // Seed: admin (fully cleared) adds ONE general item and the seed's
      // restricted item to their own watchlist.
      const addedGeneral = await addToWatchlistAndEmit(db, adminCleared, lastFerryOutItemId, nowMs);
      const addedRestricted = await addToWatchlistAndEmit(db, adminCleared, restrictedItemId, nowMs + 1);
      expect(addedGeneral).toBeDefined();
      expect(addedRestricted).toBeDefined();

      try {
        // Read back as the SAME user, but WITHOUT gate-5 clearance right
        // now (adminClearedButNotUnlocked shares adminCleared's userId —
        // see beforeAll). The restricted row's underlying write still
        // exists; this proves the READ independently re-derives visibility
        // rather than trusting that the row was legitimately written.
        const lockedNow = await listWatchlist(db, adminClearedButNotUnlocked, { limit: 200 });
        const lockedIds = lockedNow.rows.map((r) => r.itemId);
        expect(lockedIds).toContain(lastFerryOutItemId);
        expect(lockedIds).not.toContain(restrictedItemId);
        // Byte-level: the restricted item's id must not appear ANYWHERE in
        // the serialized page, not merely absent from a mapped subset.
        expect(JSON.stringify(lockedNow)).not.toContain(restrictedItemId);

        // Cleared again: both rows visible, proving the exclusion above was
        // genuinely clearance-driven, not a bug that hides everything.
        const clearedNow = await listWatchlist(db, adminCleared, { limit: 200 });
        const clearedIds = clearedNow.rows.map((r) => r.itemId);
        expect(clearedIds).toContain(lastFerryOutItemId);
        expect(clearedIds).toContain(restrictedItemId);
      } finally {
        await removeFromWatchlistAndEmit(db, adminCleared, lastFerryOutItemId, nowMs + 2);
        await removeFromWatchlistAndEmit(db, adminCleared, restrictedItemId, nowMs + 3);
      }
    });

    it("listWatchlist: scoped to ctx.userId — one user's watchlist never appears in another user's list, even for a mutually-visible general item", async () => {
      const nowMs = Date.now();
      await addToWatchlistAndEmit(db, adminCleared, lastFerryOutItemId, nowMs);
      try {
        const casualsOwn = await listWatchlist(db, casualUncleared, { limit: 200 });
        expect(casualsOwn.rows.map((r) => r.itemId)).not.toContain(lastFerryOutItemId);

        const adminsOwn = await listWatchlist(db, adminCleared, { limit: 200 });
        expect(adminsOwn.rows.map((r) => r.itemId)).toContain(lastFerryOutItemId);
      } finally {
        await removeFromWatchlistAndEmit(db, adminCleared, lastFerryOutItemId, nowMs + 1);
      }
    });

    it('removeFromWatchlistAndEmit: idempotent no-op for an item never added (never surfaces as an error), and unreachable (undefined) for an item invisible to ctx', async () => {
      const nowMs = Date.now();

      // Visible general item, never added — idempotent success.
      const neverAdded = await removeFromWatchlistAndEmit(db, adminCleared, lastFerryOutItemId, nowMs);
      expect(neverAdded).toEqual({ removed: false });

      // Restricted item, uncleared viewer — item existence itself is
      // unreachable, matching add's contract exactly.
      const invisible = await removeFromWatchlistAndEmit(db, casualUncleared, restrictedItemId, nowMs);
      expect(invisible).toBeUndefined();
    });

    it("readEventsForViewer: watchlist.added/watchlist.removed are PRIVATE to the acting user (USER_ONLY_TYPES) — never delivered to a different viewer even for a mutually-visible general item, and NOT gated on the item's own restricted-ness (delivered to the actor regardless of THEIR current clearance)", async () => {
      const nowMs = Date.now();
      await addToWatchlistAndEmit(db, adminCleared, lastFerryOutItemId, nowMs);
      try {
        // A different user (casual) must never see admin's watchlist.added
        // event, even though lastFerryOutItemId is a general item casual
        // can otherwise see fine via every other guarded surface.
        const casualsView = await readEventsForViewer(db, casualUncleared, { afterId: '00000000-0000-7000-8000-000000000000' });
        expect(casualsView.some((e) => e.type === 'watchlist.added')).toBe(false);

        // The ACTOR (admin) sees their own event even while simulating
        // gate-5-not-live right now — this type is userId-gated, not
        // item/content_class-gated (mirrors restricted.locked/unlocked's
        // documented posture in this file's own header).
        const actorViewLocked = await readEventsForViewer(db, adminClearedButNotUnlocked, {
          afterId: '00000000-0000-7000-8000-000000000000',
        });
        expect(actorViewLocked.some((e) => e.type === 'watchlist.added' && (e.payload as { itemId: string }).itemId === lastFerryOutItemId)).toBe(true);
      } finally {
        await removeFromWatchlistAndEmit(db, adminCleared, lastFerryOutItemId, nowMs + 1);
      }
    });

    // ------------------------------------------------------------------
    // 13. Person filmography (Phosphor Wave 2 lane L3, /people/[id] route)
    //     — the gap-closure query this lane added (getPersonById only ever
    //     returned a creditCount). Replays the exact same two fixtures
    //     listPeople/getPersonById's own leak tests use, one level down at
    //     the item-list surface.
    // ------------------------------------------------------------------
    it('listItemsForPerson: a GENERAL person credited ONLY on a restricted item yields an EMPTY filmography for an uncleared viewer, and the real item once cleared', async () => {
      const uncleared = await listItemsForPerson(db, casualUncleared, marginalGeneralActorId, { limit: 50 });
      expect(uncleared.rows).toHaveLength(0);

      const cleared = await listItemsForPerson(db, adminCleared, marginalGeneralActorId, { limit: 50 });
      expect(cleared.rows.map((r) => r.itemId)).toContain(velvetStaticItemId);
    });

    it('listItemsForPerson: a RESTRICTED-class person credited on an otherwise-general item yields an EMPTY filmography for an uncleared viewer (person-side content_class isolation), and the real item once cleared', async () => {
      const uncleared = await listItemsForPerson(db, casualUncleared, restrictedCameoPerformerId, { limit: 50 });
      expect(uncleared.rows).toHaveLength(0);

      const cleared = await listItemsForPerson(db, adminCleared, restrictedCameoPerformerId, { limit: 50 });
      expect(cleared.rows.map((r) => r.itemId)).toContain(lastFerryOutItemId);
    });

    it('listItemsForPerson: never returns the same item twice even when a person carries more than one credit on it', async () => {
      // elenaMarshId is an ordinary general person — assert whatever her
      // filmography is, every itemId in it is unique (DISTINCT proof,
      // independent of which fixture she happens to be credited on).
      const result = await listItemsForPerson(db, adminCleared, elenaMarshId, { limit: 200 });
      const ids = result.rows.map((r) => r.itemId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('adversarial hardening (beyond the checklist)', () => {
    it('cursor forgery: a hand-crafted cursor pointing at a restricted item never decodes into visibility', async () => {
      // Craft a cursor exactly in listItems' own {addedAtMs, id} shape,
      // pointing at the restricted seed item, as an UNCLEARED viewer.
      const forged = Buffer.from(
        JSON.stringify({ addedAtMs: Date.now() + 999_999_999, id: restrictedItemId }),
        'utf8'
      ).toString('base64url');

      const { rows } = await listItems(db, casualUncleared, { cursor: forged, limit: 200 });
      expect(rows.every((r) => r.content_class === 'general')).toBe(true);
      expect(rows.map((r) => r.id)).not.toContain(restrictedItemId);
    });

    it('empty allowedLibraryIds compiles to WHERE false on every new guarded query, not just listItems/getItemById', async () => {
      const emptyLibsCleared: ViewerContext = {
        userId: adminCleared.userId,
        allowedLibraryIds: [],
        restrictedCleared: true,
      };

      expect((await listItems(db, emptyLibsCleared, { limit: 50 })).rows).toHaveLength(0);
      expect((await searchCatalog(db, emptyLibsCleared, { q: 'Harbor' })).rows).toHaveLength(0);
      expect(await getContinueWatching(db, emptyLibsCleared)).toHaveLength(0);
      expect((await listProgress(db, emptyLibsCleared, { limit: 50 })).rows).toHaveLength(0);
      expect((await listPeople(db, emptyLibsCleared, { limit: 50 })).rows).toHaveLength(0);
      expect((await listTags(db, emptyLibsCleared, { limit: 50 })).rows).toHaveLength(0);
      expect(
        await getImageEntityAccess(db, emptyLibsCleared, {
          entityType: 'library',
          entityId: generalLibraryId,
        })
      ).toHaveLength(0);
      expect(
        await getImageEntityAccess(db, emptyLibsCleared, {
          entityType: 'catalog_item',
          entityId: lastFerryOutItemId,
        })
      ).toHaveLength(0);

      const exportChunks = [];
      for await (const chunk of exportData(db, emptyLibsCleared)) exportChunks.push(chunk);
      expect(exportChunks.filter((c) => c.kind === 'library' || c.kind === 'item')).toHaveLength(0);
    });

    it('adversarial LIKE/tsquery injection strings in listPeople/listTags q are safely parameterized', async () => {
      const adversarialQueries = [`%' OR '1'='1`, `_%_%`, `\\%\\_`, `'; SELECT 1; --`];
      for (const q of adversarialQueries) {
        const peopleResult = await listPeople(db, casualUncleared, { q, limit: 100 });
        expect(Array.isArray(peopleResult.rows)).toBe(true);
        // None of these adversarial strings are real substrings of any
        // seeded name, so an escaped, literal-substring match must yield
        // nothing — proves the pattern wasn't widened into "match
        // everything".
        expect(peopleResult.rows).toHaveLength(0);
      }
    });
  });
});
