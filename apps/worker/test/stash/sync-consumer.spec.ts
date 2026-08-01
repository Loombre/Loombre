// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/sync-consumer.spec.ts
//
// Live-DB + real-SQLite-fixture tests for the 'stash-sync' job engine
// (STATE.md S8, apps/worker/src/stash/sync-consumer.ts). Covers:
//   - full sync happy path: scenes matched by path, applied via an
//     injected fake (recording calls, since Lane B's real apply.ts is
//     out of this lane's scope — K11), report row + stash.sync.started/
//     completed events, checkpoint cleaned up on success.
//   - checkpoint resume: a fake apply that throws on the SECOND scene
//     leaves a partial checkpoint; a retry under the SAME job.id resumes
//     past the already-applied scene (proven via the fake's call count)
//     and reaches a real 'succeeded' report.
//   - staleness (S8): a scene vanishing from Stash between two full syncs
//     gets stale=TRUE, KEPT (link row + item survive); reappearing flips
//     it back FALSE.
//   - incremental: only new/changed scenes are touched — exact count
//     assertion (the deliverable's "12 changed of 33k touches 12" proof
//     at small scale; the 33k proof itself is scripts/stash-scale-proof.mjs).
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// FX4 fix wave: forces S2's snapshot-copy fallback the same way apps/
// worker/test/stash/adapter.spec.ts's makeLockedFixture does — locking_mode
// EXCLUSIVE + an uncommitted BEGIN IMMEDIATE transaction on the fixture's
// own OWNER handle, held open past the direct-open tier's retry budget.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createDb,
  getLatestStashSyncReport,
  getRestrictedSceneDetail,
  getStashSceneLinkCounts,
  listRestrictedBrowse,
  listStashSceneLinksForLibrary,
  replaceLibraryPathMappings,
  upsertLibraryStashConnectionConfig,
} from "@loombre/db";
import { getStashSyncCheckpoint } from "@loombre/db/internal";
import { runStashSync, type StashSyncConsumerDeps } from "../../src/stash/sync-consumer.js";
import { applyStashSceneMetadata } from "../../src/stash/apply.js";
import type { ApplyStashSceneMetadataFn } from "../../src/stash/apply-types.js";
import { buildSyncFixtureDb, type FixtureScene } from "./sync-fixtures/build-sync-fixture.js";
import { buildFixtureDb } from "./fixtures/build-fixture-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DB_ROOT = path.resolve(__dirname, "../../../../packages/db");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_DB_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: ReturnType<typeof createDb>;
let mediaDir: string;

