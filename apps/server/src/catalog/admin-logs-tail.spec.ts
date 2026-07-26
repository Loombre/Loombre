// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/admin-logs-tail.spec.ts
//
// Correctness (matches a real last-N-lines tail) AND the efficiency claim
// itself: against a big generated fixture, `tailFileLines` must not read
// anywhere close to the whole file — proven by counting real `.read()`
// syscalls via a wrapped FileHandle, not by inference.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, createWriteStream } from "node:fs";
import { open as realOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailFileLines, tailLogFile, type OpenLike } from "./admin-logs-tail.js";

const dirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loombre-admin-logtail-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Wraps the real `open` so tests can count how many `.read()` calls a
 *  tail actually issues against the returned handle. */
function countingOpen(counter: { calls: number }): OpenLike {
  return async (path, flags) => {
    const handle = await realOpen(path, flags);
    const originalRead = handle.read.bind(handle);
    // Test-only monkeypatch of a subset of the real overloaded `.read()`
    // signature; only the (buffer, offset, length, position) form this
    // module ever calls is exercised.
    handle.read = async (...args: unknown[]) => {
      counter.calls += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalRead as any)(...args);
    };
    return handle;
  };
}

async function writeLines(path: string, lines: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path);
    stream.on("error", reject);
    stream.on("finish", resolve);
    for (const line of lines) stream.write(line + "\n");
    stream.end();
  });
}

describe("tailFileLines correctness", () => {
  it("returns [] for an empty file", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "empty.log");
    await writeLines(path, []);
    expect(await tailFileLines(path, 10)).toEqual([]);
  });

  it("returns every line when the file has fewer lines than requested", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "short.log");
    await writeLines(path, ["a", "b", "c"]);
    expect(await tailFileLines(path, 10)).toEqual(["a", "b", "c"]);
  });

  it("returns exactly the last N lines, in order, for a file spanning several read chunks", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "many.log");
    const allLines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    await writeLines(path, allLines);

    // Tiny chunk size forces MANY chunk reads even for a modest file, so
    // this proves the chunk-boundary bookkeeping (a line split across two
    // chunks) is correct, not just the happy "one chunk" path.
    const result = await tailFileLines(path, 25, { chunkSizeBytes: 37 });
    expect(result).toEqual(allLines.slice(-25));
  });

  it("preserves a final line with no trailing newline", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "no-trailing-newline.log");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "one\ntwo\nthree");
    expect(await tailFileLines(path, 10)).toEqual(["one", "two", "three"]);
  });

  it("maxLines <= 0 returns []", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "x.log");
    await writeLines(path, ["a", "b"]);
    expect(await tailFileLines(path, 0)).toEqual([]);
  });
});

describe("tailFileLines efficiency (big-file fixture — must NOT read the whole file)", () => {
  it("reads a small, bounded number of chunks from a large multi-MB file, regardless of file size", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "big.log");
    // ~8 MB fixture: 200,000 lines of ~40 bytes each. Real installs run to
    // multi-GB; this fixture is sized for CI speed while still being
    // orders of magnitude larger than any bounded-read budget.
    const lineCount = 200_000;
    const lines = Array.from(
      { length: lineCount },
      (_, i) => `2026-07-24T00:00:00.000Z INFO line number ${i} of the fixture`,
    );
    await writeLines(path, lines);

    const counter = { calls: 0 };
    const result = await tailFileLines(path, 200, { open: countingOpen(counter) });

    expect(result).toEqual(lines.slice(-200));
    // Default 64 KiB chunks: 200 lines of ~60 bytes is ~12 KB, comfortably
    // inside a couple of chunks. Bound generously (a handful of reads) so
    // this fails loudly if a future change regresses to reading the whole
    // 8 MB file (which would take thousands of 64 KiB reads, or one huge
    // one) instead of seeking from the end.
    expect(counter.calls, `expected a small bounded number of chunk reads, got ${counter.calls}`).toBeLessThan(10);
  });

  it("chunk-read count scales with lines requested, not with file size", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "big2.log");
    const lines = Array.from({ length: 300_000 }, (_, i) => `line ${i} `.padEnd(50, "x"));
    await writeLines(path, lines);

    const smallCounter = { calls: 0 };
    await tailFileLines(path, 10, { open: countingOpen(smallCounter), chunkSizeBytes: 4096 });

    const bigCounter = { calls: 0 };
    await tailFileLines(path, 5000, { open: countingOpen(bigCounter), chunkSizeBytes: 4096 });

    expect(smallCounter.calls).toBeLessThan(bigCounter.calls);
    // 5000 lines * ~50B / 4096B chunks is ~61 chunks — neither comes
    // anywhere close to the ~3600 chunks (300_000 * 50B / 4096B) a
    // whole-file read would take.
    expect(bigCounter.calls).toBeLessThan(100);
  });
});

describe("tailLogFile (GET /admin/logs/tail resolution)", () => {
  it("null/unset LOOMBRE_LOG_FILE -> honest null source, empty lines, no filesystem touched", async () => {
    expect(await tailLogFile(undefined, 200)).toEqual({ source: null, lines: [] });
    expect(await tailLogFile("", 200)).toEqual({ source: null, lines: [] });
    expect(await tailLogFile("   ", 200)).toEqual({ source: null, lines: [] });
  });

  it("configured but nonexistent path -> source set (basename), lines empty — never throws", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "not-yet-created.log");
    expect(await tailLogFile(path, 200)).toEqual({ source: "not-yet-created.log", lines: [] });
  });

  it("configured + real file -> source is the basename, lines are the real tail", async () => {
    const dir = makeTmpDir();
    const path = join(dir, "service.log");
    await writeLines(path, ["one", "two", "three", "four"]);
    expect(await tailLogFile(path, 2)).toEqual({ source: "service.log", lines: ["three", "four"] });
  });
});
