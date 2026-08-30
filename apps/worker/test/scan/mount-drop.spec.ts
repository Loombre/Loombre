// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/mount-drop.spec.ts
//
// EXIT-GATE TEST (deliverable A, P1.2, docs/PLAN.md §8.2): scan a library,
// then rename the library root away (simulates an unmounted network
// share/USB drive) and rescan -> items are hidden from the GUARDED
// listItems (packages/db's public query surface), even though their DB
// rows still exist (soft, not deleted — the 72h grace window). Then
// restore the root and rescan again -> items are visible again, with
// ZERO data change on the files/items rows (row-for-row identical).

import { renameSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, listItems, type ViewerContext } from "@loombre/db";
import { runScan } from "../../src/scan/scanner.js";
import { createHashPool, type HashPool } from "../../src/scan/identity/pool.js";
import {
  createLibrary,
  DATABASE_URL,
  makeDb,
  makeMemoryQueue,
  makeRawClient,
  makeTmpLibraryDir,
  resetSchema,
  writeFakeMediaFile,
} from "./helpers.js";

interface FileRow {
  id: string;
  item_id: string;
  path: string;
  content_hash: string;
  size_bytes: number;
  missing_since_ms: number | null;
}

async function fetchFileRows(raw: Awaited<ReturnType<typeof makeRawClient>>, libraryId: string): Promise<FileRow[]> {
  const result = await raw.query<FileRow>(
    `SELECT mf.id, mf.item_id, mf.path, mf.content_hash, mf.size_bytes, mf.missing_since_ms
     FROM media_files mf JOIN catalog_items ci ON ci.id = mf.item_id
     WHERE ci.library_id = $1 ORDER BY mf.path`,
    [libraryId]
  );
  return result.rows;
}

describe("scanner: mount-drop (exit gate)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;
  let movingRoot: string; // the actual mount-point-like directory we rename away

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    hashPool = createHashPool(2);
    const parent = makeTmpLibraryDir("mount-drop-parent");
    movingRoot = join(parent, "mounted-volume");
    libraryDir = movingRoot;
    writeFakeMediaFile(join(libraryDir, "Mount Drop Movie (2010).mkv"), "mount-drop-movie", 4096);

    libraryId = await createLibrary(raw, { name: "Mount Drop Library", mediaKind: "movie", paths: [libraryDir] });
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("hides items when the mount drops, restores them intact when it comes back — zero data change either way", async () => {
    const { queue: q1 } = makeMemoryQueue();
    await runScan({ db: dbHandle, queue: q1, hashPool }, { libraryId, full: true }, { jobId: "018f0002-0000-7000-8000-000000000001" });

    const itemBefore = await raw.query<{ id: string }>(
      "SELECT id FROM catalog_items WHERE library_id = $1 AND item_type = 'movie'",
      [libraryId]
    );
    expect(itemBefore.rows).toHaveLength(1);
    const itemId = itemBefore.rows[0]!.id;

    const ctx: ViewerContext = { userId: "mount-drop-test-user", allowedLibraryIds: [libraryId], restrictedCleared: true, surface: "restricted" };
    const publicDb = createDb(DATABASE_URL);
    try {
      const visibleBefore = await listItems(publicDb, ctx, { itemType: "movie" });
      expect(visibleBefore.rows.some((r) => r.id === itemId)).toBe(true);

      const filesBeforeDrop = await fetchFileRows(raw, libraryId);
      expect(filesBeforeDrop).toHaveLength(1);
      expect(filesBeforeDrop[0]!.missing_since_ms).toBeNull();

      // Simulate an unmount: rename the mount-point-like directory away so
      // the library's configured path no longer resolves to anything.
      const droppedElsewhere = `${movingRoot}-unmounted`;
      renameSync(movingRoot, droppedElsewhere);

      const { queue: q2 } = makeMemoryQueue();
      await runScan({ db: dbHandle, queue: q2, hashPool }, { libraryId, full: true }, { jobId: "018f0002-0000-7000-8000-000000000002" });

      const filesAfterDrop = await fetchFileRows(raw, libraryId);
      expect(filesAfterDrop).toHaveLength(1); // row still exists — soft, not deleted
      expect(filesAfterDrop[0]!.missing_since_ms).not.toBeNull();

      const visibleDuringDrop = await listItems(publicDb, ctx, { itemType: "movie" });
      expect(visibleDuringDrop.rows.some((r) => r.id === itemId)).toBe(false);
      const itemDuringDrop = await raw.query<{ id: string }>("SELECT id FROM catalog_items WHERE id = $1", [itemId]);
      expect(itemDuringDrop.rows).toHaveLength(1); // DB row untouched, just hidden

      // Restore the mount.
      renameSync(droppedElsewhere, movingRoot);

      const { queue: q3 } = makeMemoryQueue();
      await runScan({ db: dbHandle, queue: q3, hashPool }, { libraryId, full: true }, { jobId: "018f0002-0000-7000-8000-000000000003" });

      const visibleAfterRestore = await listItems(publicDb, ctx, { itemType: "movie" });
      expect(visibleAfterRestore.rows.some((r) => r.id === itemId)).toBe(true);

      const filesAfterRestore = await fetchFileRows(raw, libraryId);
      expect(filesAfterRestore).toEqual(filesBeforeDrop); // row-for-row identical, zero data change

      const itemsAfterRestore = await raw.query<{ id: string; title: string; year: number }>(
        "SELECT id, title, year FROM catalog_items WHERE library_id = $1 AND item_type = 'movie'",
        [libraryId]
      );
      expect(itemsAfterRestore.rows).toHaveLength(1); // still exactly one item — no duplicate created
      expect(itemsAfterRestore.rows[0]!.id).toBe(itemId);
    } finally {
      await publicDb.destroy();
    }
  }, 30_000);
});
