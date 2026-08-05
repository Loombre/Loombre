// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/resumed-counters.spec.ts
//
// EXIT-GATE TEST (AUD-A2d-003, Fix Wave 2 FW2-E): scan.completed's
// itemsAdded/itemsUpdated/itemsRemoved must report the TOTAL across every
// attempt of a resumed job, not just the last attempt's own work — the
// counters are the record an admin/the web UI trusts about what a scan
// actually did, and a resumed attempt (same job.id, pg-boss retry) starts
// them at zero every time today.
//
// Two REAL runScan() calls share the SAME job id, so the second is a
// genuine checkpoint-resume (not a fresh scan): attempt 1 walks a small
// tree to completion (creating one item outright, adding a second version
// to another, and discovering a pre-existing file has gone missing);
// between attempts, more files are added/removed on disk, all sorted to
// land AFTER attempt 1's checkpoint (so they are genuinely processed, not
// skipped by the resume fast-forward — see resume.spec.ts for that
// mechanism). Every assertion reads the emitted scan.completed payload
// from the events table, never scanner internals.

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/scanner.js";
import { hashFile } from "../../src/scan/identity/hash.js";
import type { HashPoolLike } from "../../src/scan/scanner.js";
import { createLibrary, makeDb, makeMemoryQueue, makeRawClient, makeTmpLibraryDir, resetSchema, writeFakeMediaFile } from "./helpers.js";

/** Plain (non-pooled, in-thread) hashing — these tests care about counter
 *  bookkeeping, not hash-pool concurrency (already covered elsewhere). */
const hashPool: HashPoolLike = {
  hashFile(filePath: string, sizeBytes: number) {
    return hashFile(filePath, sizeBytes);
  },
};

interface ScanCompletedPayload {
  itemsAdded: number;
  itemsUpdated: number;
  itemsRemoved: number;
}

describe("scanner: scan.completed counters across a resumed attempt (exit gate)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let libraryId: string;
  let libraryDir: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    libraryDir = makeTmpLibraryDir("resumed-counters");
    libraryId = await createLibrary(raw, { name: "Resumed Counters Library", mediaKind: "movie", paths: [libraryDir] });
  });

  afterAll(async () => {
    await dbHandle.destroy();
    await raw.end();
  });

  async function scanCompletedPayloads(jobId: string): Promise<ScanCompletedPayload[]> {
    // UUIDv7 `id` is time-sortable — ORDER BY id gives attempt order
    // without depending on ts_ms not colliding across two fast attempts.
    const result = await raw.query<{ payload: ScanCompletedPayload }>(
      "SELECT payload FROM events WHERE type = 'scan.completed' AND payload->>'jobId' = $1 ORDER BY id",
      [jobId]
    );
    return result.rows.map((r) => r.payload);
  }

  it("sums itemsAdded/itemsUpdated/itemsRemoved across both attempts, not just the second", async () => {
    const resumeJobId = "018f0006-0000-7000-8000-000000000001";

    // --- Setup (a DIFFERENT, earlier job): one file that will already be
    // gone from disk by the time the job under test starts, so attempt 1's
    // full-mode sweep discovers a genuine pre-existing removal. ---
    const zeroPath = join(libraryDir, "Movie Zero (2000).mkv");
    writeFakeMediaFile(zeroPath, "zero", 256);
    const { queue: setupQueue } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue: setupQueue, hashPool },
      { libraryId, full: true },
      { jobId: "018f0006-0000-7000-8000-000000000000" }
    );
    unlinkSync(zeroPath);

    // --- Attempt 1: two "Movie One" files (a Director's Cut + the plain
    // release — the DIRECTOR'S CUT FILENAME SORTS FIRST, since a
    // space/underscore-delimited suffix always sorts before the bare
    // "Title (Year).mkv" it's a version of — see movie.ts's parser: both
    // resolve to the SAME title+year, so the second one processed lands as
    // itemsUpdated, not itemsAdded) plus one standalone "Movie Two". Walk
    // order (alphabetical) makes "Movie Two (2002).mkv" the LAST file, so
    // that becomes the checkpoint's last_processed_path. ---
    const oneDirectorsCutPath = join(libraryDir, "Movie One (2001) - Director's Cut.mkv");
    const onePlainPath = join(libraryDir, "Movie One (2001).mkv");
    const twoPath = join(libraryDir, "Movie Two (2002).mkv");
    writeFakeMediaFile(oneDirectorsCutPath, "one-dc", 256);
    writeFakeMediaFile(onePlainPath, "one-plain", 256);
    writeFakeMediaFile(twoPath, "two", 256);

    const { queue: q1 } = makeMemoryQueue();
    await runScan({ db: dbHandle, queue: q1, hashPool }, { libraryId, full: true }, { jobId: resumeJobId });

    const [attempt1] = await scanCompletedPayloads(resumeJobId);
    expect(attempt1, "attempt 1 must have emitted scan.completed").toBeDefined();
    // Sanity on attempt 1 itself: "Movie One" created once + updated once
    // (two files, same title+year), "Movie Two" created, "Movie Zero"'s
    // file discovered missing.
    expect(attempt1!.itemsAdded).toBe(2);
    expect(attempt1!.itemsUpdated).toBe(1);
    expect(attempt1!.itemsRemoved).toBe(1);

    // --- Between attempts: remove a file this SAME job already counted in
    // attempt 1 (NOT the checkpoint's last_processed_path — deleting that
    // one would break resume's own fast-forward match, a different,
    // pre-existing concern this test does not exercise), and add two more
    // files that sort AFTER "Movie Two (2002).mkv" so they are genuinely
    // processed on resume rather than skipped by the fast-forward. ---
    unlinkSync(onePlainPath);
    const twoV2Path = join(libraryDir, "Movie Two (2002)_v2.mkv"); // sorts AFTER "...2002).mkv" ('_' > '.')
    const zzzPath = join(libraryDir, "Movie Zzz (2004).mkv");
    writeFakeMediaFile(twoV2Path, "two-v2", 256);
    writeFakeMediaFile(zzzPath, "zzz", 256);

    // --- Attempt 2: SAME job id — a genuine checkpoint resume. ---
    const { queue: q2 } = makeMemoryQueue();
    await runScan({ db: dbHandle, queue: q2, hashPool }, { libraryId, full: true }, { jobId: resumeJobId });

    const payloads = await scanCompletedPayloads(resumeJobId);
    expect(payloads).toHaveLength(2);
    const attempt2 = payloads[1]!;

    // Attempt 2's OWN fresh work: "Movie Zzz" created (+1 added), "Movie
    // Two" gets its v2 file (+1 updated), "Movie One"'s plain file is now
    // missing (+1 removed). None of this depends on internal state — it's
    // exactly what a from-scratch scan of attempt 2's own delta would
    // report. The bug (AUD-A2d-003): today this IS what scan.completed
    // reports, silently dropping attempt 1's totals.
    //
    // The fix: the reported totals must be the SUM of both attempts.
    expect(attempt2.itemsAdded, "itemsAdded must sum both attempts (2 + 1), not just attempt 2's own 1").toBe(3);
    expect(attempt2.itemsUpdated, "itemsUpdated must sum both attempts (1 + 1), not just attempt 2's own 1").toBe(2);
    expect(attempt2.itemsRemoved, "itemsRemoved must sum both attempts (1 + 1), not just attempt 2's own 1").toBe(2);
  }, 30_000);
});