beforeAll(async () => {
  run(path.join(PKG_DB_ROOT, "scripts", "migrate.mjs"), ["reset"]);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

afterEach(() => {
  if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
});

async function makeLibrary(): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto("libraries")
    .values({ name: `sync-lib-${randomUUID()}`, media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makeCatalogItemWithFile(libraryId: string, filePath: string, sizeBytes: number): Promise<string> {
  const now = Date.now();
  const item = await db
    .insertInto("catalog_items")
    .values({ library_id: libraryId, item_type: "movie", title: `item-${randomUUID()}`, sort_title: "item", added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db.insertInto("media_files").values({ item_id: item.id, path: filePath, size_bytes: sizeBytes }).execute();
  writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x41));
  return item.id;
}

function fakeApply(overrides: Partial<{ changed: boolean; throwOnCallNumber: number }> = {}): { fn: ApplyStashSceneMetadataFn; calls: string[] } {
  const calls: string[] = [];
  let callCount = 0;
  const fn: ApplyStashSceneMetadataFn = async (_trx, _deps, input) => {
    callCount++;
    if (overrides.throwOnCallNumber !== undefined && callCount === overrides.throwOnCallNumber) {
      throw new Error(`fakeApply: simulated failure on call ${callCount}`);
    }
    calls.push(input.stashSceneId);
    return { changedFields: (overrides.changed ?? true) ? ["title"] : [] };
  };
  return { fn, calls };
}

function baseDeps(applyFn: ApplyStashSceneMetadataFn, overrides: Partial<StashSyncConsumerDeps> = {}): StashSyncConsumerDeps {
  return {
    db,
    applyStashSceneMetadata: applyFn,
    enqueueImageJob: async () => undefined,
    checkpointIntervalScenes: 1,
    ...overrides,
  };
}

async function setupLibraryWithMappedFixture(scenes: FixtureScene[]): Promise<{ libraryId: string; dbPath: string; fixtureDir: string }> {
  const libraryId = await makeLibrary();
  mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-sync-media-"));
  const fixture = buildSyncFixtureDb(scenes);
  fixture.db.close();

  await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: fixture.dbPath, nowMs: Date.now() });
  await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);

  for (const scene of scenes) {
    await makeCatalogItemWithFile(libraryId, path.join(mediaDir, scene.basename), scene.sizeBytes);
  }

  return { libraryId, dbPath: fixture.dbPath, fixtureDir: fixture.dir };
}

describe("stash-sync — S2 fs-level proof across the WHOLE sync path (R2 audit)", () => {
  // adapter.spec.ts proves the ADAPTER SESSION never writes the source.
  // That is not the same statement as "a sync never writes the source":
  // between opening and closing the connection, a real run also executes
  // the inventory pass, the two matching passes, and one applyStashSceneMetadata
  // per matched scene, every one of which holds the same live SQLite handle.
  // This closes that gap by asserting the source file's bytes AND mtime
  // across a complete runStashSync with the REAL mapper, not a fake.
  it("a full sync (inventory + matching + real apply) leaves the Stash .db byte-identical, mtime included", async () => {
    const scenes: FixtureScene[] = [
      { id: 1, title: "FS Proof One", folderPath: "/stash-media", basename: "fs-one.mp4", sizeBytes: 1000, updatedAt: "2023-06-15 10:00:00" },
      { id: 2, title: "FS Proof Two", folderPath: "/stash-media", basename: "fs-two.mp4", sizeBytes: 2000, updatedAt: "2023-06-16 10:00:00" },
    ];
    const libraryId = await makeLibrary();
    mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-sync-media-"));
    const fixture = buildSyncFixtureDb(scenes);
    // WAL mode, like every real Stash database — the shape that makes this
    // assertion non-trivial (a rollback-journal database has no sidecar
    // machinery to confuse the question).
    fixture.db.exec("PRAGMA journal_mode=WAL;");
    fixture.db.close();

    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: fixture.dbPath, nowMs: Date.now() });
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);
    for (const scene of scenes) await makeCatalogItemWithFile(libraryId, path.join(mediaDir, scene.basename), scene.sizeBytes);

    const hashBefore = createHash("sha256").update(readFileSync(fixture.dbPath)).digest("hex");
    const mtimeBefore = statSync(fixture.dbPath).mtimeMs;

    const result = await runStashSync(
      baseDeps(applyStashSceneMetadata, { enqueueImageJob: vi.fn(async () => "job-id") }),
      { libraryId, mode: "full" },
      { jobId: randomUUID() }
    );
    expect(result.counts).toMatchObject({ matched: 2, updated: 2 }); // the run really did work

    expect(createHash("sha256").update(readFileSync(fixture.dbPath)).digest("hex")).toBe(hashBefore);
    expect(statSync(fixture.dbPath).mtimeMs).toBe(mtimeBefore);

    // Scope stated honestly (adapter.ts's header): the DIRECTORY does gain
    // SQLite's WAL sidecars, which a read-only connection cannot remove.
    // Nothing else appears, and nothing pre-existing is removed.
    const dirNow = readdirSync(fixture.dir).sort();
    expect(dirNow.filter((f) => !f.endsWith("-wal") && !f.endsWith("-shm"))).toEqual(["stash.sqlite"]);

    rmSync(fixture.dir, { recursive: true, force: true });
  }, 20_000);
});

describe("stash-sync full mode — happy path", () => {
  it("matches, applies via the injected fake, and writes a succeeded report + events", async () => {
    const scenes: FixtureScene[] = [
      { id: 1, title: "Scene One", folderPath: "/stash-media", basename: "scene-one.mp4", sizeBytes: 1000, updatedAt: "2023-06-15 10:00:00" },
      { id: 2, title: "Scene Two", folderPath: "/stash-media", basename: "scene-two.mp4", sizeBytes: 2000, updatedAt: "2023-06-16 10:00:00" },
    ];
    const { libraryId } = await setupLibraryWithMappedFixture(scenes);
    const { fn, calls } = fakeApply();
    const jobId = randomUUID();

    const result = await runStashSync(baseDeps(fn), { libraryId, mode: "full" }, { jobId });

    expect(calls.sort()).toEqual(["1", "2"]);
    expect(result.touchedCount).toBe(2);
    expect(result.counts).toMatchObject({ matched: 2, updated: 2, unmatched: 0, stale: 0, skipped: 0 });

    const report = await getLatestStashSyncReport(db, libraryId);
    expect(report?.status).toBe("succeeded");
    expect(report?.matched_count).toBe(2);
    expect(report?.updated_count).toBe(2);
    expect(report?.finished_at_ms).not.toBeNull();

    // Checkpoint is cleaned up on success (deliverable 2's own writer/
    // reader precedent — nothing left to resume once the run is done).
    expect(await getStashSyncCheckpoint(db, jobId)).toBeUndefined();
  });

  it("a scene whose applyStashSceneMetadata reports changed:false counts as skipped, not updated", async () => {
    const scenes: FixtureScene[] = [{ id: 10, title: "Unchanged Scene", folderPath: "/stash-media", basename: "unchanged.mp4", sizeBytes: 500, updatedAt: "2023-06-15 10:00:00" }];
    const { libraryId } = await setupLibraryWithMappedFixture(scenes);
    const { fn } = fakeApply({ changed: false });

    const result = await runStashSync(baseDeps(fn), { libraryId, mode: "full" }, { jobId: randomUUID() });
    expect(result.counts.updated).toBe(0);
    expect(result.counts.skipped).toBe(1);
  });
});

