// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/oshash.spec.ts
//
// Byte-compatibility proof for apps/worker/src/stash/oshash.ts against
// Stash's own algorithm (STATE.md S4/K6 — "verify the exact algorithm from
// Stash's source so hashes are byte-compatible; implement it cleanly
// yourself, do not vendor their code"). This is the well-known
// "OpenSubtitles hash": uint64-little-endian-chunk-sum of the first 64KB
// plus the last 64KB plus the file size, mod 2^64, formatted as a
// lowercase 16-hex-digit string.
//
// Test vectors cited verbatim from Stash's own test suite —
// pkg/hash/oshash/oshash_test.go, https://github.com/stashapp/stash,
// fetched from https://raw.githubusercontent.com/stashapp/stash/develop/pkg/hash/oshash/oshash_test.go
// (develop HEAD, schema 85, 2026-07-31): these are the SAME vectors
// Stash's own CI proves its Go implementation against — matching them
// byte-for-byte is the strongest available proof of compatibility without
// a real Stash-produced fixture file.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeOshashForFile, computeOshashFromBuffers } from "../../src/stash/oshash.js";

describe("computeOshashFromBuffers (pure, upstream test vectors)", () => {
  it("hashes an 11-byte input ('hello world') to the upstream-verified value", () => {
    // fileSize=11 < 64KB chunk size, so Stash truncates its chunk size to
    // floor(11/8)*8 = 8 and reads head=first 8 bytes, tail=last 8 bytes
    // (overlapping — both drawn from the same 11-byte file). This test
    // exercises the LOWER-LEVEL pure hasher directly with those exact
    // 8-byte head/tail slices, so it does not depend on
    // computeOshashForFile's own truncation logic being correct yet —
    // that is proven separately below via a real file.
    const buf = Buffer.from("hello world", "ascii");
    const head = buf.subarray(0, 8);
    const tail = buf.subarray(buf.length - 8);
    expect(computeOshashFromBuffers(head, tail, buf.length)).toBe("d3e392dee38cd4df");
  });

  it("hashes a >64KB input (458752 bytes) to the upstream-verified value", () => {
    // Reproduces Go's makeByteArray("this is a test", 15): start from the
    // 14-byte string and double it 15 times (14 * 2^15 = 458752 bytes).
    let buf = Buffer.from("this is a test", "ascii");
    for (let i = 0; i < 15; i++) {
      buf = Buffer.concat([buf, buf]);
    }
    expect(buf.length).toBe(458752);
    const head = buf.subarray(0, 64 * 1024);
    const tail = buf.subarray(buf.length - 64 * 1024);
    expect(computeOshashFromBuffers(head, tail, buf.length)).toBe("6a0eba04654d0b9b");
  });
});

describe("computeOshashForFile (real file I/O, small + large)", () => {
  let dir: string;

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeFile(name: string, contents: Buffer): string {
    if (!dir) dir = mkdtempSync(path.join(tmpdir(), "loombre-oshash-"));
    const filePath = path.join(dir, name);
    writeFileSync(filePath, contents);
    return filePath;
  }

  it("matches the pure-buffer result for an 11-byte file", async () => {
    const filePath = makeFile("hello-world.txt", Buffer.from("hello world", "ascii"));
    await expect(computeOshashForFile(filePath)).resolves.toBe("d3e392dee38cd4df");
  });

  it("matches the pure-buffer result for a >64KB file", async () => {
    let buf = Buffer.from("this is a test", "ascii");
    for (let i = 0; i < 15; i++) {
      buf = Buffer.concat([buf, buf]);
    }
    const filePath = makeFile("big.bin", buf);
    await expect(computeOshashForFile(filePath)).resolves.toBe("6a0eba04654d0b9b");
  });

  it("rejects a file of 8 bytes or fewer, matching Stash's own documented floor", async () => {
    const filePath = makeFile("tiny.bin", Buffer.from("hello", "ascii")); // 5 bytes
    await expect(computeOshashForFile(filePath)).rejects.toThrow(/size/i);
  });

  it("produces a lowercase, zero-padded 16-hex-digit string for an exact-64KB-boundary file", async () => {
    // A file exactly at the 64KB chunk boundary exercises the "head and
    // tail are non-overlapping and each exactly one full chunk" path.
    const buf = Buffer.alloc(128 * 1024, 0x42);
    const filePath = makeFile("boundary.bin", buf);
    const hash = await computeOshashForFile(filePath);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
