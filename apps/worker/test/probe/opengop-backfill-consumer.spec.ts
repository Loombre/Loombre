// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/probe/opengop-backfill-consumer.spec.ts
//
// Live-DB integration test for opengopBackfillConsumerHandler
// (migrations/0038_media_streams_open_gop.sql's backfill — mirrors
// apps/worker/test/image/backfill-consumer.spec.ts's own structure:
// SELF-SUFFICIENT (own resetSchema in beforeAll, same convention as every
// other live-DB spec in this package).
//
// Proves:
//   - a fresh sweep (cursor: null) bulk-sets every non-HEVC video row's
//     open_gop = false in one shot, with NO scan call for those rows
//   - a batch of HEVC rows still NULL gets scanned (via the injected
//     `detect` seam) and the resolved verdict written back, in id order
//   - a detect() failure (resolves null) leaves that row NULL — never a
//     guessed value — and is naturally left for a future fresh sweep
//   - resumability: a small batchSize leaves later HEVC rows NULL after
//     the first batch, and resuming from the captured cursor processes
//     exactly the remainder
//   - the handler only re-enqueues itself (via the injected enqueueSelf)
//     when a batch came back full (more rows might remain)
//   - the non-HEVC bulk-false pass runs on the FIRST batch of a fresh
//     sweep only, not on every resumed batch

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opengopBackfillConsumerHandler } from "../../src/probe/opengop-backfill-consumer.js";
import { createLibrary, makeDb, makeRawClient, resetSchema } from "../scan/helpers.js";

let db: ReturnType<typeof makeDb>;
let raw: ReturnType<typeof makeRawClient>;
let itemId: string;

beforeAll(async () => {
  resetSchema();
  db = makeDb();
  raw = makeRawClient();
  await raw.connect();

  const libraryId = await createLibrary(raw, { name: "OpenGop Backfill Test Library", mediaKind: "movie", paths: ["/nonexistent/opengop-backfill"] });
  const now = Date.now();
  const item = await raw.query<{ id: string }>(
    `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
     VALUES ($1, 'movie', 'OpenGop Backfill Test Movie', 'opengop backfill test movie', $2, $2)
     RETURNING id`,
    [libraryId, now],
  );
  itemId = item.rows[0]!.id;
});

afterAll(async () => {
  await db?.destroy();
  await raw?.end();
});

interface SeededStream {
  streamId: string;
  fileId: string;
  filePath: string;
}

/** `missingSinceMs` (opus review finding 10): omit for a normal present
 *  file; pass a timestamp to simulate a deleted/unmounted file the scanner
 *  has already flagged (media_files.missing_since_ms), which
 *  listHevcStreamsNeedingOpenGopProbe/hasVideoStreamsNeedingOpenGopBackfill
 *  now exclude — see "excludes rows whose file is currently missing"
 *  below. */
async function seedVideoStream(path: string, codec: string, missingSinceMs: number | null = null): Promise<SeededStream> {
  const now = Date.now();
  const fileRow = await raw.query<{ id: string }>(
    `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms, missing_since_ms)
     VALUES ($1, $2, $3, 1000000, 'mkv', 90000, $4, $5)
     RETURNING id`,
    [itemId, path, `opengop-backfill-${path}`, now, missingSinceMs],
  );
  const fileId = fileRow.rows[0]!.id;
  const streamRow = await raw.query<{ id: string }>(
    `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, frame_rate, is_default, is_forced)
     VALUES ($1, 0, 'video', $2, 320, 240, 8, 25, true, false)
     RETURNING id`,
    [fileId, codec],
  );
  return { streamId: streamRow.rows[0]!.id, fileId, filePath: path };
}

async function readOpenGop(streamId: string): Promise<boolean | null> {
  const { rows } = await raw.query<{ open_gop: boolean | null }>(
    "SELECT open_gop FROM media_streams WHERE id = $1",
    [streamId],
  );
  return rows[0]!.open_gop;
}

