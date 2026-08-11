// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/import/round-trip.e2e.spec.ts
//
// Phase 4 lane E, deliverable 2 (the exit bar): seed loombre_e_test (the
// standard seed, restricted fixtures included) -> export via the REAL
// GET /export HTTP endpoint (admin viewer, restricted-unlocked) -> create
// empty loombre_e_roundtrip_test -> migrate it -> import via the REAL job path
// (@loombre/jobs' createJobQueue/enqueue/work, not a bare function call) ->
// diff the captured archive against the target database (empty except for
// the documented exclusions — see ./diff-archive.ts). Also: re-import under
// merge-skip-existing -> zero duplicates, and a restricted-content leak
// check against the freshly-imported target.
//
// Lives in apps/server/test/ (not apps/worker/test/) for one reason: it
// needs BOTH a real NestJS app + supertest (apps/server's own deps, for the
// REAL HTTP export leg) AND apps/worker's real import consumer — and
// LOCKFILE FROZEN means no new workspace dependency edge can be added to
// either package's package.json to get the other's exports formally. test/
// directories are already exempted from the repo-root dependency-cruiser
// graph entirely (.dependency-cruiser.cjs's options.exclude — the same
// carve-out apps/worker/test/scan/helpers.ts's header cites for its own
// direct `pg` import), so a plain relative import of apps/worker/src's
// compiled TypeScript source, test-only, is the correct minimal-footprint
// choice — no production code anywhere imports across the apps/server <->
// apps/worker boundary; only this one test file does, deliberately.
//
// Resource isolation (this lane's ports 3700-3799, DBs loombre_e_test /
// loombre_e_roundtrip_test): both databases are created via ensureTestDatabase's
// suffix convention off the SAME base connection string every sibling
// e2e spec already uses (`<base>_e_test` / `<base>_e_roundtrip_test` — the
// "_test" tail is required by scripts/migrate.mjs's reset guard, see its
// header), never the shared `loombre` dev database. No TCP port is ever bound — supertest talks
// to `app.getHttpServer()` in-process (the same convention every other
// apps/server e2e spec already uses), so the 3700-3799 allocation is
// respected by there being no listener to place in it at all.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase, getUserByUsername, getItemById, searchCatalog, listPeople, listTags, getJobAdmin } from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import { createJobQueue } from "@loombre/jobs";
// Cross-app, test-only import — see module header.
import { runImport, type ImportResult } from "../../../worker/src/import/index.js";
import { AppModule } from "../../src/app.module.js";
import { diffArchiveAgainstTarget, type DiffArchiveLike } from "./diff-archive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function buildDeviceProfile(profileId: string) {
  return {
    profileId,
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let sourceDbUrl: string;
let targetDbUrl: string;
let targetDb: ReturnType<typeof createDb>;
let archive: DiffArchiveLike & Record<string, unknown>;
let adminId: string;

/** Runs one 'import' job through the REAL @loombre/jobs queue (real pg-boss
 *  enqueue/dequeue, real ledger transitions) against `targetDbUrl`, using
 *  `runImport` as the work handler — which is *identical* to what
 *  production wiring registers (apps/worker/src/index.ts:
 *  `queue.work('import', createImportConsumerHandler({db}))`, and
 *  createImportConsumerHandler(deps) is defined as exactly
 *  `(payload, meta) => runImport(deps, payload, meta)` — see
 *  apps/worker/src/import/consumer.ts). Registering runImport directly
 *  here is the same handler, just with its typed return value captured for
 *  assertions instead of discarded. Resolves with the job's ImportResult
 *  once the handler has actually finished (not merely enqueued).
 */
async function runImportJobForReal(
  archiveBody: unknown,
  requestedByUserId: string,
  mode?: "fail-if-not-empty" | "merge-skip-existing"
): Promise<ImportResult> {
  const queue = createJobQueue(targetDbUrl);
  let resolveDone!: (r: ImportResult) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<ImportResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  queue.work(
    "import",
    async (payload, meta) => {
      try {
        const result = await runImport({ db: targetDb }, payload, meta);
        resolveDone(result);
      } catch (err) {
        rejectDone(err);
        throw err; // still let the queue's own ledger-mirroring see the failure.
      }
    },
    { concurrency: 1 }
  );

  const jobId = await queue.enqueue("import", { archive: archiveBody, requestedByUserId, ...(mode ? { mode } : {}) });
  try {
    const result = await done;
    // Public-barrel ledger read (apps/server already depends on this for
    // its own /admin/jobs surface) — confirms the REAL queue machinery
    // (not just this test's own promise) also observed completion. `done`
    // resolves the instant runImport() returns (its transaction already
    // committed by then — the data this test cares about is durably
    // written), which races slightly ahead of packages/jobs/src/queue.ts's
    // OWN subsequent `await ledger.recordCompleted(job.id)` — so this polls
    // briefly rather than asserting on the first read.
    let ledgerRow = await getJobAdmin(targetDb, jobId);
    for (let attempt = 0; attempt < 25 && ledgerRow?.status !== "completed"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      ledgerRow = await getJobAdmin(targetDb, jobId);
    }
    expect(ledgerRow?.status).toBe("completed");
    return result;
  } finally {
    await queue.stop();
  }
}

beforeAll(async () => {
  process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
  process.env["LOOMBRE_JWT_SECRET"] = "import-round-trip-test-secret-not-for-production";

  sourceDbUrl = await ensureTestDatabase(BASE_DATABASE_URL, "e_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], sourceDbUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], sourceDbUrl);

  process.env["DATABASE_URL"] = sourceDbUrl;
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const login = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "import-round-trip-admin",
    deviceProfile: buildDeviceProfile("import-round-trip-admin"),
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const adminToken: string = login.body.accessToken;

  const unlock = await request(app.getHttpServer())
    .post("/restricted/unlock")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ pin: "0000" });
  expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);

  // ---- THE real HTTP export ----
  const exportRes = await request(app.getHttpServer()).get("/export").set("Authorization", `Bearer ${adminToken}`);
  expect(exportRes.status).toBe(200);
  archive = exportRes.body;
  expect(archive.libraries.length).toBeGreaterThan(0);
  expect(archive.items.length).toBeGreaterThan(0);
  expect(archive.users.length).toBeGreaterThanOrEqual(2); // admin sees the full admin-only user list.
  expect(archive.libraries.some((l) => l.contentClass === "restricted")).toBe(true);

  const sourceDb = createDb(sourceDbUrl);
  const adminRow = await getUserByUsername(sourceDb, "admin");
  if (!adminRow) throw new Error("seed did not create the admin user");
  adminId = adminRow.id;
  await sourceDb.destroy();

  targetDbUrl = await ensureTestDatabase(BASE_DATABASE_URL, "e_roundtrip_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], targetDbUrl);
  targetDb = createDb(targetDbUrl);
}, 60_000);

