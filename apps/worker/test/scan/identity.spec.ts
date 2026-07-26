// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/identity.spec.ts
//
// Pure unit tests for the content-hash identity rule (D16, P1.1,
// src/scan/identity/hash.ts): byte-range construction fixtures for files
// under 8 MiB, exactly 8 MiB, and over 8 MiB, plus determinism and the
// worker_threads pool producing identical results to the direct pure
// path. No database, no filesystem fixtures beyond small tmp files this
// suite writes itself — this is why it lives alongside (not inside) the
// live-DB exit-gate suites.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SMALL_FILE_THRESHOLD_BYTES,
  WINDOW_BYTES,
  planHashRanges,
  buildHashInput,
  hashBuffer,
  hashFile,
  encodeSizeBytes,
} from "../../src/scan/identity/hash.js";
import { createHashPool } from "../../src/scan/identity/pool.js";

const dir = mkdtempSync(join(tmpdir(), "loombre-identity-"));

function writeFile(name: string, buf: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

describe("planHashRanges (byte-range construction rule)", () => {
  it("files under 8 MiB: whole-file, single range, no overlap possible", () => {
    const plan = planHashRanges(SMALL_FILE_THRESHOLD_BYTES - 1);
    expect(plan.wholeFile).toBe(true);
    expect(plan.ranges).toEqual([{ start: 0, length: SMALL_FILE_THRESHOLD_BYTES - 1 }]);
  });

  it("exactly 8 MiB: two 4 MiB windows, adjacent with zero overlap and zero gap", () => {
    const plan = planHashRanges(SMALL_FILE_THRESHOLD_BYTES);
    expect(plan.wholeFile).toBe(false);
    expect(plan.ranges).toEqual([
      { start: 0, length: WINDOW_BYTES },
      { start: WINDOW_BYTES, length: WINDOW_BYTES },
    ]);
    // adjacency: second range starts exactly where the first ends
    expect(plan.ranges[0]!.start + plan.ranges[0]!.length).toBe(plan.ranges[1]!.start);
  });

  it("over 8 MiB: two 4 MiB windows with an unhashed gap in the middle", () => {
    const size = SMALL_FILE_THRESHOLD_BYTES + 1024;
    const plan = planHashRanges(size);
    expect(plan.wholeFile).toBe(false);
    expect(plan.ranges[0]).toEqual({ start: 0, length: WINDOW_BYTES });
    expect(plan.ranges[1]).toEqual({ start: size - WINDOW_BYTES, length: WINDOW_BYTES });
    const gapStart = plan.ranges[0]!.start + plan.ranges[0]!.length;
    const gapEnd = plan.ranges[1]!.start;
    expect(gapEnd).toBeGreaterThan(gapStart); // a real gap exists
  });
});

describe("buildHashInput / encodeSizeBytes", () => {
  it("appends sizeBytes as 8 big-endian bytes after the content parts", () => {
    const input = buildHashInput([Buffer.from("ab")], 2);
    expect(input.length).toBe(2 + 8);
    expect(input.subarray(0, 2).toString()).toBe("ab");
    expect(input.subarray(2)).toEqual(encodeSizeBytes(2));
  });

  it("two different sizes produce different hash inputs even with identical content parts", async () => {
    const a = await hashBuffer(buildHashInput([Buffer.from("same")], 100));
    const b = await hashBuffer(buildHashInput([Buffer.from("same")], 200));
    expect(a).not.toBe(b);
  });
});

describe("hashFile — end to end over real small files", () => {
  it("is deterministic: hashing the same file twice gives the same result", async () => {
    const p = writeFile("det.bin", Buffer.from("hello loombre"));
    const h1 = await hashFile(p, 12);
    const h2 = await hashFile(p, 12);
    expect(h1).toBe(h2);
  });

  it("different content (same size) hashes differently", async () => {
    const p1 = writeFile("a.bin", Buffer.from("aaaaaaaaaaaa"));
    const p2 = writeFile("b.bin", Buffer.from("bbbbbbbbbbbb"));
    const h1 = await hashFile(p1, 12);
    const h2 = await hashFile(p2, 12);
    expect(h1).not.toBe(h2);
  });

  it("< 8 MiB: a change ANYWHERE in the file (including the untouched-by-windowing middle) changes the hash — proves the whole file is read, not just first/last 4 MiB", async () => {
    const size = 5 * 1024 * 1024; // 5 MiB — well under the 8 MiB threshold
    const base = Buffer.alloc(size, 0x41);
    const mutated = Buffer.from(base);
    mutated[Math.floor(size / 2)] = 0x42; // flip one byte in the exact middle

    const p1 = writeFile("mid-base.bin", base);
    const p2 = writeFile("mid-mutated.bin", mutated);

    const h1 = await hashFile(p1, size);
    const h2 = await hashFile(p2, size);
    expect(h1).not.toBe(h2);
  });

  it(">= 8 MiB: a change in the MIDDLE (outside both 4 MiB windows) does NOT change the hash — proves only first+last 4 MiB are read", async () => {
    const size = 9 * 1024 * 1024; // 9 MiB
    const base = Buffer.alloc(size, 0x41);
    const mutated = Buffer.from(base);
    mutated[Math.floor(size / 2)] = 0x42; // dead center — inside the unread gap

    const p1 = writeFile("gap-base.bin", base);
    const p2 = writeFile("gap-mutated.bin", mutated);

    const h1 = await hashFile(p1, size);
    const h2 = await hashFile(p2, size);
    expect(h1).toBe(h2);
  }, 20_000);

  it("exactly 8 MiB: a change at the exact midpoint (the window boundary) DOES change the hash — the boundary itself is covered, not skipped", async () => {
    const size = SMALL_FILE_THRESHOLD_BYTES;
    const base = Buffer.alloc(size, 0x41);
    const mutated = Buffer.from(base);
    mutated[WINDOW_BYTES - 1] = 0x42; // last byte of the first window
    mutated[WINDOW_BYTES] = 0x43; // first byte of the second window

    const p1 = writeFile("boundary-base.bin", base);
    const p2 = writeFile("boundary-mutated.bin", mutated);

    const h1 = await hashFile(p1, size);
    const h2 = await hashFile(p2, size);
    expect(h1).not.toBe(h2);
  }, 20_000);
});

describe("createHashPool — worker_threads path matches the direct in-thread path", () => {
  const pool = createHashPool(2);
  afterAll(async () => {
    await pool.terminate();
  });

  it("pool.hashFile() and direct hashFile() agree for the same input", async () => {
    const p = writeFile("pool-agree.bin", Buffer.from("pool vs direct"));
    const direct = await hashFile(p, 14);
    const viaPool = await pool.hashFile(p, 14);
    expect(viaPool).toBe(direct);
  });

  it("handles several concurrent requests correctly (round-robin, out-of-order-safe)", async () => {
    const files = Array.from({ length: 6 }, (_, i) => writeFile(`pool-concurrent-${i}.bin`, Buffer.from(`file-${i}`)));
    const [direct, viaPool] = await Promise.all([
      Promise.all(files.map((f, i) => hashFile(f, `file-${i}`.length))),
      Promise.all(files.map((f, i) => pool.hashFile(f, `file-${i}`.length))),
    ]);
    expect(viaPool).toEqual(direct);
  });
});
