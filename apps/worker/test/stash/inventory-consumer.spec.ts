// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/inventory-consumer.spec.ts
//
// Live-DB + real-SQLite-fixture test for the 'stash-inventory' job
// (STATE.md K10) — apps/worker/src/stash/inventory-consumer.ts. Proves
// the bounded pass: connect -> read-model.listScenesForInventory ->
// stash_scene_links upsert -> close, with NO matching/apply/report/events
// (that is stash-sync's job, not this one).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createDb, listStashSceneLinksForLibrary, upsertLibraryStashConnectionConfig } from "@loombre/db";
import { stashInventoryConsumerHandler } from "../../src/stash/inventory-consumer.js";
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
let fixtureDir: string | undefined;

beforeAll(async () => {
  run(path.join(PKG_DB_ROOT, "scripts", "migrate.mjs"), ["reset"]);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

async function makeLibrary(): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto("libraries")
    .values({ name: `inv-lib-${randomUUID()}`, media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

describe("stash-inventory job consumer", () => {
  it("upserts stash_scene_links for every scene, unmatched (item_id null) by construction", async () => {
    const libraryId = await makeLibrary();
    const scenes: FixtureScene[] = [
      { id: 1, title: "A", folderPath: "/data", basename: "a.mp4", sizeBytes: 111, updatedAt: "2023-01-01 00:00:00" },
      { id: 2, title: "B", folderPath: "/data", basename: "b.mp4", sizeBytes: 222, updatedAt: "2023-01-02 00:00:00" },
    ];
    const fixture = buildSyncFixtureDb(scenes);
    fixture.db.close();
    fixtureDir = fixture.dir;

    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: fixture.dbPath, nowMs: Date.now() });

    const handler = stashInventoryConsumerHandler({ db });
    await handler({ libraryId }, { jobId: randomUUID() });

    const links = await listStashSceneLinksForLibrary(db, libraryId);
    expect(links.map((l) => l.stash_scene_id).sort()).toEqual(["1", "2"]);
    expect(links.every((l) => l.item_id === null)).toBe(true);
    expect(links.find((l) => l.stash_scene_id === "1")?.stash_path).toBe("/data/a.mp4");
    expect(links.find((l) => l.stash_scene_id === "2")?.stash_size_bytes).toBe(222);
  });

  it("throws (never silently no-ops) when the configured connection cannot be opened", async () => {
    const libraryId = await makeLibrary();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath: "/nonexistent/stash.sqlite", nowMs: Date.now() });

    const handler = stashInventoryConsumerHandler({ db });
    await expect(handler({ libraryId }, { jobId: randomUUID() })).rejects.toThrow(/cannot open Stash connection/);
  });
});
