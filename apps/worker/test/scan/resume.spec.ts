// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/resume.spec.ts
//
// EXIT-GATE TEST (deliverable A, P1.12, docs/PLAN.md §8.1): a checkpointed
// scan interrupted at file k resumes without reprocessing files up to and
// including k. Simulated deterministically: seed a scan_checkpoints row
// for a fixed job id pointing at a real file from the walk (as if a prior
// run of that SAME job crashed right after processing it), then run the
// scan and spy on the hash pool to prove files at/before the checkpoint
// are never hashed again while files after it are — the deterministic
// walk order (src/scan/walk.ts) is what makes "at/before" well-defined.

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeCheckpoint, getCheckpoint } from "@loombre/db/internal";
import { runScan } from "../../src/scan/scanner.js";
import { hashFile } from "../../src/scan/identity/hash.js";
import type { HashPoolLike } from "../../src/scan/scanner.js";
import { createLibrary, makeDb, makeMemoryQueue, makeRawClient, makeTmpLibraryDir, resetSchema, writeFakeMediaFile } from "./helpers.js";

/** Wraps the real (fast, in-thread) hashFile with call tracking — no need
 * for the worker_threads pool here, this test cares about WHICH files get
 * hashed, not thread parallelism (already covered by identity.spec.ts). */
function makeSpyHashPool(): { pool: HashPoolLike; hashedPaths: string[] } {
  const hashedPaths: string[] = [];
  const pool: HashPoolLike = {
    async hashFile(filePath: string, sizeBytes: number) {
      hashedPaths.push(filePath);
      return hashFile(filePath, sizeBytes);
    },
  };
  return { pool, hashedPaths };
}

describe("scanner: resume from checkpoint (exit gate)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let libraryId: string;
  let libraryDir: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    libraryDir = makeTmpLibraryDir("resume");
    libraryId = await createLibrary(raw, { name: "Resume Test Library", mediaKind: "movie", paths: [libraryDir] });
  });

  afterAll(async () => {
    await dbHandle.destroy();
    await raw.end();
  });

  it("skips reprocessing files up to the checkpoint, and processes the rest", async () => {
    // Five movies, alphabetically named so the deterministic walk order
    // (src/scan/walk.ts sorts entries per directory) is exactly A..E.
    const names = ["A Movie (2001)", "B Movie (2002)", "C Movie (2003)", "D Movie (2004)", "E Movie (2005)"];
    for (const name of names) {
      writeFakeMediaFile(join(libraryDir, `${name}.mkv`), name, 512);
    }

    const jobId = "018f0003-0000-7000-8000-000000000001";
    const checkpointedPath = join(libraryDir, "C Movie (2003).mkv"); // 3rd of 5

    // Seed a checkpoint AS IF a prior run of this same job crashed right
    // after processing "C Movie" — files A, B, C should be skipped this
    // run; D, E should still be processed.
    await writeCheckpoint(dbHandle, {
      jobId,
      libraryId,
      phase: "scanning",
      lastProcessedPath: checkpointedPath,
      filesSeen: 3,
      filesProcessed: 3,
      updatedAtMs: Date.now(),
    });

    const { pool: spyPool, hashedPaths } = makeSpyHashPool();
    const { queue } = makeMemoryQueue();

    await runScan({ db: dbHandle, queue, hashPool: spyPool }, { libraryId, full: true }, { jobId });

    expect(hashedPaths).not.toContain(join(libraryDir, "A Movie (2001).mkv"));
    expect(hashedPaths).not.toContain(join(libraryDir, "B Movie (2002).mkv"));
    expect(hashedPaths).not.toContain(checkpointedPath);
    expect(hashedPaths).toContain(join(libraryDir, "D Movie (2004).mkv"));
    expect(hashedPaths).toContain(join(libraryDir, "E Movie (2005).mkv"));

    // A/B/C were never actually inserted this run (resume skipped them,
    // and no prior run really happened — this is a synthetic mid-scan
    // checkpoint) — only D and E should exist as catalog items.
    const items = await raw.query<{ title: string }>(
      "SELECT title FROM catalog_items WHERE library_id = $1 AND item_type = 'movie' ORDER BY title",
      [libraryId]
    );
    expect(items.rows.map((r) => r.title)).toEqual(["D Movie", "E Movie"]);

    // Checkpoint fast-forwarded to the end of the walk.
    const finalCheckpoint = await getCheckpoint(dbHandle, jobId);
    expect(finalCheckpoint?.files_seen).toBe(5);
  }, 30_000);

  it("a resumed scan that reaches the exact end leaves scan_checkpoints reflecting full completion", async () => {
    const dir2 = makeTmpLibraryDir("resume-2");
    const lib2 = await createLibrary(raw, { name: "Resume Test Library 2", mediaKind: "movie", paths: [dir2] });
    writeFakeMediaFile(join(dir2, "Only Movie (2020).mkv"), "only", 256);

    const jobId = "018f0003-0000-7000-8000-000000000002";
    const { pool: spyPool, hashedPaths } = makeSpyHashPool();
    const { queue } = makeMemoryQueue();

    await runScan({ db: dbHandle, queue, hashPool: spyPool }, { libraryId: lib2, full: true }, { jobId });

    expect(hashedPaths).toContain(join(dir2, "Only Movie (2020).mkv"));

    const items = await raw.query<{ title: string }>(
      "SELECT title FROM catalog_items WHERE library_id = $1 AND item_type = 'movie'",
      [lib2]
    );
    expect(items.rows).toHaveLength(1);
  }, 30_000);
});
