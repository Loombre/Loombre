// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/garbage-file-ingestion.spec.ts
//
// Owner ledger L1, adjudication A-5(a) — the honest text-file test chain's
// scanner-level link. The original brief's clause "ingestion already
// requires a successful ffprobe" is FALSE: apps/worker/src/scan/
// scanner.ts NEVER runs ffprobe. It creates the catalog_items + media_files
// rows and ENQUEUES a 'probe' job (processOneFile's genuinely-new-file
// branch); scan.completed is written in the SAME transaction as the scan
// finishing, well before any probe job runs. This test proves that
// end-to-end at the scanner layer: a file with an ADMITTED extension
// (.mts, owner-ledger L1) whose BYTES are plain text, not real media,
// ingests exactly like a real video file would — a catalog item, a
// media_files row, an enqueued probe job, and a normal ("succeeded")
// scan.completed event. Nothing about this is .mts-specific: the same is
// true for every admitted extension (VIDEO_EXTENSIONS/AUDIO_EXTENSIONS,
// apps/worker/src/scan/parse/path-utils.ts) — .mts is used here only
// because L1 is the item that put a spotlight on this gap.
//
// The probe-side failure this garbage file eventually produces (a real
// ffprobe nonzero-exit) is covered separately:
//   - apps/worker/test/probe/consumer.spec.ts / probe.integration.spec.ts
//     (A-5(b): runProbe against a text file throws ProbeError).
//   - packages/jobs/test/queue-driver.spec.ts (A-5(c): the terminal-failure
//     seam fires only once retries are exhausted).
//   - apps/worker/test/probe/terminal-failure-hook.spec.ts (A-5(d): the
//     terminal-failure hook writes a probe.failed event).
//   - apps/web/src/components/admin/LibrariesPanel.test.tsx (A-5(e): the
//     panel renders the disclosure).
// scan.completed's OWN schema/payload is untouched by any of this — see
// this suite's last test.

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

describe("scanner: a garbage (non-media) file with an admitted extension ingests normally (owner ledger L1, A-5a)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;
  let queueCalls: ReturnType<typeof makeMemoryQueue>["calls"];

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    hashPool = createHashPool(2);
    libraryDir = makeTmpLibraryDir("l1-garbage");

    // A real plain-text file, not media, wearing an admitted video
    // extension. The scanner's admission decision is extension-only (D16,
    // §8.1) — it never inspects bytes, never spawns ffprobe.
    writeFakeMediaFile(
      join(libraryDir, "Fake Camcorder Clip.mts"),
      "this is not a video file, just plain text pretending to be one\n",
      512,
    );

    libraryId = await createLibrary(raw, { name: "Garbage File Library", mediaKind: "movie", paths: [libraryDir] });

    const { queue, calls } = makeMemoryQueue();
    queueCalls = calls;

    await runScan({ db: dbHandle, queue, hashPool }, { libraryId, full: true }, { jobId: "018f0006-0000-7000-8000-000000000001" });
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("creates a real catalog item for the text file wearing an .mts extension", async () => {
    const item = await raw.query<{ id: string; title: string }>(
      "SELECT id, title FROM catalog_items WHERE library_id = $1 AND title = $2",
      [libraryId, "Fake Camcorder Clip"],
    );
    expect(item.rows).toHaveLength(1);
  });

  it("creates a media_files row for it, same as a real media file", async () => {
    const item = await raw.query<{ id: string }>(
      "SELECT id FROM catalog_items WHERE library_id = $1 AND title = $2",
      [libraryId, "Fake Camcorder Clip"],
    );
    const file = await raw.query<{ path: string }>("SELECT path FROM media_files WHERE item_id = $1", [item.rows[0]!.id]);
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]!.path).toMatch(/\.mts$/);
  });

  it("enqueues a 'probe' job for it — the scanner never runs ffprobe itself (premise correction)", () => {
    expect(queueCalls.some((c) => c.type === "probe")).toBe(true);
  });

  it("scan.completed reports status 'succeeded' — the eventual probe failure is invisible to the scan job itself", async () => {
    const result = await raw.query<{ payload: { status: string; skippedUnsupportedCount?: number } }>(
      "SELECT payload FROM events WHERE type = 'scan.completed' AND payload->>'jobId' = $1",
      ["018f0006-0000-7000-8000-000000000001"],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.payload.status).toBe("succeeded");
    // Not a skip: the file was genuinely ADMITTED and ingested, not
    // excluded — scan.completed's skip-visibility fields are untouched by
    // this scenario entirely (they describe a DIFFERENT thing: extensions
    // the scanner refuses to admit at all).
    expect(result.rows[0]!.payload.skippedUnsupportedCount ?? 0).toBe(0);
  });
});
