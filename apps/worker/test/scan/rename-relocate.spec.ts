// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/rename-relocate.spec.ts
//
// EXIT-GATE TEST (deliverable A, D16/P1.1, docs/PLAN.md §8.2): scan a
// library, record item ids + write a progress row via raw SQL, then
// mv+rename the files on disk and rescan. Asserts:
//   - file.relocated events are emitted (one per moved file)
//   - the SAME catalog item ids survive the rename (never delete+readd)
//   - the progress row survives untouched (same position/state)
//   - ZERO duplicate items are created

import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/scanner.js";
import { createHashPool, type HashPool } from "../../src/scan/identity/pool.js";
import {
  createLibrary,
  makeDb,
  makeMemoryQueue,
  makeRawClient,
  makeTmpLibraryDir,
  resetSchema,
  writeFakeMediaFile,
} from "./helpers.js";

describe("scanner: rename/relocate (exit gate)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;
  let userId: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    hashPool = createHashPool(2);
    libraryDir = makeTmpLibraryDir("rename-relocate");
    libraryId = await createLibrary(raw, { name: "Rename Test Library", mediaKind: "movie", paths: [libraryDir] });

    const now = Date.now();
    const userRow = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
       VALUES ('rename-test', 'rename-test@loombre.local', 'x', $1, $1) RETURNING id`,
      [now]
    );
    userId = userRow.rows[0]!.id;
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("relinks renamed/moved files: same item ids, file.relocated events, progress intact, zero duplicates", async () => {
    writeFakeMediaFile(join(libraryDir, "Movie One (2001).mkv"), "movie-one", 4096);
    writeFakeMediaFile(join(libraryDir, "Movie Two (2002).mkv"), "movie-two", 4096);

    const { queue: queue1 } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue1, hashPool },
      { libraryId, full: true },
      { jobId: "018f0001-0000-7000-8000-000000000001" }
    );

    const before = await raw.query<{ id: string; title: string; year: number }>(
      "SELECT id, title, year FROM catalog_items WHERE library_id = $1 AND item_type = 'movie' ORDER BY title",
      [libraryId]
    );
    expect(before.rows).toHaveLength(2);
    const movieOneId = before.rows.find((r) => r.title === "Movie One")!.id;
    const movieTwoId = before.rows.find((r) => r.title === "Movie Two")!.id;

    const now = Date.now();
    await raw.query(
      `INSERT INTO progress (user_id, item_id, position_ms, state, updated_at_ms)
       VALUES ($1, $2, 42000, 'in-progress', $3)`,
      [userId, movieOneId, now]
    );

    // mv + rename: relocate into a subdirectory AND rename the file itself.
    const renamedDir = join(libraryDir, "Renamed");
    mkdirSync(renamedDir, { recursive: true });
    renameSync(
      join(libraryDir, "Movie One (2001).mkv"),
      join(renamedDir, "Movie One (2001) [renamed].mkv")
    );
    renameSync(join(libraryDir, "Movie Two (2002).mkv"), join(libraryDir, "Movie Two Renamed (2002).mkv"));

    const { queue: queue2, calls } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue2, hashPool },
      { libraryId, full: true },
      { jobId: "018f0001-0000-7000-8000-000000000002" }
    );

    // No probe/image jobs re-enqueued for a pure relocate (only genuinely
    // new files trigger a probe job).
    expect(calls.filter((c) => c.type === "probe")).toHaveLength(0);

    const after = await raw.query<{ id: string; title: string }>(
      "SELECT id, title FROM catalog_items WHERE library_id = $1 AND item_type = 'movie' ORDER BY title",
      [libraryId]
    );
    expect(after.rows).toHaveLength(2); // zero duplicates
    expect(after.rows.map((r) => r.id).sort()).toEqual([movieOneId, movieTwoId].sort());

    const files = await raw.query<{ item_id: string; path: string }>(
      "SELECT item_id, path FROM media_files WHERE item_id = ANY($1) ORDER BY path",
      [[movieOneId, movieTwoId]]
    );
    expect(files.rows).toHaveLength(2);
    expect(files.rows.some((f) => f.path.endsWith("Movie One (2001) [renamed].mkv"))).toBe(true);
    expect(files.rows.some((f) => f.path.endsWith("Movie Two Renamed (2002).mkv"))).toBe(true);

    const relocatedEvents = await raw.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'file.relocated' ORDER BY ts_ms"
    );
    expect(relocatedEvents.rows).toHaveLength(2);
    const relocatedItemIds = relocatedEvents.rows.map((r) => r.payload["itemId"]);
    expect(relocatedItemIds.sort()).toEqual([movieOneId, movieTwoId].sort());

    const progressRow = await raw.query<{ position_ms: number; state: string }>(
      "SELECT position_ms, state FROM progress WHERE user_id = $1 AND item_id = $2",
      [userId, movieOneId]
    );
    expect(progressRow.rows).toHaveLength(1);
    expect(progressRow.rows[0]).toEqual({ position_ms: 42000, state: "in-progress" });
  }, 30_000);
});
