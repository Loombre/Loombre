// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/oshash.ts
//
// Byte-compatible reimplementation of Stash's "oshash" fingerprint (STATE.md
// S4/K6) — the well-known OpenSubtitles hash: uint64-little-endian-chunk-sum
// of the first 64KB plus the last 64KB of a file, plus the file's size
// (mod 2^64), formatted as a lowercase, zero-padded 16-hex-digit string.
// Clean-room implementation from the documented algorithm — Stash's own Go
// source (pkg/hash/oshash/oshash.go, github.com/stashapp/stash, develop
// HEAD @ schema 85, fetched 2026-08-01) was read to VERIFY the exact
// chunking/truncation/error-floor behavior below, never copied
// (LICENSE-INTENT.md's "no copied third-party code without provenance"
// rule does not apply — this is an independent implementation of a public,
// well-known hashing algorithm, the same one Stash itself reimplements).
// Byte-compatibility is proven in test/stash/oshash.spec.ts against
// Stash's own published test vectors (pkg/hash/oshash/oshash_test.go).
//
// Used two ways (S4 "secondary = size + Stash's oshash where present;
// compute oshash on Loombre's side LAZILY only for unmatched candidates"):
//   - computeOshashFromBuffers: the pure hash core, used directly in tests
//     and by computeOshashForFile below.
//   - computeOshashForFile: real file I/O (reads only the first/last 64KB
//     — never the whole file — off the LOOMBRE side of a match candidate),
//     called lazily by apps/worker/src/stash/matching.ts only for files
//     whose size already matches a candidate Stash scene's stash_size_bytes.

import { open, stat } from 'node:fs/promises';

const CHUNK_SIZE = 64 * 1024;
const UINT64_MASK = (1n << 64n) - 1n;

/**
 * Sums `buf` as consecutive little-endian uint64 chunks, wrapping mod 2^64
 * (matches Go's unchecked uint64 overflow). Throws if `buf.length` is not
 * a multiple of 8 — every caller below hands this function a buffer it has
 * already sized to a multiple of 8, so this is a programming-error guard,
 * not a data-validation path.
 */
function sumUint64LEChunks(buf: Buffer | Uint8Array): bigint {
  if (buf.length % 8 !== 0) {
    throw new Error(`oshash: buffer length ${buf.length} is not a multiple of 8`);
  }
  let sum = 0n;
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let offset = 0; offset < view.length; offset += 8) {
    sum = (sum + view.readBigUInt64LE(offset)) & UINT64_MASK;
  }
  return sum;
}

/**
 * The pure oshash core: `head` and `tail` must already be sized to
 * whatever chunk size applies (64KB for files >= 64KB, or the
 * floor-to-multiple-of-8 truncated size for smaller files — see
 * computeOshashForFile for that sizing logic). `sizeBytes` is the file's
 * TRUE size (not the head/tail buffer length).
 */
export function computeOshashFromBuffers(head: Buffer | Uint8Array, tail: Buffer | Uint8Array, sizeBytes: number | bigint): string {
  const headSum = sumUint64LEChunks(head);
  const tailSum = sumUint64LEChunks(tail);
  const size = BigInt(sizeBytes) & UINT64_MASK;
  const result = (headSum + tailSum + size) & UINT64_MASK;
  return result.toString(16).padStart(16, '0');
}

/**
 * Reads only the first/last chunk of `filePath` (never the whole file for
 * anything beyond 128KB) and computes its oshash. Matches Stash's own
 * `FromReader` behavior exactly:
 *   - size <= 8 bytes: rejected (there is not even one full uint64 chunk).
 *   - size < 64KB: chunk size shrinks to `floor(size / 8) * 8`; head and
 *     tail both read from (and, for the smallest files, fully overlap)
 *     that truncated region.
 *   - size >= 64KB: head = first 64KB, tail = last 64KB (disjoint unless
 *     size < 128KB, in which case they may overlap — this matches
 *     upstream, which does not special-case the overlap).
 */
export async function computeOshashForFile(filePath: string): Promise<string> {
  const { size } = await stat(filePath);
  if (size <= 8) {
    throw new Error(`oshash: cannot calculate oshash where size < 8 (${size})`);
  }

  const chunkSize = size < CHUNK_SIZE ? Math.floor(size / 8) * 8 : CHUNK_SIZE;

  const handle = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(chunkSize);
    await handle.read(head, 0, chunkSize, 0);

    const tail = Buffer.alloc(chunkSize);
    await handle.read(tail, 0, chunkSize, size - chunkSize);

    return computeOshashFromBuffers(head, tail, size);
  } finally {
    await handle.close();
  }
}