// ============================================================================
// S3 "both ways", at the level S3 actually promises (R2 audit)
// ============================================================================
// connect.spec.ts proves the supported/unsupported CONNECT outcomes, and
// read-model.spec.ts proves typed reads against both pinned boundary
// fixtures. Neither proves the thing S3's pinned range is FOR: that a
// database at either end of 67-85 syncs end to end through the real
// mapper. The two suites below close that, and add the third S3 case
// nobody covered — an IN-RANGE version whose tables are not the shape the
// read model expects, which must fail loudly rather than best-effort.

const BOUNDARY_FIXTURES = [
  ["schema-v67-supported-min.sql", 67],
  ["schema-v85-supported-max.sql", 85],
] as const;

describe.each(BOUNDARY_FIXTURES)("stash-sync end to end against the pinned range boundary %s (S3)", (fixtureFile, version) => {
  it(`syncs a schema-v${version} database through the REAL mapper: matched, editorial fields written, technical facts untouched`, async () => {
    const libraryId = await makeLibrary();
    mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-boundary-media-"));
    mkdirSync(path.join(mediaDir, "sub"), { recursive: true });

    const fixtureDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-boundary-fixture-"));
    const sqlitePath = path.join(fixtureDir, "stash.sqlite");
    buildFixtureDb(path.join(__dirname, "fixtures", fixtureFile), sqlitePath).close();

    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath, nowMs: Date.now() });
    // The checked-in fixtures put their files under /data/videos (scene 2
    // in a nested subfolder — the path-reconstruction case read-model.ts
    // handles without a version branch).
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/data/videos", loombrePrefix: mediaDir }]);
    const sceneOneItem = await makeCatalogItemWithFile(libraryId, path.join(mediaDir, "scene-one.mp4"), 1024);
    await db.updateTable("media_files").set({ size_bytes: 104_857_600 }).where("item_id", "=", sceneOneItem).execute();
    const sceneTwoItem = await makeCatalogItemWithFile(libraryId, path.join(mediaDir, "sub", "scene-two.mkv"), 1024);
    await db.updateTable("media_files").set({ size_bytes: 52_428_800 }).where("item_id", "=", sceneTwoItem).execute();
    // A probed technical fact that predates the sync — S5's authority split
    // says the Stash path must leave it exactly as it found it.
    await db.insertInto("movie_details").values({ item_id: sceneOneItem, runtime_ms: 5_400_000, content_rating: "R", tagline: "probed", overview: null }).execute();

    const enqueueImageJob = vi.fn(async () => "job-id");
    const result = await runStashSync(
      baseDeps(applyStashSceneMetadata, { enqueueImageJob }),
      { libraryId, mode: "full" },
      { jobId: randomUUID() }
    );

    expect(result.touchedCount).toBe(2);
    expect(result.counts).toMatchObject({ matched: 2, updated: 2, unmatched: 0, stale: 0 });

    const item = await db.selectFrom("catalog_items").selectAll().where("id", "=", sceneOneItem).executeTakeFirstOrThrow();
    expect(item.title).toBe("Scene One");
    expect(item.year).toBe(2023);
    expect(item.community_rating).toBeCloseTo(8.5); // S5's documented rating100/10 conversion

    const details = await db.selectFrom("movie_details").selectAll().where("item_id", "=", sceneOneItem).executeTakeFirstOrThrow();
    expect(details.overview).toBe("Details for scene one.");
    expect(details.premiere_at_ms).toBe(Date.parse("2023-06-15"));
    // S5 technical/editorial split, proven through the WHOLE sync path
    // rather than only at apply.ts's unit boundary.
    expect(details.runtime_ms).toBe(5_400_000);
    expect(details.content_rating).toBe("R");
    expect(details.tagline).toBe("probed");

    const people = await db
      .selectFrom("item_people")
      .innerJoin("people", "people.id", "item_people.person_id")
      .select("people.name as name")
      .where("item_people.item_id", "=", sceneOneItem)
      .execute();
    expect(people.map((p) => p.name).sort()).toEqual(["Jane Doe", "John Smith"]);

    const chapters = await db.selectFrom("chapter_markers").selectAll().where("item_id", "=", sceneOneItem).execute();
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.start_ms).toBe(30_500); // K9: Stash's REAL seconds -> BIGINT ms

    // The studio ancestor walk C performs before calling apply (the B/C
    // seam) really ran for this fixture, not just in apply.spec.ts's
    // hand-built bundles.
    const studioEdge = await db
      .selectFrom("item_tags")
      .innerJoin("tags", "tags.id", "item_tags.tag_id")
      .select("tags.name as name")
      .where("item_tags.item_id", "=", sceneOneItem)
      .where("item_tags.kind", "=", "studio")
      .executeTakeFirstOrThrow();
    expect(studioEdge.name).toBe("Acme Studios");

    const links = await listStashSceneLinksForLibrary(db, libraryId);
    expect(links.map((l) => l.matched_by).sort()).toEqual(["path", "path"]);

    rmSync(fixtureDir, { recursive: true, force: true });
  }, 20_000);
});

