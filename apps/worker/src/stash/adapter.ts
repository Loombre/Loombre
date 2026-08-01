// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/adapter.ts
//
// Read-only SQLite connection lifecycle for a Stash database (STATE.md
// S2/K6). This module knows NOTHING about Stash's schema — that is
// guard.ts (schema-version check) and read-model.ts (typed reads) — its
// only job is: open the file read-only, retry through transient
// contention, and fall back to a snapshot copy, all without ever writing
// a byte to the source file.
//
// What "never writes the Stash DB" is proven to mean (test/stash/
// adapter.spec.ts, fs-level; test/stash/sync-consumer.spec.ts, across a
// WHOLE sync run — inventory + matching + apply):
//   - the source `.db` file's bytes AND mtime are identical after an
//     uncontended session, after a SUCCESSFUL snapshot-copy fallback, and
//     after a fallback where both retry tiers are exhausted;
//   - it does NOT mean the directory is untouched: reading a WAL-mode
//     database makes SQLite create the `-wal`/`-shm` sidecars beside it,
//     and a read-only connection cannot remove them on close (unlike a
//     read-write one). That is a requirement of SQLite's WAL reader
//     protocol, not a Loombre choice, and it is pinned empirically rather
//     than assumed — as is its consequence: a WAL-mode database in a
//     directory this process cannot write cannot be read AT ALL, which
//     explainOpenFailure below turns into an honest admin-facing message
//     instead of SQLite's own "attempt to write a readonly database".
//
// K6 empirical findings this design is built on (node:sqlite, Node 24,
// spiked by hand before writing this file — see adapter.spec.ts's header
// for the reproduction):
//   - `new DatabaseSync(path, { readOnly: true })` succeeds even when
//     another connection holds an exclusive lock on `path` — SQLite does
//     not take a file lock at open time, only at the first read/write.
//     A verifying query is therefore required to actually detect
//     contention.
//   - A locked source surfaces as `error.code === 'ERR_SQLITE_ERROR'`
//     with `error.errcode` 5 (SQLITE_BUSY) or 6 (SQLITE_LOCKED) on a
//     direct query — retried.
//   - A nonexistent path surfaces as errcode 14 (SQLITE_CANTOPEN) — NOT
//     retried (retrying can never fix a missing file); this keeps
//     "the path is wrong" from burning the whole retry budget.
//   - node:sqlite's built-in `backup()` (the SQLite Online Backup API —
//     correctly reads a consistent snapshot through a live WAL rather
//     than risking a torn copy of the raw file + `-wal`/`-shm` sidecars)
//     does NOT report a clean SQLITE_BUSY when its source is locked —
//     empirically it throws `{ code: 'ERR_SQLITE_ERROR', errcode: 0,
//     errstr: 'not an error' }`. The snapshot tier below therefore
//     retries on ANY backup() failure (once the source file is confirmed
//     to exist), rather than trying to classify the error.
//   - "mutations from other connections cause the backup process to
//     restart" per Node's own docs — an actively-writing Stash instance
//     can make a single backup() attempt loop internally; this is
//     inherent to online-backup semantics and is exactly why this tier
//     is itself retried with a bounded budget rather than assumed to
//     finish in one call.

import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp } from 'node:fs/promises';
import { constants as fsConstants, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StashConnectionUnavailableError } from './errors.js';

export interface StashConnection {
  /** Always opened `readOnly: true` — whether this is `source` (the real
   *  Stash file) or `snapshot` (a temp copy taken because the source was
   *  contended). */
  readonly db: DatabaseSync;
  readonly sourcePath: string;
  readonly readingFrom: 'source' | 'snapshot';
  readonly snapshotPath: string | null;
  /** Closes the db handle and, for `readingFrom === 'snapshot'`, removes
   *  the temp copy (and its directory). Never touches the source file. */
  close(): void;
}

export interface OpenStashConnectionOptions {
  path: string;
  /** SQLite's own busy_timeout (ms), applied per direct-open attempt.
   *  Default 2000. */
  busyTimeoutMs?: number;
  /** Bounded retry count for the direct-open tier before falling back to
   *  a snapshot copy. Default 3. */
  maxDirectRetries?: number;
  /** Base backoff (ms) between direct-open retries, doubling each
   *  attempt. Default 250. */
  directRetryBackoffMs?: number;
  /** Bounded retry count for the snapshot-copy tier. Default 5. */
  maxSnapshotRetries?: number;
  /** Base backoff (ms) between snapshot-copy retries, doubling each
   *  attempt. Default 250. */
  snapshotRetryBackoffMs?: number;
}

