// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/mtime-incremental.spec.ts
//
// EXIT-GATE TEST (STATE.md P3.10, migrations/0010_media_files_mtime_ms.sql):
// closes the same-byte-size blind spot in the scanner's incremental fast
// path (scanner.ts's processOneFile, "existingByPath" branch) — a
// same-path/same-size file used to be trusted as unchanged without ever
// comparing mtime, so an in-place edit that happened to preserve the exact
// byte length was never re-hashed or re-probed. Three cases:
//   1. an unchanged file with a matching mtime never invokes the hash pool
//      at all (the true fast path).
//   2. a same-size in-place edit (different content, different mtime) is
//      caught: re-hash runs, the hash differs, and the existing
//      re-encode-in-place handling fires (probe fields reset + a fresh
//      'probe' job) — same shape as packages/db/test/scan-writers.spec.ts's
//      "updateMediaFileHash refreshes identity and nulls probe fields".
//   3. a legacy NULL-mtime row (simulating one that predates this column)
//      re-hashes exactly once on the next scan, backfills mtime_ms with no
//      probe/event work when the content turns out unchanged, and takes
//      the true fast path (zero hash calls) on the scan after that.

import { utimesSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/scanner.js";
import { hashFile } from "../../src/scan/identity/hash.js";
import type { HashPoolLike } from "../../src/scan/scanner.js";
import {
  createLibrary,
  makeDb,
  makeMemoryQueue,
  makeRawClient,
  makeTmpLibraryDir,
  resetSchema,
  writeFakeMediaFile,
} from "./helpers.js";

interface FileRow {
  id: string;
  content_hash: string;
  size_bytes: number;
  mtime_ms: number | null;
  probe: unknown;
  probed_at_ms: number | null;
  container: string | null;
  missing_since_ms: number | null;
}

/** Real (non-worker-thread) hash pool — matches resume.spec.ts's approach
 * of avoiding the pool's thread overhead for tests that don't care about
 * concurrency, just correctness. */
function realHashPool(): HashPoolLike {
  return { hashFile };
}

/** Wraps the real hashFile with call tracking, mirroring resume.spec.ts's
 * makeSpyHashPool — this suite cares about WHETHER/HOW OFTEN a file gets
 * (re-)hashed, not thread parallelism. */
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

async function fetchFileRow(raw: Awaited<ReturnType<typeof makeRawClient>>, absPath: string): Promise<FileRow> {
  const result = await raw.query<FileRow>(
    `SELECT id, content_hash, size_bytes, mtime_ms, probe, probed_at_ms, container, missing_since_ms
     FROM media_files WHERE path = $1`,
    [absPath]
  );
  if (result.rows.length !== 1) {
    throw new Error(`expected exactly one media_files row for ${absPath}, found ${result.rows.length}`);
  }
  return result.rows[0]!;
}

describe("scanner: mtime_ms incremental fast path (exit gate, STATE.md P3.10)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
  });

  afterAll(async () => {
    await dbHandle.destroy();
    await raw.end();
  });

  it("unchanged file with matching mtime: hashing is NOT invoked", async () => {
    const libraryDir = makeTmpLibraryDir("mtime-unchanged");
    const libraryId = await createLibrary(raw, {
      name: "Mtime Unchanged Library",
      mediaKind: "movie",
      paths: [libraryDir],
    });
    const absPath = join(libraryDir, "Unchanged Movie (2001).mkv");
    writeFakeMediaFile(absPath, "unchanged-movie", 512);

    const { queue: queue1 } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue1, hashPool: realHashPool() },
      { libraryId, full: true },
      { jobId: "018f0010-0000-7000-8000-000000000001" }
    );

    const rowAfterFirst = await fetchFileRow(raw, absPath);
    expect(rowAfterFirst.mtime_ms).not.toBeNull();

    const { pool: pool2, hashedPaths } = makeSpyHashPool();
    const { queue: queue2, calls } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue2, hashPool: pool2 },
      { libraryId, full: true },
      { jobId: "018f0010-0000-7000-8000-000000000002" }
    );

    expect(hashedPaths).toHaveLength(0); // fast path: hash pool never invoked
    expect(calls).toHaveLength(0); // no probe/image/metadata jobs re-enqueued

    const rowAfterSecond = await fetchFileRow(raw, absPath);
    expect(rowAfterSecond).toEqual(rowAfterFirst); // zero data change
  }, 30_000);

  it("same-size in-place edit (different content, different mtime) is re-hashed and re-probed", async () => {
    const libraryDir = makeTmpLibraryDir("mtime-inplace-edit");
    const libraryId = await createLibrary(raw, {
      name: "Mtime In-Place Edit Library",
      mediaKind: "movie",
      paths: [libraryDir],
    });
    const absPath = join(libraryDir, "Edited Movie (2002).mkv");
    writeFakeMediaFile(absPath, "edited-movie-v1", 512);
    // Pin the initial mtime explicitly (zero milliseconds component) so the
    // comparison below is exact even on filesystems with second-level mtime
    // resolution, and so the follow-up edit is guaranteed a different stored
    // value regardless of how fast this test runs.
    const initialMtime = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(absPath, initialMtime, initialMtime);

    const { queue: queue1 } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue1, hashPool: realHashPool() },
      { libraryId, full: true },
      { jobId: "018f0011-0000-7000-8000-000000000001" }
    );

    const rowBefore = await fetchFileRow(raw, absPath);
    expect(rowBefore.mtime_ms).toBe(initialMtime.getTime());

    // Seed non-NULL probe fields directly (as if the probe consumer had
    // already run) so the re-encode-in-place reset below is a meaningful
    // assertion, not a no-op on already-NULL columns — mirrors
    // packages/db/test/scan-writers.spec.ts's re-encode test setup.
    await raw.query(
      `UPDATE media_files SET probe = $2, probed_at_ms = $3, container = $4 WHERE id = $1`,
      [rowBefore.id, JSON.stringify({ format: { format_name: "matroska,webm" } }), Date.now(), "mkv"]
    );

    // Rewrite with DIFFERENT content but the EXACT SAME byte length, and a
    // different, later mtime — the same-byte-size in-place edit this
    // migration exists to catch.
    writeFakeMediaFile(absPath, "edited-movie-v2-totally-different-bytes", 512);
    const editedMtime = new Date("2021-06-15T12:00:00.000Z");
    utimesSync(absPath, editedMtime, editedMtime);

    const { pool: pool2, hashedPaths } = makeSpyHashPool();
    const { queue: queue2, calls } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue2, hashPool: pool2 },
      { libraryId, full: true },
      { jobId: "018f0011-0000-7000-8000-000000000002" }
    );

    expect(hashedPaths).toContain(absPath); // re-hash happened

    const rowAfter = await fetchFileRow(raw, absPath);
    expect(rowAfter.content_hash).not.toBe(rowBefore.content_hash); // hash actually differs
    expect(rowAfter.size_bytes).toBe(512); // size unchanged — the whole point of this test
    expect(rowAfter.mtime_ms).toBe(editedMtime.getTime()); // mtime_ms caught up

    // Existing re-encode-in-place assertions (same shape as
    // scan-writers.spec.ts's "updateMediaFileHash refreshes identity and
    // nulls probe fields"): probe fields reset, and a fresh 'probe' job
    // re-enqueued for the SAME row (not a new one).
    expect(rowAfter.probe).toBeNull();
    expect(rowAfter.probed_at_ms).toBeNull();
    expect(rowAfter.container).toBeNull();
    const probeCalls = calls.filter((c) => c.type === "probe");
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.payload["mediaFileId"]).toBe(rowBefore.id);
  }, 30_000);

  it("legacy NULL-mtime row: re-hashes once, backfills mtime with no probe/event work, then takes the fast path", async () => {
    const libraryDir = makeTmpLibraryDir("mtime-legacy-null");
    const libraryId = await createLibrary(raw, {
      name: "Mtime Legacy Null Library",
      mediaKind: "movie",
      paths: [libraryDir],
    });
    const absPath = join(libraryDir, "Legacy Movie (2003).mkv");
    writeFakeMediaFile(absPath, "legacy-movie", 512);

    const { queue: queue1 } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue1, hashPool: realHashPool() },
      { libraryId, full: true },
      { jobId: "018f0012-0000-7000-8000-000000000001" }
    );

    const rowBefore = await fetchFileRow(raw, absPath);
    expect(rowBefore.mtime_ms).not.toBeNull();

    // Simulate a pre-migration row: null out mtime_ms directly — every row
    // that existed before migrations/0010_media_files_mtime_ms.sql landed
    // looks exactly like this.
    await raw.query("UPDATE media_files SET mtime_ms = NULL WHERE id = $1", [rowBefore.id]);

    const eventCountBefore = await raw.query<{ n: string }>("SELECT count(*)::text AS n FROM events");

    const { pool: pool2, hashedPaths: hashed2 } = makeSpyHashPool();
    const { queue: queue2, calls: calls2 } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue2, hashPool: pool2 },
      { libraryId, full: true },
      { jobId: "018f0012-0000-7000-8000-000000000002" }
    );

    expect(hashed2).toEqual([absPath]); // re-hash happened exactly once, for this one file
    expect(calls2).toHaveLength(0); // content unchanged — no probe/image/metadata jobs

    const rowAfterBackfill = await fetchFileRow(raw, absPath);
    expect(rowAfterBackfill.mtime_ms).not.toBeNull(); // backfilled
    expect(rowAfterBackfill.content_hash).toBe(rowBefore.content_hash); // identity untouched

    // Only scan.* events from the second run — no item.updated, no
    // file.relocated: this was bookkeeping, not a content change.
    const secondScanEvents = await raw.query<{ type: string }>(
      "SELECT type FROM events WHERE payload->>'jobId' = $1",
      ["018f0012-0000-7000-8000-000000000002"]
    );
    expect(secondScanEvents.rows.length).toBeGreaterThan(0);
    for (const row of secondScanEvents.rows) {
      expect(row.type.startsWith("scan.")).toBe(true);
    }
    const totalEventCountAfter = await raw.query<{ n: string }>("SELECT count(*)::text AS n FROM events");
    const newEventCount = Number(totalEventCountAfter.rows[0]!.n) - Number(eventCountBefore.rows[0]!.n);
    expect(newEventCount).toBe(secondScanEvents.rows.length);

    // A further rescan (mtime_ms now populated, file unchanged since) takes
    // the true fast path: the hash pool is never invoked.
    const { pool: pool3, hashedPaths: hashed3 } = makeSpyHashPool();
    const { queue: queue3, calls: calls3 } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: queue3, hashPool: pool3 },
      { libraryId, full: true },
      { jobId: "018f0012-0000-7000-8000-000000000003" }
    );

    expect(hashed3).toHaveLength(0);
    expect(calls3).toHaveLength(0);
  }, 30_000);
});
