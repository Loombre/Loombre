// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/support/wal-lock-holder.mjs
//
// A tiny child process that takes and HOLDS an exclusive WAL lock on a
// SQLite database, then stays alive until killed. Used by the Stash
// adapter/sync tests (adapter.spec.ts, sync-consumer.spec.ts) to force
// S2's snapshot-copy fallback with a lock held by a DIFFERENT process.
//
// Why a separate process (not a second connection in the test's own
// process): SQLite serialises cross-connection access through OS file
// locks (POSIX advisory locks via fcntl on macOS/Linux, LockFile on
// Windows). Those locks conflict RELIABLY across processes on every
// platform. Within a SINGLE process they do NOT conflict uniformly — a
// same-process second connection blocked a read-only reader on Linux and
// most macOS builds but NOT on the GitHub macOS runner, so the old
// same-process fixture passed on Linux and failed on macOS CI (the reader
// opened directly and the fallback never fired). A child process is also
// the FAITHFUL simulation of the real scenario S2 defends against: a
// running Stash instance, a different process, holding the WAL lock.
//
// It never COMMITs, so the target `.db` file's bytes are never changed —
// killing this process discards the uncommitted transaction, leaving the
// source byte- and mtime-identical (the R2/S2 immutability the tests
// assert). The scratch table is uncommitted DDL, so it never lands either
// and the holder makes no assumption about the fixture's own schema.

import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("wal-lock-holder: missing db path argument\n");
  process.exit(2);
}

const holder = new DatabaseSync(dbPath);
holder.exec("PRAGMA journal_mode=WAL;");
holder.exec("PRAGMA locking_mode=EXCLUSIVE;");
holder.exec("BEGIN IMMEDIATE;");
// Schema-agnostic: an uncommitted write to a scratch table forces the
// EXCLUSIVE write lock regardless of the fixture's own tables; discarded
// (never committed, never checkpointed) when this process is killed.
holder.exec("CREATE TABLE IF NOT EXISTS __loombre_wal_lock_probe (x INTEGER);");
holder.exec("INSERT INTO __loombre_wal_lock_probe (x) VALUES (1);");

// Signal readiness ONLY after the lock is actually held, so the parent
// never races ahead and reads before contention exists.
process.stdout.write("locked\n");

// Hold until SIGKILL/SIGTERM. The interval keeps the event loop alive; the
// OS releases the file lock the instant this process dies.
setInterval(() => {}, 1 << 30);