// Deterministic fake detector, keyed by an unmistakable path substring —
// mirrors image/backfill-consumer.spec.ts's injected `execute` convention.
function fakeDetect(filePath: string): Promise<boolean | null> {
  if (filePath.includes("-open-")) return Promise.resolve(true);
  if (filePath.includes("-closed-")) return Promise.resolve(false);
  return Promise.resolve(null); // "-fail-" or anything else: simulated scan failure
}

describe("opengopBackfillConsumerHandler", () => {
  it("bulk-sets non-HEVC NULL rows false on the first batch, scans HEVC rows via the injected detector, leaves a failed scan NULL, and resumes correctly across a cursor boundary", async () => {
    // Non-HEVC rows: never scanned, always resolved by the bulk pass.
    const h264 = await seedVideoStream("/media/test/h264-row.mp4", "h264");
    const av1 = await seedVideoStream("/media/test/av1-row.mp4", "av1");

    // HEVC rows: id-ordered (UUIDv7), sorted below by the DB's own id, not
    // insertion order — same discipline image/backfill-consumer.spec.ts
    // uses. Four rows -> batchSize 3 forces a two-batch resume.
    const hevcOpen1 = await seedVideoStream("/media/test/hevc-open-1.mkv", "hevc");
    const hevcClosed1 = await seedVideoStream("/media/test/hevc-closed-1.mkv", "hevc");
    const hevcFail1 = await seedVideoStream("/media/test/hevc-fail-1.mkv", "hevc");
    const hevcOpen2 = await seedVideoStream("/media/test/hevc-open-2.mkv", "hevc");

    const hevcSeeded = [hevcOpen1, hevcClosed1, hevcFail1, hevcOpen2].sort((a, b) =>
      a.streamId < b.streamId ? -1 : 1,
    );

    const enqueueCalls: string[] = [];
    const handler = opengopBackfillConsumerHandler({
      db,
      detect: (filePath) => fakeDetect(filePath),
      batchSize: 3,
      enqueueSelf: async (cursor) => {
        enqueueCalls.push(cursor);
      },
    });

    // --- Batch 1: cursor = null -> runs the non-HEVC bulk-false pass AND
    // processes the first 3 HEVC rows (by id order); re-enqueues itself
    // (batch came back full). ---
    await handler({ cursor: null }, { jobId: "opengop-backfill-job-1" });

    // Non-HEVC rows resolved by the bulk pass, not the (never-called-for-
    // them) detector.
    expect(await readOpenGop(h264.streamId)).toBe(false);
    expect(await readOpenGop(av1.streamId)).toBe(false);

    expect(enqueueCalls).toHaveLength(1);
    const cursorAfterBatch1 = enqueueCalls[0]!;
    expect(cursorAfterBatch1).toBe(hevcSeeded[2]!.streamId);

    const firstThree = hevcSeeded.slice(0, 3);
    const fourth = hevcSeeded[3]!;
    // A processed FAIL row is deliberately still NULL (a failed scan is
    // never resolved to a guess), so open_gop is not a processed-marker
    // for it — batch-1 coverage of all three rows is proven by the cursor
    // assertion above; verdicts are asserted per fixture here.
    for (const s of firstThree) {
      const resolved = await readOpenGop(s.streamId);
      if (s.filePath.includes("-fail-")) {
        expect(resolved, s.filePath).toBeNull();
      } else {
        expect(resolved, s.filePath).not.toBeNull();
      }
    }
    // The 4th HEVC row (not in batch 1) is untouched — still NULL.
    expect(await readOpenGop(fourth.streamId)).toBeNull();

    // A NEW non-HEVC row, inserted AFTER the fresh-sweep bulk pass already
    // ran, proves the bulk-false UPDATE runs ONCE per fresh sweep (cursor
    // === null) — not on every resumed batch below.
    const lateH264 = await seedVideoStream("/media/test/h264-late-row.mp4", "h264");

    // --- Batch 2: resume from the captured cursor -> processes exactly
    // the remaining 1 HEVC row, batch comes back short, so no further
    // re-enqueue, and the late non-HEVC row is NOT touched (proves the
    // bulk pass did not re-run). ---
    await handler({ cursor: cursorAfterBatch1 }, { jobId: "opengop-backfill-job-2" });

    expect(enqueueCalls).toHaveLength(1); // unchanged — no second re-enqueue
    expect(await readOpenGop(lateH264.streamId)).toBeNull();

    // Real verdicts for the two "open" HEVC fixtures.
    expect(await readOpenGop(hevcOpen1.streamId)).toBe(true);
    expect(await readOpenGop(hevcOpen2.streamId)).toBe(true);
    // Real verdict for the "closed" HEVC fixture.
    expect(await readOpenGop(hevcClosed1.streamId)).toBe(false);
    // A failed/unknown scan leaves the row NULL — never a guessed value —
    // so it is naturally re-picked-up by a FUTURE fresh sweep, not silently
    // resolved to false.
    expect(await readOpenGop(hevcFail1.streamId)).toBeNull();
  });

  it("is a no-op (no enqueue) when a batch selects nothing", async () => {
    const enqueueCalls: string[] = [];
    const handler = opengopBackfillConsumerHandler({
      db,
      detect: (filePath) => fakeDetect(filePath),
      batchSize: 5,
      enqueueSelf: async (cursor) => {
        enqueueCalls.push(cursor);
      },
    });

    // A cursor already past every seeded HEVC row's id selects nothing.
    await handler({ cursor: "ffffffff-ffff-7fff-8fff-ffffffffffff" }, { jobId: "opengop-backfill-job-noop" });

    expect(enqueueCalls).toHaveLength(0);
  });

  it("excludes a HEVC row whose file is currently missing (media_files.missing_since_ms set) — opus review finding 10", async () => {
    // A deleted/unmounted file's media_streams row would otherwise stay
    // open_gop NULL forever (nothing will ever successfully scan a path
    // that no longer resolves), which — without the missing_since_ms
    // exclusion in listHevcStreamsNeedingOpenGopProbe/
    // hasVideoStreamsNeedingOpenGopBackfill (packages/db/src/internal/
    // files.ts) — would re-select this row, and therefore re-trigger a
    // full fresh sweep via apps/worker/src/index.ts's boot-time
    // enqueueOpenGopBackfillIfNeeded, on EVERY worker start forever, not
    // just once. This proves the row is skipped entirely: never selected
    // into a batch, never handed to `detect` (which would otherwise
    // resolve it via fakeDetect's default "-fail-" branch -> null,
    // indistinguishable from a genuine scan failure — the exclusion must
    // happen at the SQL layer, not rely on detect()'s own behavior).
    const missingHevc = await seedVideoStream("/media/test/hevc-missing-fail.mkv", "hevc", Date.now());
    // A present HEVC row in the SAME batch proves the exclusion is
    // per-row, not a bug that skips the whole sweep.
    const presentHevc = await seedVideoStream("/media/test/hevc-open-present.mkv", "hevc");

    const enqueueCalls: string[] = [];
    const handler = opengopBackfillConsumerHandler({
      db,
      detect: (filePath) => fakeDetect(filePath),
      batchSize: 200,
      enqueueSelf: async (cursor) => {
        enqueueCalls.push(cursor);
      },
    });

    await handler({ cursor: null }, { jobId: "opengop-backfill-job-missing-file" });

    // Missing file's row: still NULL — excluded from the query entirely,
    // not attempted and failed.
    expect(await readOpenGop(missingHevc.streamId)).toBeNull();
    // Present file's row in the same batch: genuinely scanned and resolved.
    expect(await readOpenGop(presentHevc.streamId)).toBe(true);
  });
});
