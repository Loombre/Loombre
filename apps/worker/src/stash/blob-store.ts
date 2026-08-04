// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/blob-store.ts
//
// Stash FILESYSTEM blob-store reader (owner-approved enhancement, 2026-08-04).
//
// Stash has two blob-storage modes (its "Blobs Storage" setting): Database
// (bytes live in the `blobs.blob` column — read-model.ts's getBlob handles
// this) or Filesystem (the `blobs.blob` column is NULL and the bytes live in
// a directory tree keyed by checksum). The owner's real 43k library uses
// Filesystem mode — every one of its 53,394 blob rows has a NULL `blob`
// column — so cover/portrait/logo art cannot be read from the SQLite copy
// alone. This module resolves those bytes from the on-disk store.
//
// Sharding scheme — verified against Stash source (pkg/sqlite/blob/fs.go +
// pkg/fsutil/dir.go, github.com/stashapp/stash, develop HEAD @ schema 85,
// fetched 2026-08-04), NOT copied (an independent reimplementation of a
// documented layout): FilesystemReader.checksumToPath does
//   filepath.Join(root, GetIntraDir(checksum, depth=2, length=2), checksum)
// and GetIntraDir(checksum, 2, 2) yields `checksum[0:2]/checksum[2:4]` (it
// returns "" — no intra dir — when depth*length > len(checksum), which never
// happens for a real md5/sha checksum, but the guard is reproduced for
// fidelity). So checksum `abcd1234…` resolves to
// `<root>/ab/cd/abcd1234…`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StashBlob } from './read-model.js';

const BLOBS_DIR_DEPTH = 2;
const BLOBS_DIR_LENGTH = 2;

/**
 * The sharded, root-relative path Stash stores a blob at, or the bare
 * checksum when it is too short to shard (mirrors GetIntraDir's own guard).
 * Pure — no I/O — so it is unit-testable against Stash's known layout.
 */
export function stashBlobRelativePath(checksum: string): string {
  if (BLOBS_DIR_DEPTH * BLOBS_DIR_LENGTH > checksum.length) {
    return checksum;
  }
  const segments: string[] = [];
  for (let i = 0; i < BLOBS_DIR_DEPTH; i++) {
    segments.push(checksum.slice(BLOBS_DIR_LENGTH * i, BLOBS_DIR_LENGTH * (i + 1)));
  }
  return join(...segments, checksum);
}

/**
 * Reads a blob's bytes from Stash's filesystem store, or null when the file
 * is absent (a missing cover is a normal, non-fatal state — never throws for
 * ENOENT). Read-only by construction; Loombre never writes this tree.
 */
export function readFilesystemBlob(blobsPath: string, checksum: string): Buffer | null {
  if (!blobsPath || !checksum) return null;
  try {
    return readFileSync(join(blobsPath, stashBlobRelativePath(checksum)));
  } catch (err) {
    // ENOENT is the expected "no such cover on disk" case. Anything else
    // (a permissions problem, a directory where a file was expected) is
    // ALSO treated as "no bytes" rather than crashing the whole sync over
    // one unreadable cover — the sync report's counts already surface the
    // shortfall, and the item simply keeps whatever art it had.
    void err;
    return null;
  }
}

/**
 * The getBlob dependency the sync-consumer hands to apply.ts, composing the
 * DB-backed reader (read-model.ts's getBlob) with the filesystem fallback.
 * DB bytes ALWAYS win when present (Database-mode Stash, or a fixture); the
 * filesystem is consulted only when the DB row carries no bytes AND a blobs
 * path is configured. `blobsPath` null/'' ⇒ today's DB-only behavior
 * unchanged.
 */
export function makeBlobResolver(
  sqliteGetBlob: (checksum: string) => StashBlob | null,
  blobsPath: string | null,
): (checksum: string) => StashBlob | null {
  return (checksum: string): StashBlob | null => {
    const dbBlob = sqliteGetBlob(checksum);
    if (dbBlob?.bytes) return dbBlob;
    if (!blobsPath) return dbBlob; // DB-only mode: preserve exact prior return (null or {bytes:null}).
    const bytes = readFilesystemBlob(blobsPath, checksum);
    if (!bytes) return dbBlob;
    return { checksum, bytes };
  };
}