export interface StashAdapterDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Parent directory for snapshot temp copies. Default `os.tmpdir()`. */
  tmpDir?: string;
}

const RETRYABLE_SQLITE_ERRCODES = new Set([5 /* SQLITE_BUSY */, 6 /* SQLITE_LOCKED */]);

function isSqliteError(err: unknown): err is Error & { code: string; errcode: number } {
  return err instanceof Error && (err as { code?: unknown }).code === 'ERR_SQLITE_ERROR';
}

function isRetryableDirectOpenError(err: unknown): boolean {
  return isSqliteError(err) && RETRYABLE_SQLITE_ERRCODES.has(err.errcode);
}

/**
 * Turns a misleading SQLite failure into a sentence an admin can act on,
 * or returns undefined to let the raw message stand (R2 audit —
 * library_stash_connections.status_detail is rendered verbatim in the
 * admin UI, so these strings are user-facing).
 *
 * The one case that genuinely needs it: SQLite's extended result codes in
 * the SQLITE_READONLY family (primary code 8) — most importantly
 * SQLITE_READONLY_DIRECTORY (1544), raised when a WAL-mode database sits
 * in a directory this process cannot write. SQLite's own wording is
 * "attempt to write a readonly database", which describes Loombre doing
 * the exact thing S2 promises it never does. What actually happened is
 * that SQLite's WAL reader protocol needs the shared wal-index (`-shm`,
 * and an empty `-wal`) BESIDE the database file, and could not create it
 * — a directory-permission problem, not a write to the user's data. The
 * real-world shapes are a Stash config directory owned by another user
 * (Stash in a container, Loombre as a service account) or a read-only
 * export/mount.
 */
function explainOpenFailure(err: unknown): string | undefined {
  if (!isSqliteError(err)) return undefined;
  const primaryCode = err.errcode & 0xff;
  if (primaryCode !== 8 /* SQLITE_READONLY */) return undefined;
  return (
    'Loombre can read this file but cannot create its SQLite sidecar files (-wal/-shm) beside it, ' +
    "which SQLite requires to read a WAL-mode database. Loombre did NOT write, and never writes, your Stash database — " +
    'the directory containing it needs to be writable by the user Loombre runs as (or the database copied somewhere that is)'
  );
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens `path` read-only and runs a trivial query to force any lock
 *  contention to surface now (open alone does not, see header). Throws
 *  the underlying error untouched — the caller classifies it. */
function tryOpenDirectOnce(sourcePath: string, busyTimeoutMs: number): DatabaseSync {
  const db = new DatabaseSync(sourcePath, { readOnly: true, timeout: busyTimeoutMs });
  try {
    db.prepare('SELECT 1').get();
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

async function attemptDirectOpen(
  sourcePath: string,
  opts: Required<Pick<OpenStashConnectionOptions, 'busyTimeoutMs' | 'maxDirectRetries' | 'directRetryBackoffMs'>>,
  sleep: (ms: number) => Promise<void>
): Promise<DatabaseSync | { busy: true; lastError: unknown } | { busy: false; lastError: unknown }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxDirectRetries; attempt++) {
    try {
      return tryOpenDirectOnce(sourcePath, opts.busyTimeoutMs);
    } catch (err) {
      lastError = err;
      if (!isRetryableDirectOpenError(err)) {
        return { busy: false, lastError };
      }
      if (attempt < opts.maxDirectRetries) {
        await sleep(opts.directRetryBackoffMs * 2 ** attempt);
      }
    }
  }
  return { busy: true, lastError };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function snapshotCopy(
  sourcePath: string,
  opts: Required<Pick<OpenStashConnectionOptions, 'maxSnapshotRetries' | 'snapshotRetryBackoffMs'>>,
  sleep: (ms: number) => Promise<void>,
  tmpDirBase: string
): Promise<{ db: DatabaseSync; snapshotPath: string; snapshotDir: string }> {
  const snapshotDir = await mkdtemp(path.join(tmpDirBase, 'loombre-stash-snapshot-'));
  const snapshotPath = path.join(snapshotDir, `${randomUUID()}.sqlite`);

  // Opened WITHOUT a busy timeout of its own — the retry loop below is
  // the timing control; backup() failures under contention do not report
  // a clean busy code (see header), so there is nothing for SQLite's own
  // busy_timeout to usefully wait on here.
  const sourceForBackup = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= opts.maxSnapshotRetries; attempt++) {
      try {
        await backup(sourceForBackup, snapshotPath);
        const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
        return { db: snapshotDb, snapshotPath, snapshotDir };
      } catch (err) {
        lastError = err;
        if (attempt < opts.maxSnapshotRetries) {
          await sleep(opts.snapshotRetryBackoffMs * 2 ** attempt);
        }
      }
    }
    // Every attempt failed — the caller never gets a StashConnection to
    // call .close() on (that's the ONLY other place this directory is
    // ever removed), so this is the one spot responsible for not leaking
    // an empty temp directory on a fully-failed snapshot attempt.
    rmSync(snapshotDir, { recursive: true, force: true });
    throw lastError;
  } finally {
    sourceForBackup.close();
  }
}

