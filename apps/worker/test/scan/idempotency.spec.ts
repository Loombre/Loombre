// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/idempotency.spec.ts
//
// "Idempotency test: scanning the same tree twice = zero new rows, zero
// new events (except scan.*)" — scans a small mixed movie/TV/music-style
// library twice in a row with nothing changed on disk between scans, and
// asserts every table's row count is identical before/after the second
// scan, and the only new `events` rows the second scan produces are
// scan.started/scan.completed for that second run.

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/scanner.js";
import { createHashPool, type HashPool } from "../../src/scan/identity/pool.js";
import { createLibrary, makeDb, makeMemoryQueue, makeRawClient, makeTmpLibraryDir, resetSchema, writeFakeMediaFile } from "./helpers.js";

const COUNTED_TABLES = [
  "catalog_items",
  "movie_details",
  "series_details",
  "season_details",
  "episode_details",
  "artist_details",
  "album_details",
  "track_details",
  "media_files",
  "media_streams",
] as const;

async function tableCounts(raw: Awaited<ReturnType<typeof makeRawClient>>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const result = await raw.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    out[table] = Number(result.rows[0]!.n);
  }
  return out;
}

describe("scanner: idempotency (scanning the same tree twice)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    hashPool = createHashPool(2);
    libraryDir = makeTmpLibraryDir("idempotency");

    writeFakeMediaFile(join(libraryDir, "Idempotent Movie (2015).mkv"), "idem-movie", 512);
    writeFakeMediaFile(
      join(libraryDir, "Idempotent Show", "Season 01", "Idempotent Show - S01E01 - Pilot.mkv"),
      "idem-episode",
      512
    );

    libraryId = await createLibrary(raw, { name: "Idempotency Library", mediaKind: "tv", paths: [libraryDir] });
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("a second full scan of an unchanged tree adds zero rows anywhere and zero non-scan.* events", async () => {
    const { queue: queue1, calls: firstCalls } = makeMemoryQueue();
    await runScan({ db: dbHandle, queue: queue1, hashPool }, { libraryId, full: true }, { jobId: "018f0004-0000-7000-8000-000000000001" });

    // The FIRST scan must enqueue provider-enrichment work: one metadata
    // job per newly-created enrichable item (movies here). This is the sole
    // scan→metadata wiring point; without it the provider pipeline never
    // runs (regression guard for the Wave-4 review finding).
    const metadataCalls = firstCalls.filter((c) => c.type === "metadata");
    expect(metadataCalls.length).toBeGreaterThan(0);
    for (const c of metadataCalls) {
      expect(c.payload).toHaveProperty("itemId");
      expect(c.payload).toHaveProperty("mediaKind");
      expect(c.payload).toHaveProperty("contentClass");
    }

    const before = await tableCounts(raw);
    const eventCountBefore = await raw.query<{ n: string }>("SELECT count(*)::text AS n FROM events");

    const { queue: queue2, calls } = makeMemoryQueue();
    await runScan({ db: dbHandle, queue: queue2, hashPool }, { libraryId, full: true }, { jobId: "018f0004-0000-7000-8000-000000000002" });

    const after = await tableCounts(raw);
    expect(after).toEqual(before);

    // No new probe/image jobs on the second, unchanged scan.
    expect(calls).toHaveLength(0);

    // Every event row the second scan's job id produced must be scan.* —
    // and that set must account for ALL new event rows since before the
    // second scan (i.e. nothing else was written).
    const secondScanEvents = await raw.query<{ type: string }>(
      "SELECT type FROM events WHERE payload->>'jobId' = $1",
      ["018f0004-0000-7000-8000-000000000002"]
    );
    expect(secondScanEvents.rows.length).toBeGreaterThan(0);
    for (const row of secondScanEvents.rows) {
      expect(row.type.startsWith("scan.")).toBe(true);
    }

    const totalEventCountAfter = await raw.query<{ n: string }>("SELECT count(*)::text AS n FROM events");
    const newEventCount = Number(totalEventCountAfter.rows[0]!.n) - Number(eventCountBefore.rows[0]!.n);
    expect(newEventCount).toBe(secondScanEvents.rows.length);
  }, 30_000);
});