describe("stash-sync — an IN-RANGE schema version with a mangled table fails loudly (S3: never best-effort)", () => {
  it("schema_migrations says 85 but `scenes` is missing a column the read model needs — the run throws, never half-applies", async () => {
    const libraryId = await makeLibrary();
    mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-mangled-media-"));
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-mangled-fixture-"));
    const sqlitePath = path.join(fixtureDir, "stash.sqlite");

    // A database that passes the version guard (85 IS in range) but whose
    // `scenes` table has lost `rating` — the shape a hand-edited/partially
    // migrated/foreign database can genuinely have. S3's rule is that
    // Loombre must not shrug and map whatever it can find.
    const mangled = new DatabaseSync(sqlitePath);
    mangled.exec(`
      CREATE TABLE schema_migrations (version uint64, dirty bool);
      INSERT INTO schema_migrations (version, dirty) VALUES (85, 0);
      CREATE TABLE folders (id INTEGER PRIMARY KEY, path TEXT, parent_folder_id INTEGER, mod_time DATETIME, created_at DATETIME, updated_at DATETIME);
      CREATE TABLE files (id INTEGER PRIMARY KEY, basename TEXT, parent_folder_id INTEGER, size INTEGER, mod_time DATETIME, created_at DATETIME, updated_at DATETIME);
      CREATE TABLE files_fingerprints (file_id INTEGER, type TEXT, fingerprint TEXT);
      CREATE TABLE scenes_files (scene_id INTEGER, file_id INTEGER, "primary" BOOLEAN);
      -- no "rating" column, which read-model.ts's getScene selects by name
      CREATE TABLE scenes (id INTEGER PRIMARY KEY, title TEXT, details TEXT, date DATE, studio_id INTEGER, code TEXT, director TEXT, organized BOOLEAN, cover_blob TEXT, created_at DATETIME, updated_at DATETIME);
      INSERT INTO folders (id, path, parent_folder_id, mod_time, created_at, updated_at) VALUES (1, '/stash-media', NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00', '2023-01-01 00:00:00');
      INSERT INTO files (id, basename, parent_folder_id, size, mod_time, created_at, updated_at) VALUES (1, 'mangled.mp4', 1, 100, '2023-01-01 00:00:00', '2023-01-01 00:00:00', '2023-01-01 00:00:00');
      INSERT INTO scenes (id, title, details, date, studio_id, code, director, organized, cover_blob, created_at, updated_at) VALUES (1, 'Mangled', NULL, NULL, NULL, NULL, NULL, 0, NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
      INSERT INTO scenes_files (scene_id, file_id, "primary") VALUES (1, 1, 1);
    `);
    mangled.close();

    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath, nowMs: Date.now() });
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);
    const itemId = await makeCatalogItemWithFile(libraryId, path.join(mediaDir, "mangled.mp4"), 100);

    // Inventory + matching survive (they never read `rating`), so the run
    // gets far enough to be dangerous — and then refuses, rather than
    // applying a scene with a silently-missing field.
    await expect(runStashSync(baseDeps(applyStashSceneMetadata), { libraryId, mode: "full" }, { jobId: randomUUID() })).rejects.toThrow(
      /no such column: rating/i
    );

    // Nothing partially written for the scene it could not honestly read.
    const item = await db.selectFrom("catalog_items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
    expect(item.title).not.toBe("Mangled");
    expect(await db.selectFrom("movie_details").selectAll().where("item_id", "=", itemId).execute()).toEqual([]);

    // The report stays 'running' — the terminal-failure hook (pg-boss
    // retries exhausted) is what finalizes it 'failed', never this handler.
    const report = await getLatestStashSyncReport(db, libraryId);
    expect(report?.status).toBe("running");

    rmSync(fixtureDir, { recursive: true, force: true });
  }, 20_000);
});