/**
 * Opens a Stash SQLite database read-only (S2), retrying through
 * transient lock contention and falling back to a snapshot copy when the
 * lock outlasts the direct-open retry budget. Never writes to `path`.
 * Throws StashConnectionUnavailableError if neither tier succeeds.
 */
export async function openStashConnection(options: OpenStashConnectionOptions, deps: StashAdapterDeps = {}): Promise<StashConnection> {
  const sleep = deps.sleep ?? defaultSleep;
  const tmpDirBase = deps.tmpDir ?? tmpdir();

  const resolvedOpts = {
    busyTimeoutMs: options.busyTimeoutMs ?? 2000,
    maxDirectRetries: options.maxDirectRetries ?? 3,
    directRetryBackoffMs: options.directRetryBackoffMs ?? 250,
    maxSnapshotRetries: options.maxSnapshotRetries ?? 5,
    snapshotRetryBackoffMs: options.snapshotRetryBackoffMs ?? 250,
  };

  if (!(await pathExists(options.path))) {
    throw new StashConnectionUnavailableError(options.path, new Error(`no such file: ${options.path}`));
  }

  const direct = await attemptDirectOpen(
    options.path,
    { busyTimeoutMs: resolvedOpts.busyTimeoutMs, maxDirectRetries: resolvedOpts.maxDirectRetries, directRetryBackoffMs: resolvedOpts.directRetryBackoffMs },
    sleep
  );

  if (direct instanceof DatabaseSync) {
    return {
      db: direct,
      sourcePath: options.path,
      readingFrom: 'source',
      snapshotPath: null,
      close: () => direct.close(),
    };
  }

  if (!direct.busy) {
    // A non-retryable error (e.g. CANTOPEN, a non-writable directory,
    // corruption) — the snapshot tier opens the SAME source file and would
    // fail identically, so fail fast instead of copying.
    throw new StashConnectionUnavailableError(options.path, direct.lastError, explainOpenFailure(direct.lastError));
  }

  // Direct tier exhausted its retry budget while still busy — fall back
  // to the snapshot-copy tier (S2).
  try {
    const { db, snapshotPath, snapshotDir } = await snapshotCopy(
      options.path,
      { maxSnapshotRetries: resolvedOpts.maxSnapshotRetries, snapshotRetryBackoffMs: resolvedOpts.snapshotRetryBackoffMs },
      sleep,
      tmpDirBase
    );
    return {
      db,
      sourcePath: options.path,
      readingFrom: 'snapshot',
      snapshotPath,
      close: () => {
        db.close();
        // Synchronous removal — close() is a sync API, so cleanup must be
        // guaranteed complete before it returns (an async fire-and-forget
        // rm() here would race a caller that immediately checks for the
        // temp file's absence, e.g. this module's own test suite).
        rmSync(snapshotDir, { recursive: true, force: true });
      },
    };
  } catch (snapshotErr) {
    throw new StashConnectionUnavailableError(options.path, snapshotErr);
  }
}
