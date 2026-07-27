// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/legacy-format-reinstatement.spec.ts
//
// STATE.md H3 — "Reinstate ingestion for the common legacy video formats
// ... Skip visibility: any file matching a known-media-but-unsupported
// extension lands in the scan report under 'skipped (unsupported format)'
// with a count and file list — silent non-ingestion is forbidden."
//
// Two live-DB paths, mirroring the helpers-based convention every other
// suite in this directory uses (idempotency.spec.ts, mount-drop.spec.ts):
//   1. A v1.1-reinstated legacy extension (.wmv) ingests exactly like any
//      other admitted extension — a real catalog item + media_files row +
//      an enqueued 'probe' job. No real ffmpeg/ffprobe needed at THIS
//      layer: the scanner never runs ffprobe itself, only enqueues the job
//      (apps/worker/test/probe/probe.integration.spec.ts covers the real
//      ffprobe->Container mapping for these extensions separately).
//   2. Excluded extensions (.wma/.ape, EXCLUDED_MEDIA_EXTENSIONS) create NO
//      item at all and are counted + listed in the scan.completed event's
//      skippedUnsupportedCount/skippedUnsupportedFiles, plus a local
//      console.log line per file (no telemetry — CLAUDE.md invariant 7).

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("scanner: legacy-format reinstatement + unsupported-format skip visibility (STATE.md H3)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;
  let queueCalls: ReturnType<typeof makeMemoryQueue>["calls"];
  let consoleLogLines: string[];

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    hashPool = createHashPool(2);
    libraryDir = makeTmpLibraryDir("h3-legacy");

    // Reinstated legacy video extension — must ingest like any ordinary one.
    writeFakeMediaFile(join(libraryDir, "Legacy War Movie (1985).wmv"), "legacy-wmv", 512);
    // Control: an already-admitted extension, unaffected by this change.
    writeFakeMediaFile(join(libraryDir, "Ordinary Movie (2020).mkv"), "ordinary-mkv", 512);
    // Excluded extensions (v1 policy call, STATE.md H3) — must NOT ingest.
    writeFakeMediaFile(join(libraryDir, "Old Song.wma"), "excluded-wma", 512);
    writeFakeMediaFile(join(libraryDir, "Ancient Track.ape"), "excluded-ape", 512);
    writeFakeMediaFile(join(libraryDir, "Rare Track.wv"), "excluded-wv", 512);
    // Recognized-media tail (Lane R review): known media, in NEITHER set
    // before the review fix — used to fall through to plain "ignored"
    // silently, the exact class the H3 audit finding was about.
    writeFakeMediaFile(join(libraryDir, "Camcorder Clip.mts"), "excluded-mts", 512);

    libraryId = await createLibrary(raw, { name: "Legacy Movies", mediaKind: "movie", paths: [libraryDir] });

    const { queue, calls } = makeMemoryQueue();
    queueCalls = calls;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScan({ db: dbHandle, queue, hashPool }, { libraryId, full: true }, { jobId: "018f0005-0000-7000-8000-000000000001" });
    consoleLogLines = logSpy.mock.calls.map((args) => String(args[0]));
    logSpy.mockRestore();
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("ingests the reinstated .wmv extension as a real catalog item + media_files row", async () => {
    const item = await raw.query<{ id: string; title: string }>(
      "SELECT id, title FROM catalog_items WHERE library_id = $1 AND title = $2",
      [libraryId, "Legacy War Movie"]
    );
    expect(item.rows).toHaveLength(1);

    const file = await raw.query<{ path: string }>(
      "SELECT path FROM media_files WHERE item_id = $1",
      [item.rows[0]!.id]
    );
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]!.path).toMatch(/\.wmv$/);
  });

  it("still ingests an ordinary already-admitted extension (.mkv) unaffected by the widening", async () => {
    const item = await raw.query<{ id: string }>(
      "SELECT id FROM catalog_items WHERE library_id = $1 AND title = $2",
      [libraryId, "Ordinary Movie"]
    );
    expect(item.rows).toHaveLength(1);
  });

  it("enqueues a 'probe' job for the reinstated .wmv file, same as any other ingested file", () => {
    expect(queueCalls.filter((c) => c.type === "probe").length).toBeGreaterThanOrEqual(2);
  });

  it("creates NO catalog item for excluded-extension files (.wma/.ape/.wv/.mts)", async () => {
    const items = await raw.query<{ title: string }>(
      "SELECT title FROM catalog_items WHERE library_id = $1",
      [libraryId]
    );
    const titles = items.rows.map((r) => r.title);
    expect(titles).not.toContain("Old Song");
    expect(titles).not.toContain("Ancient Track");
    expect(titles).not.toContain("Rare Track");
    expect(titles).not.toContain("Camcorder Clip");
    // Only the two genuinely-ingested files created items.
    expect(titles.sort()).toEqual(["Legacy War Movie", "Ordinary Movie"]);
  });

  it("counts and lists every excluded-extension file in the scan.completed event payload", async () => {
    const result = await raw.query<{ payload: { skippedUnsupportedCount: number; skippedUnsupportedFiles: string[] } }>(
      "SELECT payload FROM events WHERE type = 'scan.completed' AND payload->>'jobId' = $1",
      ["018f0005-0000-7000-8000-000000000001"]
    );
    expect(result.rows).toHaveLength(1);
    const payload = result.rows[0]!.payload;
    expect(payload.skippedUnsupportedCount).toBe(4);
    expect(payload.skippedUnsupportedFiles.sort()).toEqual(
      ["Ancient Track.ape", "Old Song.wma", "Rare Track.wv", "Camcorder Clip.mts"].sort(),
    );
  });

  it("logs each skipped-unsupported file locally (no telemetry — CLAUDE.md invariant 7)", () => {
    const skipLines = consoleLogLines.filter((line) => line.includes("skipped unsupported-format file"));
    expect(skipLines.length).toBe(4);
    expect(skipLines.some((line) => line.includes("Old Song.wma"))).toBe(true);
    expect(skipLines.some((line) => line.includes("Camcorder Clip.mts"))).toBe(true);
  });
});