describe("stash-sync — checkpoint resume (same job.id)", () => {
  it("a crash mid-apply leaves a resumable checkpoint; a retry under the same job.id skips already-applied scenes", async () => {
    const scenes: FixtureScene[] = [
      { id: 1, title: "First", folderPath: "/stash-media", basename: "first.mp4", sizeBytes: 100, updatedAt: "2023-01-01 00:00:00" },
      { id: 2, title: "Second", folderPath: "/stash-media", basename: "second.mp4", sizeBytes: 200, updatedAt: "2023-01-02 00:00:00" },
      { id: 3, title: "Third", folderPath: "/stash-media", basename: "third.mp4", sizeBytes: 300, updatedAt: "2023-01-03 00:00:00" },
    ];
    const { libraryId } = await setupLibraryWithMappedFixture(scenes);
    const jobId = randomUUID();

    // Attempt 1: fails on the SECOND scene applied (scenes are processed
    // in read-model's own id-ascending order: 1, 2, 3).
    const failing = fakeApply({ throwOnCallNumber: 2 });
    await expect(runStashSync(baseDeps(failing.fn), { libraryId, mode: "full" }, { jobId })).rejects.toThrow(/simulated failure/);
    expect(failing.calls).toEqual(["1"]); // scene 1 committed before the throw on scene 2

    const checkpointAfterCrash = await getStashSyncCheckpoint(db, jobId);
    expect(checkpointAfterCrash?.phase).toBe("applying");
    expect(checkpointAfterCrash?.scenes_processed).toBe(1);

    const reportAfterCrash = await getLatestStashSyncReport(db, libraryId);
    expect(reportAfterCrash?.status).toBe("running"); // not yet finalized — pg-boss's own retry (same job.id) is what resumes this, not a new attempt with a new report row.

    // Attempt 2: SAME job.id, a working apply — scene 1 must NOT be
    // re-applied (the resumable-checkpointing requirement: "survives
    // worker death and resumes without redoing completed work").
    const succeeding = fakeApply();
    const result = await runStashSync(baseDeps(succeeding.fn), { libraryId, mode: "full" }, { jobId });

    expect(succeeding.calls).toEqual(["2", "3"]); // scene 1 skipped on resume
    expect(result.counts.updated).toBe(2); // only scenes 2+3 counted THIS attempt
    expect(result.touchedCount).toBe(3); // inventory/matching re-ran fresh over all 3

    const finalReport = await getLatestStashSyncReport(db, libraryId);
    expect(finalReport?.status).toBe("succeeded");
    expect(finalReport?.matched_count).toBe(3); // live snapshot — all 3 are matched regardless of which attempt applied them

    expect(await getStashSyncCheckpoint(db, jobId)).toBeUndefined();
  });
});

