// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/schedule-loop.spec.ts
//
// Live-DB test for trigger (b) — the schedule (STATE.md S8/deliverable 7)
// — apps/worker/src/stash/schedule-loop.ts's runStashScheduleTick. Proves:
// default OFF (scheduleIntervalMs=0 -> never enqueues), an enabled
// connection whose last report is older than the configured interval gets
// exactly one enqueue, a NOT-due connection is left alone, a
// disabled/unconfigured connection is skipped, and the
// hasQueuedOrActiveJobOfType guard prevents a tick from enqueueing while a
// stash-sync job is already queued/active.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createDb, createStashSyncReport, resolveTestDatabaseUrl, upsertLibraryStashConnectionConfig, upsertServerSettingAndEmit } from "@loombre/db";
import { runStashScheduleTick } from "../../src/stash/schedule-loop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DB_ROOT = path.resolve(__dirname, "../../../../packages/db");
const DATABASE_URL = resolveTestDatabaseUrl();

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
let actorUserId: string;

beforeAll(async () => {
  run(path.join(PKG_DB_ROOT, "scripts", "migrate.mjs"), ["reset"]);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const user = await db
    .insertInto("users")
    .values({
      username: "schedule-loop-test-actor",
      email: "schedule-loop-test-actor@example.com",
      password_hash: "not-a-real-hash",
      birth_date: null,
      max_content_rating: null,
      is_admin: true,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  actorUserId = user.id;
});

afterAll(async () => {
  await db?.destroy();
});

// Each test's "one enqueue per tick" assertion depends on iterating ONLY
// the library(ies) it itself set up (schedule-loop.ts's own "one due
// library per tick, first found" design) — libraries/connections/reports/
// jobs are cleared between tests so a prior test's still-due fixture data
// never leaks into the next test's tick. Cascades (library_stash_connections/
// stash_sync_reports both FK library_id ON DELETE CASCADE) take the
// dependent rows with the library row; `jobs` is not FK'd to libraries and
// is cleared separately. `users`/`server_settings` are deliberately left
// alone (the actor user + whatever interval a test just set).
beforeEach(async () => {
  await db.deleteFrom("jobs").execute();
  await db.deleteFrom("libraries").execute();
});

async function makeLibrary(): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto("libraries")
    .values({ name: `sched-lib-${randomUUID()}`, media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

async function setScheduleInterval(ms: number | undefined): Promise<void> {
  if (ms === undefined) {
    await db.deleteFrom("server_settings").where("key", "=", "stash.sync.scheduleIntervalMs").execute();
    return;
  }
  await upsertServerSettingAndEmit(db, { key: "stash.sync.scheduleIntervalMs", value: ms, actorUserId, nowMs: Date.now() });
}

describe("stash schedule-loop tick", () => {
  it("default OFF: never enqueues when scheduleIntervalMs is unset (0)", async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: "/does/not/matter.sqlite", nowMs: Date.now(), enabled: true });
    await setScheduleInterval(undefined);

    const enqueued: string[] = [];
    await runStashScheduleTick({ db, enqueueIncrementalSync: async (id) => enqueued.push(id) });
    expect(enqueued).toEqual([]);
  });

  it("enabled connection with NO prior report and a positive interval is due -> enqueued once", async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: "/does/not/matter.sqlite", nowMs: Date.now(), enabled: true });
    await setScheduleInterval(60_000);

    const enqueued: string[] = [];
    await runStashScheduleTick({ db, enqueueIncrementalSync: async (id) => enqueued.push(id) });
    expect(enqueued).toContain(libraryId);
  });

  it("a library whose last report started recently (within the interval) is NOT due", async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: "/does/not/matter.sqlite", nowMs: Date.now(), enabled: true });
    await createStashSyncReport(db, { libraryId, jobId: randomUUID(), mode: "incremental", startedAtMs: Date.now() });
    await setScheduleInterval(60 * 60 * 1000); // 1h — the report above is "now", well inside it

    const enqueued: string[] = [];
    await runStashScheduleTick({ db, enqueueIncrementalSync: async (id) => enqueued.push(id) });
    expect(enqueued).not.toContain(libraryId);
  });

  it("a disabled connection is skipped even when otherwise due", async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: "/does/not/matter.sqlite", nowMs: Date.now(), enabled: false });
    await setScheduleInterval(1);

    const enqueued: string[] = [];
    await runStashScheduleTick({ db, enqueueIncrementalSync: async (id) => enqueued.push(id) });
    expect(enqueued).not.toContain(libraryId);
  });

  it("a library with no library_stash_connections row at all is skipped", async () => {
    const libraryId = await makeLibrary();
    await setScheduleInterval(1);

    const enqueued: string[] = [];
    await runStashScheduleTick({ db, enqueueIncrementalSync: async (id) => enqueued.push(id) });
    expect(enqueued).not.toContain(libraryId);
  });

  it("hasQueuedOrActiveJobOfType guard: a queued stash-sync job blocks the tick from enqueueing anything", async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: "/does/not/matter.sqlite", nowMs: Date.now(), enabled: true });
    await setScheduleInterval(1);

    const nowMs = Date.now();
    await db
      .insertInto("jobs")
      .values({ id: randomUUID(), type: "stash-sync", status: "queued", created_at_ms: nowMs, updated_at_ms: nowMs })
      .execute();

    const enqueued: string[] = [];
    await runStashScheduleTick({ db, enqueueIncrementalSync: async (id) => enqueued.push(id) });
    expect(enqueued).toEqual([]);
  });
});
