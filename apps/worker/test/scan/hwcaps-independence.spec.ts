// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/hwcaps-independence.spec.ts
//
// W1/D-1 (2026-08-07) regression pin: library scanning has ZERO dependency
// on the hardware capability probe. An empty capability set is a valid,
// first-class software-only state — scanning is I/O + hashing + downstream
// enqueues and must run identically on a machine with no GPU at all (the
// Windows-ARM-VM report that motivated W1: "probe found no backends,
// libraries never got processed"). Two scenarios, both must complete a
// full end-to-end scan and enqueue per-item probe work:
//   1. a PERSISTED current hw_capability_snapshots row with ZERO backend
//      rows (probe completed, verified nothing), and
//   2. NO snapshot at all (probe never ran).
// If either scenario ever fails while the other passes, a hwcaps read has
// leaked into the scan path — exactly what D-1 forbids.
//
// Live-DB suite following helpers.ts's conventions (schema reset per
// file; DATABASE_URL default postgres://loombre:loombre@localhost:5442).

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

describe("scanner: independence from hardware capability state (W1/D-1)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let emptyCapsLibraryId: string;
  let noCapsLibraryId: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    hashPool = createHashPool(2);

    const emptyCapsDir = makeTmpLibraryDir("hwcaps-empty");
    writeFakeMediaFile(join(emptyCapsDir, "Software Only (2020).mkv"), "w1-empty-caps", 512);
    emptyCapsLibraryId = await createLibrary(raw, {
      name: "W1 Empty Caps Library",
      mediaKind: "movie",
      paths: [emptyCapsDir],
    });

    const noCapsDir = makeTmpLibraryDir("hwcaps-none");
    writeFakeMediaFile(join(noCapsDir, "Never Probed (2021).mkv"), "w1-no-caps", 512);
    noCapsLibraryId = await createLibrary(raw, {
      name: "W1 No Caps Library",
      mediaKind: "movie",
      paths: [noCapsDir],
    });
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  async function scanCompletedEvent(jobId: string): Promise<{ status: string } | undefined> {
    const result = await raw.query<{ payload: { status: string } }>(
      "SELECT payload FROM events WHERE type = 'scan.completed' AND payload->>'jobId' = $1",
      [jobId],
    );
    return result.rows[0]?.payload;
  }

  it("scan completes end-to-end with a PERSISTED capability snapshot that has ZERO backends", async () => {
    // The exact GPU-less VM state: probe completed, verified nothing.
    await raw.query(
      `INSERT INTO hw_capability_snapshots
         (ffmpeg_build_hash, gpu_fingerprint, platform, verified_at_ms, is_current)
       VALUES ('sha256-w1-empty', '', $1, $2, true)`,
      [process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux", Date.now()],
    );

    const { queue, calls } = makeMemoryQueue();
    const jobId = "018f0513-0000-7000-8000-000000000001";
    await runScan({ db: dbHandle, queue, hashPool }, { libraryId: emptyCapsLibraryId, full: true }, { jobId });

    const completed = await scanCompletedEvent(jobId);
    expect(completed, "scan.completed event must exist").toBeDefined();
    expect(completed!.status).toBe("succeeded");

    const items = await raw.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM catalog_items WHERE library_id = $1",
      [emptyCapsLibraryId],
    );
    expect(Number(items.rows[0]!.n)).toBeGreaterThan(0);

    // Per-item ffprobe analysis was enqueued — the media pipeline continues
    // past the scanner with zero hardware capabilities.
    expect(calls.filter((c) => c.type === "probe").length).toBeGreaterThan(0);
  });

  it("scan completes end-to-end with NO capability snapshot at all", async () => {
    await raw.query("DELETE FROM hw_capability_backends");
    await raw.query("DELETE FROM hw_capability_snapshots");

    const { queue, calls } = makeMemoryQueue();
    const jobId = "018f0513-0000-7000-8000-000000000002";
    await runScan({ db: dbHandle, queue, hashPool }, { libraryId: noCapsLibraryId, full: true }, { jobId });

    const completed = await scanCompletedEvent(jobId);
    expect(completed, "scan.completed event must exist").toBeDefined();
    expect(completed!.status).toBe("succeeded");

    const items = await raw.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM catalog_items WHERE library_id = $1",
      [noCapsLibraryId],
    );
    expect(Number(items.rows[0]!.n)).toBeGreaterThan(0);
    expect(calls.filter((c) => c.type === "probe").length).toBeGreaterThan(0);
  });
});