describe("stash-sync — staleness (S8)", () => {
  it("a scene vanishing from Stash is marked stale, KEPT (never deleted), and reappearing flips it back", async () => {
    const scenes: FixtureScene[] = [
      { id: 1, title: "Stays", folderPath: "/stash-media", basename: "stays.mp4", sizeBytes: 100, updatedAt: "2023-01-01 00:00:00" },
      { id: 2, title: "Vanishes", folderPath: "/stash-media", basename: "vanishes.mp4", sizeBytes: 200, updatedAt: "2023-01-02 00:00:00" },
    ];
    const { libraryId } = await setupLibraryWithMappedFixture(scenes);
    const { fn } = fakeApply();

    await runStashSync(baseDeps(fn), { libraryId, mode: "full" }, { jobId: randomUUID() });
    const afterFirst = await listStashSceneLinksForLibrary(db, libraryId);
    expect(afterFirst.find((r) => r.stash_scene_id === "2")?.stale).toBe(false);

    // Rebuild the Stash DB WITHOUT scene 2 (same sqlite_path — a fresh
    // connect against the same configured path) and re-sync.
    const remainingOnly = buildSyncFixtureDb([scenes[0]!]);
    remainingOnly.db.close();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: remainingOnly.dbPath, nowMs: Date.now() });

    const { fn: fn2 } = fakeApply();
    const result2 = await runStashSync(baseDeps(fn2), { libraryId, mode: "full" }, { jobId: randomUUID() });
    expect(result2.touchedCount).toBe(1);

    const afterVanish = await listStashSceneLinksForLibrary(db, libraryId);
    const vanishedLink = afterVanish.find((r) => r.stash_scene_id === "2");
    expect(vanishedLink).toBeDefined(); // KEPT — never deleted
    expect(vanishedLink?.stale).toBe(true);
    expect(vanishedLink?.item_id).not.toBeNull(); // its match/item survives too

    const counts = await getStashSceneLinkCounts(db, libraryId);
    expect(counts.stale).toBe(1);
    rmSync(remainingOnly.dir, { recursive: true, force: true });

    // Reappearance: point back at a fresh both-scene fixture and sync
    // again — stale flips back to false (Lane A's
    // upsertStashSceneLinksFromInventory unconditionally clears it for
    // every scene an inventory pass sees).
    const reappearFixture = buildSyncFixtureDb(scenes);
    reappearFixture.db.close();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: reappearFixture.dbPath, nowMs: Date.now() });
    const { fn: fn3 } = fakeApply();
    await runStashSync(baseDeps(fn3), { libraryId, mode: "full" }, { jobId: randomUUID() });
    const afterReappear = await listStashSceneLinksForLibrary(db, libraryId);
    expect(afterReappear.find((r) => r.stash_scene_id === "2")?.stale).toBe(false);
  });

  // R2 audit: the case above proves the LINK ROW survives. S8's actual
  // promise is bigger — "metadata marked STALE (kept, provenance-flagged,
  // admin-filterable) — never destructive" — and the metadata is spread
  // across eight tables the link row says nothing about. A regression that
  // cascaded a delete from any of them would have passed the test above.
  it("everything a vanished scene's item owns survives: satellite, tag/people edges, chapters, images, attributes, provenance", async () => {
    const scenes: FixtureScene[] = [
      { id: 1, title: "Stays", folderPath: "/stash-media", basename: "keeps.mp4", sizeBytes: 100, updatedAt: "2023-01-01 00:00:00" },
      { id: 2, title: "Vanishes", folderPath: "/stash-media", basename: "goes.mp4", sizeBytes: 200, updatedAt: "2023-01-02 00:00:00" },
    ];
    const libraryId = await makeLibrary();
    mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-sync-media-"));
    const rich = buildSyncFixtureDb(scenes);
    // buildSyncFixtureDb ships scenes only (its own doc comment: "tests
    // that need those insert them directly against the returned db
    // handle") — the vanishing scene needs a studio, a genre/tag pair, a
    // performer and a marker, or the survival assertions below would be
    // measuring an empty graph.
    rich.db.exec(`
      INSERT INTO studios (id, name, parent_id, details, rating, image_blob, created_at, updated_at) VALUES (1, 'Vanishing Studio', NULL, NULL, NULL, NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
      INSERT INTO tags (id, name, description, image_blob, created_at, updated_at) VALUES (1, 'Root Genre', NULL, NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
      INSERT INTO tags (id, name, description, image_blob, created_at, updated_at) VALUES (2, 'Child Tag', NULL, NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
      INSERT INTO tags_relations (parent_id, child_id) VALUES (1, 2);
      INSERT INTO performers (id, name, disambiguation, gender, birthdate, country, measurements, details, rating, image_blob, created_at, updated_at) VALUES (1, 'Vanishing Performer', NULL, 'FEMALE', '1990-01-01', 'USA', NULL, NULL, NULL, NULL, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
      UPDATE scenes SET studio_id = 1, details = 'Editorial detail', date = '2023-02-03', rating = 70 WHERE id = 2;
      INSERT INTO scenes_tags (scene_id, tag_id) VALUES (2, 1);
      INSERT INTO scenes_tags (scene_id, tag_id) VALUES (2, 2);
      INSERT INTO performers_scenes (performer_id, scene_id) VALUES (1, 2);
      INSERT INTO scene_markers (title, seconds, end_seconds, primary_tag_id, scene_id, created_at, updated_at) VALUES ('Vanishing Marker', 12.5, NULL, 2, 2, '2023-01-01 00:00:00', '2023-01-01 00:00:00');
    `);
    rich.db.close();

    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: rich.dbPath, nowMs: Date.now() });
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);
    for (const scene of scenes) await makeCatalogItemWithFile(libraryId, path.join(mediaDir, scene.basename), scene.sizeBytes);

    // A real apply, so the item genuinely acquires the full satellite
    // graph rather than a hand-planted row or two.
    await runStashSync(
      baseDeps(applyStashSceneMetadata, { enqueueImageJob: vi.fn(async () => "job-id") }),
      { libraryId, mode: "full" },
      { jobId: randomUUID() }
    );

    const vanishingItemId = (await listStashSceneLinksForLibrary(db, libraryId)).find((r) => r.stash_scene_id === "2")!.item_id!;
    expect(vanishingItemId).not.toBeNull();

    // Stand in for the image-job pipeline's own output (apply only
    // ENQUEUES; the images row is written by the image consumer) so the
    // "ingested artwork survives staleness" half is actually covered.
    await db
      .insertInto("images")
      .values({ entity_type: "catalog_item", entity_id: vanishingItemId, kind: "poster", source: "provider", width: null, height: null, file_path: "/data/poster.jpg", created_at_ms: Date.now() })
      .execute();

    async function snapshotItemGraph(itemId: string) {
      const [item, satellite, tags, people, chapters, images, attrs, provenance, files] = await Promise.all([
        db.selectFrom("catalog_items").selectAll().where("id", "=", itemId).executeTakeFirst(),
        db.selectFrom("movie_details").selectAll().where("item_id", "=", itemId).executeTakeFirst(),
        db.selectFrom("item_tags").selectAll().where("item_id", "=", itemId).execute(),
        db.selectFrom("item_people").selectAll().where("item_id", "=", itemId).execute(),
        db.selectFrom("chapter_markers").selectAll().where("item_id", "=", itemId).execute(),
        db.selectFrom("images").selectAll().where("entity_type", "=", "catalog_item").where("entity_id", "=", itemId).execute(),
        db.selectFrom("item_attributes").selectAll().where("item_id", "=", itemId).execute(),
        db.selectFrom("metadata_provenance").selectAll().where("item_id", "=", itemId).execute(),
        db.selectFrom("media_files").selectAll().where("item_id", "=", itemId).execute(),
      ]);
      return { item, satellite, tags, people, chapters, images, attrs, provenance, files };
    }

    const before = await snapshotItemGraph(vanishingItemId);
    // Guard the guard: an all-empty "before" would make every assertion
    // below vacuously true.
    expect(before.item).toBeDefined();
    expect(before.satellite).toBeDefined();
    expect(before.tags.length + before.people.length).toBeGreaterThan(0);
    expect(before.attrs.length).toBeGreaterThan(0);
    expect(before.provenance.length).toBeGreaterThan(0);
    expect(before.images).toHaveLength(1);
    expect(before.files).toHaveLength(1);

    // Scene 2 disappears from Stash entirely.
    const remainingOnly = buildSyncFixtureDb([scenes[0]!]);
    remainingOnly.db.close();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: remainingOnly.dbPath, nowMs: Date.now() });
    await runStashSync(
      baseDeps(applyStashSceneMetadata, { enqueueImageJob: vi.fn(async () => "job-id") }),
      { libraryId, mode: "full" },
      { jobId: randomUUID() }
    );

    const link = (await listStashSceneLinksForLibrary(db, libraryId)).find((r) => r.stash_scene_id === "2");
    expect(link?.stale).toBe(true);
    expect(link?.item_id).toBe(vanishingItemId); // the match itself is kept, not cleared

    const after = await snapshotItemGraph(vanishingItemId);
    expect(after.item).toEqual(before.item);
    expect(after.satellite).toEqual(before.satellite);
    expect(after.tags).toEqual(before.tags);
    expect(after.people).toEqual(before.people);
    expect(after.chapters).toEqual(before.chapters);
    expect(after.images).toEqual(before.images);
    expect(after.attrs).toEqual(before.attrs);
    expect(after.provenance).toEqual(before.provenance);
    expect(after.files).toEqual(before.files);

    rmSync(remainingOnly.dir, { recursive: true, force: true });
    rmSync(rich.dir, { recursive: true, force: true });
  }, 30_000);

  it("a stale scene's item stays fully visible to a cleared viewer — flagged, never hidden from the zone", async () => {
    // The brief's wording is "kept, flagged, filterable — never hidden".
    // Staleness lives on stash_scene_links, which no zone query reads, so
    // this holds BY CONSTRUCTION — and a construction nobody tests is one
    // a future "hide stale items" convenience could quietly break.
    const scenes: FixtureScene[] = [
      { id: 1, title: "Zone Survivor", folderPath: "/stash-media", basename: "survivor.mp4", sizeBytes: 100, updatedAt: "2023-01-01 00:00:00" },
    ];
    const { libraryId } = await setupLibraryWithMappedFixture(scenes);
    // The zone's guard keys off catalog_items.content_class, which the
    // scanner sets from the library and this suite's minimal helper does
    // not — make it match what a real restricted-library scan produces.
    await db.updateTable("catalog_items").set({ content_class: "restricted" }).where("library_id", "=", libraryId).execute();
    await runStashSync(
      baseDeps(applyStashSceneMetadata, { enqueueImageJob: vi.fn(async () => "job-id") }),
      { libraryId, mode: "full" },
      { jobId: randomUUID() }
    );
    const itemId = (await listStashSceneLinksForLibrary(db, libraryId))[0]!.item_id!;

    // A fully cleared viewer entitled to this library: gates 1-4 via
    // allowedLibraryIds, gate 5 via restrictedCleared (ViewerContext is a
    // plain value object — no users row is needed to exercise the guard).
    const ctx = { userId: randomUUID(), allowedLibraryIds: [libraryId], restrictedCleared: true };

    const beforeStale = await listRestrictedBrowse(db, ctx, {});
    expect(beforeStale?.rows.map((r) => r.id)).toContain(itemId);

    // Vanish it from Stash.
    const emptyFixture = buildSyncFixtureDb([]);
    emptyFixture.db.close();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: emptyFixture.dbPath, nowMs: Date.now() });
    await runStashSync(baseDeps(fakeApply().fn), { libraryId, mode: "full" }, { jobId: randomUUID() });
    expect((await listStashSceneLinksForLibrary(db, libraryId))[0]!.stale).toBe(true);

    const afterStale = await listRestrictedBrowse(db, ctx, {});
    expect(afterStale?.rows.map((r) => r.id)).toContain(itemId);
    const detail = await getRestrictedSceneDetail(db, ctx, itemId);
    expect(detail?.id).toBe(itemId); // still openable, still playable

    rmSync(emptyFixture.dir, { recursive: true, force: true });
  }, 30_000);
});

