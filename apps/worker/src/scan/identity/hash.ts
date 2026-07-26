// SPDX-License-Identifier: AGPL-3.0-only
/**
 * File-identity hashing — docs/PLAN.md §5, §8.2 (D16, P1.1): "content_hash =
 * xxHash3-64 of first 4 MiB + last 4 MiB + sizeBytes".
 *
 * DECISION (flagged, dependency mismatch): the mandated dependency is
 * `xxhash-wasm` (already a worker devDependency per the task's "no new
 * deps" constraint), but xxhash-wasm@1.1.0 implements only the classic
 * XXH32/XXH64 algorithms — it does NOT expose XXH3 (verified against its
 * shipped `types.d.ts`: `h32`/`h32Raw`/`create32` and `h64`/`h64Raw`/
 * `create64` only, no `h3*` export of any kind). Since no new dependency is
 * permitted, this module hashes with XXH64 (`h64Raw`) instead of XXH3-64.
 * This is a same-family substitution (both are content-hash-only identity
 * primitives, not cryptographic, not exposed to any API surface — see
 * media_files.content_hash's column comment) and does not change any of the
 * byte-range construction rules below, which are exactly what P1.1
 * specifies. Recorded here per STATE.md's "audit mismatch" convention
 * (mirrors P1.10/P1.11's precedent for spec-vs-reality gaps found during
 * implementation).
 *
 * Byte-range construction (exact rule, fixture-tested — see
 * test/scan/identity.spec.ts):
 *   - `sizeBytes < 8 MiB` (SMALL_FILE_THRESHOLD_BYTES): hash the file's
 *     ENTIRE contents exactly once. A first-4-MiB + last-4-MiB read for a
 *     file under 8 MiB would overlap in the middle and double-count those
 *     bytes in the hash input, which is the "no overlap double-count" rule
 *     the task calls out — so this size class is a distinct code path
 *     rather than a degenerate case of the windowed read below.
 *   - `sizeBytes >= 8 MiB`: hash exactly [first 4 MiB] + [last 4 MiB]
 *     (spliced back-to-back, NOT the bytes in between). At exactly 8 MiB
 *     the two windows are adjacent with zero overlap and zero gap — this
 *     is what makes 8 MiB the threshold, not an arbitrary round number.
 *   - In both cases, `sizeBytes` itself is appended to the hash input as an
 *     8-byte big-endian unsigned integer (mirrors the big-endian convention
 *     packages/shared/src/ids.ts already uses for UUIDv7's timestamp
 *     bytes) — this is what makes two same-content-prefix/suffix files of
 *     different lengths (e.g. a truncated download) hash differently even
 *     if a 4 MiB window alone wouldn't observe the difference.
 *
 * This module is intentionally split into a pure part (`buildHashInput`,
 * `hashBuffer`) and an I/O part (`readHashInputRanges`, `hashFile`) so the
 * byte-construction rule can be unit-tested against in-memory buffers
 * without a filesystem, while `hashFile` is what the scanner and the
 * worker_threads pool (./pool.ts, ./hash-worker.ts) actually call.
 */
import { open } from "node:fs/promises";
import xxhash from "xxhash-wasm";
import type { XXHashAPI } from "xxhash-wasm";

export const SMALL_FILE_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MiB
export const WINDOW_BYTES = 4 * 1024 * 1024; // 4 MiB

let apiPromise: Promise<XXHashAPI> | undefined;
function getApi(): Promise<XXHashAPI> {
  apiPromise ??= xxhash();
  return apiPromise;
}

/** 8-byte big-endian encoding of `sizeBytes`, appended to every hash input
 * (see module docstring). `sizeBytes` is always well within Number.
 * MAX_SAFE_INTEGER for any real media file, so a plain bigint conversion is
 * safe. */
export function encodeSizeBytes(sizeBytes: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(sizeBytes));
  return buf;
}

/**
 * Pure: given the already-read file-content buffer(s) and the file's total
 * size, builds the exact byte sequence that gets hashed. `parts` is either
 * `[wholeFile]` (small-file path) or `[first4MiB, last4MiB]`
 * (windowed path) — this function just concatenates + appends the size, it
 * does not decide which path applies (see `planHashRanges`).
 */
export function buildHashInput(parts: Buffer[], sizeBytes: number): Buffer {
  return Buffer.concat([...parts, encodeSizeBytes(sizeBytes)]);
}

export interface HashRangePlan {
  /** true when the whole file is read as a single part (sizeBytes < 8 MiB). */
  wholeFile: boolean;
  /** Byte ranges to read, in the order they must be concatenated. */
  ranges: Array<{ start: number; length: number }>;
}

/** Decides which byte ranges `hashFile`/the worker thread must read, per
 * the module docstring's threshold rule. Pure — no I/O. */
export function planHashRanges(sizeBytes: number): HashRangePlan {
  if (sizeBytes < SMALL_FILE_THRESHOLD_BYTES) {
    return { wholeFile: true, ranges: [{ start: 0, length: sizeBytes }] };
  }
  return {
    wholeFile: false,
    ranges: [
      { start: 0, length: WINDOW_BYTES },
      { start: sizeBytes - WINDOW_BYTES, length: WINDOW_BYTES },
    ],
  };
}

/** Hashes an already-built input buffer with XXH64 (see module docstring's
 * DECISION note), returning a zero-padded lowercase 16-hex-char string. */
export async function hashBuffer(input: Buffer): Promise<string> {
  const api = await getApi();
  // Buffer is a Uint8Array subclass, so it satisfies h64Raw's input type
  // directly — no extra view/copy needed.
  const digest = api.h64Raw(input);
  return digest.toString(16).padStart(16, "0");
}

/** Reads exactly the byte ranges `planHashRanges` prescribes for a file of
 * `sizeBytes`, without ever buffering the whole file when it isn't the
 * small-file path (bounded to 2 * WINDOW_BYTES = 8 MiB resident at once,
 * regardless of how large the file on disk is). */
export async function readHashInputRanges(filePath: string, sizeBytes: number): Promise<Buffer[]> {
  const plan = planHashRanges(sizeBytes);
  if (plan.ranges.length === 0 || sizeBytes === 0) return [Buffer.alloc(0)];

  const fh = await open(filePath, "r");
  try {
    const parts: Buffer[] = [];
    for (const range of plan.ranges) {
      if (range.length <= 0) continue;
      const buf = Buffer.alloc(range.length);
      const { bytesRead } = await fh.read(buf, 0, range.length, range.start);
      parts.push(bytesRead === range.length ? buf : buf.subarray(0, bytesRead));
    }
    return parts;
  } finally {
    await fh.close();
  }
}

/** Full I/O + hash pipeline for one file: read the prescribed byte ranges,
 * build the hash input, hash it. This is what runs inside a worker thread
 * (./hash-worker.ts) — CPU-light (xxhash is fast even over 8 MiB) but kept
 * off the main thread per CLAUDE.md invariant 9 / docs/PLAN.md §9.2's
 * worker_threads mandate for hashing. */
export async function hashFile(filePath: string, sizeBytes: number): Promise<string> {
  const parts = await readHashInputRanges(filePath, sizeBytes);
  return hashBuffer(buildHashInput(parts, sizeBytes));
}