describe("scanner: excluded extensions are kind-independent (STATE.md H3 adjudication C-3)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;

  beforeAll(async () => {
    await raw.connect();
    hashPool = createHashPool(2);
    libraryDir = makeTmpLibraryDir("h3-kind-independent");

    // A .wma file in a MUSIC library (where the extension would otherwise
    // plausibly belong by kind) — still excluded, same as in a movie
    // library: "a .wma in a music library AND in a video library are both
    // 'known media, unsupported'" (adjudicated, kind-independent).
    writeFakeMediaFile(join(libraryDir, "Some Artist", "Some Album", "01 - Track.wma"), "kind-indep-wma", 512);

    libraryId = await createLibrary(raw, { name: "Legacy Music", mediaKind: "music", paths: [libraryDir] });

    const { queue } = makeMemoryQueue();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runScan({ db: dbHandle, queue, hashPool }, { libraryId, full: true }, { jobId: "018f0005-0000-7000-8000-000000000002" });
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("skips a .wma file in a MUSIC library too, not just a video library", async () => {
    const items = await raw.query<{ title: string }>("SELECT title FROM catalog_items WHERE library_id = $1", [libraryId]);
    expect(items.rows).toHaveLength(0);

    const result = await raw.query<{ payload: { skippedUnsupportedCount: number; skippedUnsupportedFiles: string[] } }>(
      "SELECT payload FROM events WHERE type = 'scan.completed' AND payload->>'jobId' = $1",
      ["018f0005-0000-7000-8000-000000000002"]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.payload.skippedUnsupportedCount).toBe(1);
    expect(result.rows[0]!.payload.skippedUnsupportedFiles).toEqual(["Some Artist/Some Album/01 - Track.wma"]);
  });
});

describe("scanner: skippedUnsupportedFiles caps at 100 while the count stays authoritative (STATE.md H3)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;

  const TOTAL_EXCLUDED_FILES = 105;

  beforeAll(async () => {
    await raw.connect();
    hashPool = createHashPool(2);
    libraryDir = makeTmpLibraryDir("h3-cap");

    for (let i = 0; i < TOTAL_EXCLUDED_FILES; i++) {
      writeFakeMediaFile(join(libraryDir, `Track ${String(i).padStart(3, "0")}.wma`), `cap-${i}`, 64);
    }

    libraryId = await createLibrary(raw, { name: "Legacy Cap Library", mediaKind: "music", paths: [libraryDir] });

    const { queue } = makeMemoryQueue();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runScan({ db: dbHandle, queue, hashPool }, { libraryId, full: true }, { jobId: "018f0005-0000-7000-8000-000000000003" });
    vi.restoreAllMocks();
  }, 30_000);

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("count is authoritative (105) while the file list is capped at 100 entries", async () => {
    const result = await raw.query<{ payload: { skippedUnsupportedCount: number; skippedUnsupportedFiles: string[] } }>(
      "SELECT payload FROM events WHERE type = 'scan.completed' AND payload->>'jobId' = $1",
      ["018f0005-0000-7000-8000-000000000003"]
    );
    expect(result.rows).toHaveLength(1);
    const payload = result.rows[0]!.payload;
    expect(payload.skippedUnsupportedCount).toBe(TOTAL_EXCLUDED_FILES);
    expect(payload.skippedUnsupportedFiles).toHaveLength(100);
    expect(payload.skippedUnsupportedFiles.length).toBeLessThan(payload.skippedUnsupportedCount);
  });
});