describe("stash-sync — incremental mode touches only new/changed scenes", () => {
  it("count-verified: N changed of M total touches exactly N", async () => {
    const TOTAL = 15;
    const CHANGED = 4;
    const baseTime = "2023-01-01 00:00:00";
    const scenes: FixtureScene[] = Array.from({ length: TOTAL }, (_, i) => ({
      id: i + 1,
      title: `Scene ${i + 1}`,
      folderPath: "/stash-media",
      basename: `scene-${i + 1}.mp4`,
      sizeBytes: 100 + i,
      updatedAt: baseTime,
    }));
    const { libraryId } = await setupLibraryWithMappedFixture(scenes);

    // Baseline full sync establishes stash_scene_links.stash_updated_at_ms
    // for every scene.
    await runStashSync(baseDeps(fakeApply().fn), { libraryId, mode: "full" }, { jobId: randomUUID() });

    // Rebuild the fixture with exactly CHANGED scenes carrying a NEWER
    // updated_at (the rest byte-identical) — the incremental diff's
    // "changed" set per S8.
    const changedScenes = scenes.map((s, i) => (i < CHANGED ? { ...s, updatedAt: "2023-06-01 00:00:00" } : s));
    const updatedFixture = buildSyncFixtureDb(changedScenes);
    updatedFixture.db.close();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: updatedFixture.dbPath, nowMs: Date.now() });

    const { fn, calls } = fakeApply();
    const result = await runStashSync(baseDeps(fn), { libraryId, mode: "incremental" }, { jobId: randomUUID() });

    expect(result.touchedCount).toBe(CHANGED);
    expect(calls).toHaveLength(CHANGED);
    expect(calls.sort()).toEqual(changedScenes.slice(0, CHANGED).map((s) => String(s.id)).sort());

    rmSync(updatedFixture.dir, { recursive: true, force: true });
  });
});