afterAll(async () => {
  await app.close();
  await targetDb?.destroy();
});

describe("import round-trip: export -> wipe -> import -> diff", () => {
  it("imports the real archive via the real job path into an empty target with zero diff", async () => {
    const result = await runImportJobForReal(archive, adminId);

    expect(result.preservedIds).toBe(true);
    expect(result.mode).toBe("fail-if-not-empty");
    expect(result.libraries.created).toBe(archive.libraries.length);
    expect(result.items.created).toBe(archive.items.length);
    expect(result.users.created + result.users.selfMatched).toBe(archive.users.length);

    const mismatches = await diffArchiveAgainstTarget(archive, targetDb, adminId);
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  }, 60_000);

  it("re-importing the SAME archive under merge-skip-existing yields zero duplicates and all-'skipped' counts", async () => {
    async function totalRowCount(): Promise<number> {
      const [libs, items, users] = await Promise.all([
        targetDb.selectFrom("libraries").select("id").execute(),
        targetDb.selectFrom("catalog_items").select("id").execute(),
        targetDb.selectFrom("users").select("id").execute(),
      ]);
      return libs.length + items.length + users.length;
    }

    const before = await totalRowCount();

    const result = await runImportJobForReal(archive, adminId, "merge-skip-existing");

    expect(result.libraries.created).toBe(0);
    expect(result.libraries.skipped).toBe(archive.libraries.length);
    expect(result.items.created).toBe(0);
    expect(result.items.skipped).toBe(archive.items.length);
    expect(result.users.created).toBe(0);

    const after = await totalRowCount();
    expect(after).toBe(before);
  }, 60_000);

  it("restricted-content leak check on the imported target: an uncleared viewer sees zero restricted traces", async () => {
    const libRows = await targetDb.selectFrom("libraries").select(["id", "content_class"]).execute();
    const generalLibraryIds = libRows.filter((r) => r.content_class === "general").map((r) => r.id);
    const restrictedLibraryIds = libRows.filter((r) => r.content_class === "restricted").map((r) => r.id);
    expect(restrictedLibraryIds.length).toBeGreaterThan(0);

    const uncleared: ViewerContext = { userId: adminId, allowedLibraryIds: generalLibraryIds, restrictedCleared: false };
    const clearedButNotGranted: ViewerContext = {
      userId: adminId,
      allowedLibraryIds: [...generalLibraryIds, ...restrictedLibraryIds],
      restrictedCleared: false,
    };
    const fullyCleared: ViewerContext = {
      userId: adminId,
      allowedLibraryIds: [...generalLibraryIds, ...restrictedLibraryIds],
      restrictedCleared: true,
    };

    const restrictedItems = archive.items.filter((i) => i["contentClass"] === "restricted");
    expect(restrictedItems.length).toBeGreaterThan(0);

    for (const item of restrictedItems) {
      expect(await getItemById(targetDb, uncleared, item.id)).toBeUndefined();
      expect(await getItemById(targetDb, clearedButNotGranted, item.id)).toBeUndefined();
    }

    // Sanity: fully cleared, the SAME items are visible again — proving the
    // negative results above are the restricted-content guard working, not
    // a broken fixture. EXCEPT: an item that owns mediaFiles is immediately
    // guard-invisible to EVERY viewer post-import, restricted-cleared or
    // not — the P1.2 missing-file placeholder state (consumer.ts's module
    // header) is a SEPARATE, orthogonal guard clause from restricted-
    // content clearance. For those, assert the raw row still exists
    // instead (proving the restricted-invisibility above really is about
    // clearance, not about the row being altogether gone).
    for (const item of restrictedItems) {
      const hasMediaFiles = ((item["mediaFiles"] as unknown[] | undefined)?.length ?? 0) > 0;
      if (hasMediaFiles) {
        expect(await getItemById(targetDb, fullyCleared, item.id)).toBeUndefined();
        const raw = await targetDb.selectFrom("catalog_items").select("id").where("id", "=", item.id).executeTakeFirst();
        expect(raw).toBeDefined();
      } else {
        expect(await getItemById(targetDb, fullyCleared, item.id)).toBeDefined();
      }
    }

    const unclearedSearch = await searchCatalog(targetDb, uncleared, { q: "Static" });
    expect(unclearedSearch.rows.every((r) => r.contentClass === "general")).toBe(true);

    const unclearedPeople = await listPeople(targetDb, uncleared, { limit: 500 });
    const unclearedTags = await listTags(targetDb, uncleared, { limit: 500 });
    expect(unclearedPeople.rows.every((p) => p.contentClass === "general")).toBe(true);
    expect(unclearedTags.rows.every((t) => t.contentClass === "general")).toBe(true);
  }, 30_000);
});

