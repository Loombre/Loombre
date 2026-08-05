// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/support/busy-direct-open.ts
//
// Shared test seam for the Stash adapter's S2 snapshot-copy fallback.
//
// The adapter falls back to a snapshot copy when its direct read-only open
// keeps hitting SQLITE_BUSY. Producing that with a REAL OS file lock is not
// portable: SQLite's cross-connection locking is only guaranteed to conflict
// across separate PROCESSES (via OS file locks), and some CI filesystems —
// the GitHub macOS AND Windows runners, observed empirically — do not honor
// those locks for SQLite at all, so NO real lock (same-process or cross-
// process) blocks a reader there. Relying on real contention made the
// snapshot-fallback tests pass on Linux and fail on macOS/Windows CI.
//
// Instead, tests force the direct tier into a deterministic SQLITE_BUSY via
// the adapter's `openDirectOnce` seam (StashAdapterDeps). The snapshot tier
// then runs its REAL backup() against the genuinely-unlocked source, so the
// fallback path and its real file copy are exercised identically on every
// platform.

import type { StashAdapterDeps } from "../../../src/stash/adapter.js";

/** An `openDirectOnce` override that always throws a SQLITE_BUSY-shaped
 *  error (errcode 5 — the retryable code adapter.ts checks for), so the
 *  direct-open tier exhausts its retries and the adapter falls back to the
 *  snapshot tier. */
export function busyThrowingOpen(): NonNullable<StashAdapterDeps["openDirectOnce"]> {
  return () => {
    const err = new Error("database is locked") as Error & { code: string; errcode: number };
    err.code = "ERR_SQLITE_ERROR";
    err.errcode = 5;
    throw err;
  };
}