describe("stash-sync — S2 snapshot-copy fallback surfaces (FX4 fix wave)", () => {
  it("a sync forced through the snapshot path records it in the stash.sync.completed event AND the report row", async () => {
    const scenes: FixtureScene[] = [
      { id: 1, title: "Locked Scene", folderPath: "/stash-media", basename: "locked.mp4", sizeBytes: 100, updatedAt: "2023-01-01 00:00:00" },
    ];
    const libraryId = await makeLibrary();
    mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-sync-media-"));
    const fixture = buildSyncFixtureDb(scenes);

    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: fixture.dbPath, nowMs: Date.now() });
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);
    await makeCatalogItemWithFile(libraryId, path.join(mediaDir, "locked.mp4"), 100);

    // Force the fixture's OWN open handle (buildSyncFixtureDb returns one
    // read-write handle; every other test in this file closes it right
    // away — this one instead holds it open) into the WAL-locked state —
    // mirrors adapter.spec.ts's makeLockedFixture exactly: journal_mode
    // WAL + locking_mode EXCLUSIVE + an uncommitted BEGIN IMMEDIATE
    // transaction, which reliably forces a concurrent read-only opener
    // into SQLITE_BUSY/LOCKED (adapter.ts's own header documents why this
    // simulation, not real WAL contention, is the standard way to prove
    // this path).
    fixture.db.exec("PRAGMA journal_mode=WAL;");
    fixture.db.exec("PRAGMA locking_mode=EXCLUSIVE;");
    fixture.db.exec("BEGIN IMMEDIATE;");
    fixture.db.exec("UPDATE scenes SET title = title WHERE id = 1;");

    // Released shortly after the sync starts — same timing shape as
    // adapter.spec.ts's own fallback test (`setTimeout(() => release(),
    // 200)` before awaiting the connection). CRITICAL (matches
    // makeLockedFixture's own release() exactly): in WAL mode, EXCLUSIVE
    // locking_mode holds its lock for the connection's WHOLE SESSION, not
    // just for the open transaction — a bare COMMIT does NOT release it;
    // the connection must be CLOSED. The small direct-open retry budget
    // below exhausts well before this fires, so the direct tier reliably
    // observes the lock; the snapshot tier's own retry budget then
    // succeeds once the close() lands.
    let released = false;
    const releaseTimer = setTimeout(() => {
      released = true;
      try {
        fixture.db.exec("COMMIT;");
      } catch {
        // fine either way — close() below is what actually matters.
      }
      fixture.db.close();
    }, 150);

    const { fn } = fakeApply();
    const jobId = randomUUID();
    const result = await runStashSync(
      baseDeps(fn, {
        // FX4's own test seam (StashSyncConsumerDeps.stashOpenOptions,
        // forwarded verbatim to connectToStashLibrary/openStashConnection)
        // — small, fast retry/backoff budgets so this test proves the
        // fallback deterministically in well under a second rather than
        // waiting out adapter.ts's real multi-second production defaults.
        stashOpenOptions: { busyTimeoutMs: 20, maxDirectRetries: 1, directRetryBackoffMs: 20, maxSnapshotRetries: 20, snapshotRetryBackoffMs: 40 },
      }),
      { libraryId, mode: "full" },
      { jobId },
    );

    clearTimeout(releaseTimer);
    if (!released) fixture.db.close();

    expect(result.touchedCount).toBe(1);

    // Durable report row (migrations/0022_stash_sync_report_snapshot.sql).
    const report = await getLatestStashSyncReport(db, libraryId);
    expect(report?.used_snapshot_fallback).toBe(true);

    // stash.sync.completed event payload (packages/contract/event-schemas/
    // stash.sync.completed.schema.json's additive optional field).
    const events = await db.selectFrom("events").selectAll().where("type", "=", "stash.sync.completed").execute();
    const event = events.find((e) => (e.payload as { jobId: string }).jobId === jobId);
    expect(event).toBeDefined();
    expect((event!.payload as { usedSnapshotFallback: boolean }).usedSnapshotFallback).toBe(true);
  }, 20_000);
});
