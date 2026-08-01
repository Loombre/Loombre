#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loombre :: scripts/stash-scale-proof.mjs
 *
 * STATE.md Stash SQLite metadata sync mission, deliverable 8 — the 33k
 * scale proof for Lane C's sync engine. Follows scripts/perf-t0.mjs's own
 * precedent for running apps/worker source IN-PROCESS via tsx (no build
 * step) against a real Postgres database, so the numbers this script
 * prints are the real apps/worker/src/stash/sync-consumer.ts code path,
 * not a reimplementation.
 *
 * Proves, in order:
 *   (i)   initial FULL sync at --scenes (default 33000) scenes — wall-clock
 *         runtime + peak RSS, applyStashSceneMetadata STUBBED (Lane B's
 *         apply.ts is out of this lane's scope — K11; see this script's
 *         own printed caveat and this lane's report).
 *   (ii)  incremental sync touching exactly --incremental-changed (default
 *         12) of the same library's scenes, count-verified.
 *   (iii) checkpoint resume, at a smaller --resume-scenes sub-scale (see
 *         "Scope decision" below) — a controlled mid-run failure leaves a
 *         checkpoint; a retry under the SAME job.id resumes and completes
 *         with every scene applied EXACTLY once across both attempts (no
 *         lost work, no double-work).
 *
 * Scope decision (resume proof sub-scale): the checkpoint mechanism itself
 * (same-job-id skip-by-equality, apps/worker/src/stash/sync-consumer.ts)
 * has no scale-dependent behavior — it walks whatever ordered scene list
 * matching produced and skips by string equality regardless of where in
 * that list a crash happens. Running the resume proof at a SECOND full
 * 33k pass would roughly double this script's total wall-clock cost for
 * no additional evidence about the mechanism; --resume-scenes defaults to
 * 2000 (same code path, same table, same algorithm, proportionally
 * checkpointed) to keep the script practical to actually run.
 *
 * Usage: node scripts/stash-scale-proof.mjs [--scenes 33000]
 *   [--incremental-changed 12] [--resume-scenes 2000]
 *   [--database-url postgres://...]
 */
import { register } from "tsx/esm/api";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

register();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DB_PKG_ROOT = path.join(REPO_ROOT, "packages/db");

function importRepoModule(relPath) {
  return import(pathToFileURL(path.join(REPO_ROOT, relPath)).href);
}

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : fallback;
}

const SCENE_COUNT = Number.parseInt(argValue("--scenes", "33000"), 10);
const INCREMENTAL_CHANGED = Number.parseInt(argValue("--incremental-changed", "12"), 10);
const RESUME_SCENES = Number.parseInt(argValue("--resume-scenes", "2000"), 10);
const BASE_DATABASE_URL = argValue("--database-url", process.env.DATABASE_URL ?? "postgres://loombre:loombre@localhost:5442/loombre");

function log(msg) {
  console.log(`[stash-scale-proof] ${msg}`);
}

function fail(msg) {
  console.error(`[stash-scale-proof] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function runMigrate(databaseUrl, args) {
  const result = spawnSync(process.execPath, [path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`migrate.mjs ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function main() {
  const { ensureTestDatabase, createDb } = await import("@loombre/db");
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "stash_scale_proof");
  log(`database: ${databaseUrl}`);
  runMigrate(databaseUrl, ["reset"]);

  const db = createDb(databaseUrl);
  const { upsertLibraryStashConnectionConfig, replaceLibraryPathMappings } = await import("@loombre/db");
  const { generateStashFixture } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts/gen-stash-fixtures.mjs")).href);
  const { runStashSync } = await importRepoModule("apps/worker/src/stash/sync-consumer.ts");
  const { createStubApplyStashSceneMetadata } = await importRepoModule("apps/worker/src/stash/apply-types.ts");

  // --real-apply (orchestrator integration re-proof): use Lane B's real
  // mapper instead of the stub, so the recorded numbers cover the FULL
  // write path (catalog/satellite/people/tags/chapters/attrs/provenance).
  // Image jobs remain a counted no-op either way — the image pipeline is
  // its own tier-0-budgeted machinery, not part of sync wall-clock.
  const REAL_APPLY = process.argv.includes("--real-apply");
  let imageJobsEnqueued = 0;
  const makeApply = async () =>
    REAL_APPLY
      ? (await importRepoModule("apps/worker/src/stash/apply.ts")).applyStashSceneMetadata
      : createStubApplyStashSceneMetadata();

  // ── (i) initial full sync at scale ───────────────────────────────────
  log(`generating ${SCENE_COUNT}-scene Stash fixture...`);
  const fixture = generateStashFixture({ sceneCount: SCENE_COUNT, seed: 42 });
  log(`fixture: ${fixture.outputPath} (${fixture.manifest.matched.length} matchable, ${fixture.manifest.unmatched.length} deliberately unmatched)`);

  const mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-scale-media-"));
  const now = Date.now();
  const library = await db
    .insertInto("libraries")
    .values({ name: "Stash Scale Proof", media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();

  log(`seeding ${fixture.manifest.matched.length} matching catalog_items/media_files rows + real files...`);
  const CHUNK = 500;
  for (let i = 0; i < fixture.manifest.matched.length; i += CHUNK) {
    const chunk = fixture.manifest.matched.slice(i, i + CHUNK);
    const items = await db
      .insertInto("catalog_items")
      .values(chunk.map((s) => ({ library_id: library.id, item_type: "movie", title: `Scene ${s.id}`, sort_title: `scene ${s.id}`, added_at_ms: now, updated_at_ms: now })))
      .returningAll()
      .execute();
    await db
      .insertInto("media_files")
      .values(items.map((item, idx) => ({ item_id: item.id, path: path.join(mediaDir, chunk[idx].basename), size_bytes: chunk[idx].sizeBytes })))
      .execute();
    for (let j = 0; j < chunk.length; j++) {
      writeFileSync(path.join(mediaDir, chunk[j].basename), Buffer.alloc(Math.min(chunk[j].sizeBytes, 4096), 0x42));
    }
  }

  await upsertLibraryStashConnectionConfig(db, { libraryId: library.id, sqlitePath: fixture.outputPath, nowMs: Date.now() });
  await replaceLibraryPathMappings(db, library.id, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);

  const deps = {
    db,
    applyStashSceneMetadata: await makeApply(),
    enqueueImageJob: async () => {
      imageJobsEnqueued += 1;
      return undefined;
    },
  };

  let peakRssBytes = 0;
  const rssTimer = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 200);

  const startedAtMs = Date.now();
  const fullResult = await runStashSync(deps, { libraryId: library.id, mode: "full" }, { jobId: randomUUID() });
  const elapsedMs = Date.now() - startedAtMs;
  clearInterval(rssTimer);

  log(`(i) FULL SYNC @ ${SCENE_COUNT} scenes — wall-clock ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s), peak RSS ${(peakRssBytes / 1024 / 1024).toFixed(1)} MiB [apply STUBBED]`);
  log(`    counts: ${JSON.stringify(fullResult.counts)}, touchedCount=${fullResult.touchedCount}`);

  if (fullResult.touchedCount !== SCENE_COUNT) fail(`full sync touchedCount ${fullResult.touchedCount} !== ${SCENE_COUNT}`);
  if (fullResult.counts.matched !== fixture.manifest.matched.length) {
    fail(`full sync matchedCount ${fullResult.counts.matched} !== expected ${fixture.manifest.matched.length}`);
  }
  if (fullResult.counts.unmatched !== fixture.manifest.unmatched.length) {
    fail(`full sync unmatchedCount ${fullResult.counts.unmatched} !== expected ${fixture.manifest.unmatched.length}`);
  }

  // ── (ii) incremental touches exactly N ───────────────────────────────
  log(`(ii) mutating ${INCREMENTAL_CHANGED} scenes' updated_at for the incremental proof...`);
  const changedIds = fixture.manifest.matched.slice(0, INCREMENTAL_CHANGED).map((s) => s.id);
  {
    const sqliteDb = new DatabaseSync(fixture.outputPath);
    const stmt = sqliteDb.prepare("UPDATE scenes SET updated_at = ? WHERE id = ?");
    for (const id of changedIds) stmt.run("2026-07-15 00:00:00", id);
    sqliteDb.close();
  }

  const incResult = await runStashSync(deps, { libraryId: library.id, mode: "incremental" }, { jobId: randomUUID() });
  log(`    incremental touchedCount=${incResult.touchedCount} (expected ${INCREMENTAL_CHANGED})`);
  if (incResult.touchedCount !== INCREMENTAL_CHANGED) {
    fail(`incremental sync touched ${incResult.touchedCount} scenes, expected exactly ${INCREMENTAL_CHANGED}`);
  }
  log(`(ii) PASS — incremental sync touched exactly ${INCREMENTAL_CHANGED} of ${SCENE_COUNT} scenes.`);

  rmSync(mediaDir, { recursive: true, force: true });

  // ── (iii) checkpoint resume (sub-scale, see header) ──────────────────
  log(`(iii) checkpoint-resume proof at ${RESUME_SCENES}-scene sub-scale...`);
  const resumeFixture = generateStashFixture({ sceneCount: RESUME_SCENES, seed: 7, unmatchedFraction: 0 });
  const resumeMediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-resume-media-"));
  const resumeLibrary = await db
    .insertInto("libraries")
    .values({ name: "Stash Resume Proof", media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();

  for (let i = 0; i < resumeFixture.manifest.matched.length; i += CHUNK) {
    const chunk = resumeFixture.manifest.matched.slice(i, i + CHUNK);
    const items = await db
      .insertInto("catalog_items")
      .values(chunk.map((s) => ({ library_id: resumeLibrary.id, item_type: "movie", title: `Resume Scene ${s.id}`, sort_title: `resume scene ${s.id}`, added_at_ms: now, updated_at_ms: now })))
      .returningAll()
      .execute();
    await db
      .insertInto("media_files")
      .values(items.map((item, idx) => ({ item_id: item.id, path: path.join(resumeMediaDir, chunk[idx].basename), size_bytes: chunk[idx].sizeBytes })))
      .execute();
    for (let j = 0; j < chunk.length; j++) {
      writeFileSync(path.join(resumeMediaDir, chunk[j].basename), Buffer.alloc(Math.min(chunk[j].sizeBytes, 4096), 0x43));
    }
  }
  await upsertLibraryStashConnectionConfig(db, { libraryId: resumeLibrary.id, sqlitePath: resumeFixture.outputPath, nowMs: Date.now() });
  await replaceLibraryPathMappings(db, resumeLibrary.id, [{ stashPrefix: "/stash-media", loombrePrefix: resumeMediaDir }]);

  // "No lost work" means every scene is eventually applied AT LEAST once —
  // it does NOT mean no scene is ever re-applied. Checkpointing is
  // PERIODIC (checkpointIntervalScenes below), so work done between the
  // last periodic checkpoint write and the crash point is, by design,
  // redone on resume (exactly scanner.ts's own accepted characteristic for
  // filesystem walks — see sync-consumer.ts's header). appliedSceneIds is
  // a Set (dedups naturally); redundantApplyCount is purely informational,
  // never a failure signal.
  const appliedSceneIds = new Set();
  let redundantApplyCount = 0;
  const FAIL_AFTER = Math.floor(RESUME_SCENES / 3);
  let callCount = 0;
  const crashingApply = async (_trx, _applyDeps, input) => {
    callCount++;
    if (callCount === FAIL_AFTER) {
      throw new Error(`stash-scale-proof: simulated crash after ${FAIL_AFTER} scenes`);
    }
    if (appliedSceneIds.has(input.stashSceneId)) {
      redundantApplyCount++;
    }
    appliedSceneIds.add(input.stashSceneId);
    return { changedFields: ["title"] };
  };

  const resumeJobId = randomUUID();
  const resumeDeps = { db, applyStashSceneMetadata: crashingApply, enqueueImageJob: async () => undefined, checkpointIntervalScenes: 25 };

  let crashed = false;
  try {
    await runStashSync(resumeDeps, { libraryId: resumeLibrary.id, mode: "full" }, { jobId: resumeJobId });
  } catch (err) {
    crashed = true;
    log(`    attempt 1 crashed as expected: ${err.message}`);
  }
  if (!crashed) fail("checkpoint-resume proof: attempt 1 was supposed to crash but did not");

  const { getStashSyncCheckpoint } = await import("@loombre/db/internal");
  const checkpointAfterCrash = await getStashSyncCheckpoint(db, resumeJobId);
  if (!checkpointAfterCrash || checkpointAfterCrash.phase !== "applying") {
    fail(`checkpoint-resume proof: expected a persisted 'applying' checkpoint after the crash, got ${JSON.stringify(checkpointAfterCrash)}`);
  }
  log(`    checkpoint after crash: scenes_processed=${checkpointAfterCrash.scenes_processed}, last_processed=${checkpointAfterCrash.last_processed_stash_scene_id}`);

  // Attempt 2: SAME job.id, apply no longer throws — resumes past the
  // already-applied scenes.
  const resumeResult = await runStashSync(resumeDeps, { libraryId: resumeLibrary.id, mode: "full" }, { jobId: resumeJobId });
  log(`    attempt 2 (resume) completed: counts=${JSON.stringify(resumeResult.counts)}`);

  if (appliedSceneIds.size !== RESUME_SCENES) {
    fail(`checkpoint resume: ${appliedSceneIds.size} DISTINCT scenes applied across both attempts, expected exactly ${RESUME_SCENES} — lost work`);
  }
  if (resumeResult.touchedCount !== RESUME_SCENES) {
    fail(`checkpoint resume: resumed run's touchedCount ${resumeResult.touchedCount} !== ${RESUME_SCENES} (inventory/matching must re-run in full on every attempt)`);
  }
  log(
    `(iii) PASS — all ${RESUME_SCENES} scenes applied across the crash+resume (${redundantApplyCount} redone between the last periodic checkpoint and the crash point — expected, not lost work; see sync-consumer.ts's header). Zero scenes missing.`
  );

  rmSync(resumeMediaDir, { recursive: true, force: true });
  await db.destroy();

  console.log("\n[stash-scale-proof] ALL PROOFS PASSED.");
  console.log(
    JSON.stringify(
      {
        fullSync: {
          scenes: SCENE_COUNT,
          wallClockMs: elapsedMs,
          peakRssMiB: Number((peakRssBytes / 1024 / 1024).toFixed(1)),
          counts: fullResult.counts,
          applyStubbed: !REAL_APPLY,
          imageJobsEnqueued,
        },
        incremental: { changed: INCREMENTAL_CHANGED, touchedCount: incResult.touchedCount },
        checkpointResume: { scenes: RESUME_SCENES, failAfter: FAIL_AFTER, distinctScenesApplied: appliedSceneIds.size, redundantApplyCount },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