// ============================================================================
// Scale observation (STATE.md/task-spec "50k-scale memory observation" —
// deliverable 4's transaction-strategy recommendation was explicitly
// contingent on measuring this, not assuming it). Reuses loombre_e_roundtrip_test
// (already non-empty from the suite above) rather than a third database —
// merge-skip-existing mode naturally supports appending a large NEW library
// on top of already-imported data, so no truncate/reset is needed. A
// synthetic in-memory archive, not a real export: the point is to measure
// the import consumer's OWN per-item write cost at scale, independent of
// how large a real catalog happens to be.
// ============================================================================
describe("import scale observation (synthetic archive, real job path, real writes)", () => {
  it("N flat movies: linear-in-N write cost + peak heap growth, extrapolated to 50k in this lane's report", async () => {
    const SCALE_ITEM_COUNT = 3000;

    const libId = randomUUID();
    const scaleLibrary = {
      id: libId,
      name: `Scale Test ${libId}`,
      mediaKind: "movie",
      paths: [],
      contentClass: "general",
      createdAtMs: Date.now(),
    };
    const scaleItems = Array.from({ length: SCALE_ITEM_COUNT }, (_, i) => ({
      id: randomUUID(),
      libraryId: libId,
      itemType: "movie",
      title: `Scale Movie ${i}`,
      sortTitle: `Scale Movie ${i}`,
      year: 2000 + (i % 25),
      communityRating: null,
      contentClass: "general",
      addedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      contentRating: null,
      runtimeMs: 6_000_000,
      overview: null,
      tagline: null,
      genres: ["Drama"],
      people: [{ id: randomUUID(), name: "Scale Actor", role: "actor", credit: null, order: 0 }],
      mediaFiles: [{ id: randomUUID(), versionLabel: null, container: "mkv", width: null, height: null, sizeBytes: 1000, durationMs: 6_000_000 }],
    }));
    const scaleArchive = { exportedAtMs: Date.now(), users: [], libraries: [scaleLibrary], items: scaleItems, progress: [], playlists: [] };

    if (global.gc) global.gc();
    const heapBeforeBuild = process.memoryUsage().heapUsed;
    const archiveJson = JSON.parse(JSON.stringify(scaleArchive)); // mirrors the real pg-boss JSONB round-trip (serialize -> deserialize) the job payload actually undergoes.
    const heapAfterBuild = process.memoryUsage().heapUsed;

    const startedAtMs = Date.now();
    const result = await runImportJobForReal(archiveJson, adminId, "merge-skip-existing");
    const durationMs = Date.now() - startedAtMs;
    const heapAfterImport = process.memoryUsage().heapUsed;

    expect(result.items.created).toBe(SCALE_ITEM_COUNT);

    console.log(
      `[import scale observation] ${SCALE_ITEM_COUNT} items: ` +
        `archive JSON round-trip heap delta = ${((heapAfterBuild - heapBeforeBuild) / 1024 / 1024).toFixed(1)} MiB, ` +
        `import heap delta = ${((heapAfterImport - heapAfterBuild) / 1024 / 1024).toFixed(1)} MiB, ` +
        `wall time = ${durationMs} ms (${(durationMs / SCALE_ITEM_COUNT).toFixed(2)} ms/item)`
    );

    // merge-skip-existing never preserves ids (the archive's own libId is
    // NOT what landed in the target — see consumer.ts's module header), so
    // the created library is looked up by its (unique-per-run) name.
    const createdLib = await targetDb.selectFrom("libraries").select("id").where("name", "=", scaleLibrary.name).executeTakeFirstOrThrow();
    const rowCount = await targetDb.selectFrom("catalog_items").select("id").where("library_id", "=", createdLib.id).execute();
    expect(rowCount).toHaveLength(SCALE_ITEM_COUNT);
  }, 120_000);
});
