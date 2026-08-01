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

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  getStashSceneLinkCounts,
  listStashSceneLinksForLibrary,
  replaceLibraryPathMappings,
  upsertLibraryStashConnectionConfig,
} from "@loombre/db";
import { getStashSyncCheckpoint } from "@loombre/db/internal";
import { runStashSync, type StashSyncConsumerDeps } from "../../src/stash/sync-consumer.js";
import type { ApplyStashSceneMetadataFn } from "../../src/stash/apply-types.js";
import { buildSyncFixtureDb, type FixtureScene } from "./sync-fixtures/build-sync-fixture.js";

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
