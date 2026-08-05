// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/support/wal-lock-holder.ts
//
// Spawns ./wal-lock-holder.mjs (a child process that takes and holds an
// exclusive WAL lock on a SQLite file — see that file's header for why a
// SEPARATE process rather than a same-process connection) and resolves once
// the lock is genuinely held. Cross-process file locks conflict reliably on
// every platform, so a concurrent read-only opener of the same file gets
// SQLITE_BUSY until stop() is called — which is exactly what forces the
// Stash adapter's S2 snapshot-copy fallback in the tests.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOLDER_SCRIPT = fileURLToPath(new URL("./wal-lock-holder.mjs", import.meta.url));

export interface WalLockHolder {
  /** Releases the lock (kills the child); the OS reclaims the file lock as
   *  the process exits. Idempotent. */
  stop(): void;
}

/**
 * Starts a child process holding an exclusive WAL lock on `dbPath` and
 * resolves after the lock is actually taken (the child prints "locked" only
 * once BEGIN IMMEDIATE + the write have succeeded). Every started holder is
 * tracked so a test's afterEach/afterAll can stop any it forgot — pass the
 * returned handle to stopAllWalLockHolders() cleanup, or call stop() itself.
 */
export function startWalLockHolder(dbPath: string): Promise<WalLockHolder> {
  return new Promise<WalLockHolder>((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [HOLDER_SCRIPT, dbPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    liveHolders.add(child);

    let settled = false;
    const holder: WalLockHolder = {
      stop: () => {
        if (!child.killed) child.kill("SIGKILL");
        liveHolders.delete(child);
      },
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!settled && chunk.toString("utf8").includes("locked")) {
        settled = true;
        resolve(holder);
      }
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        liveHolders.delete(child);
        reject(err);
      }
    });
    child.on("exit", (code, signal) => {
      liveHolders.delete(child);
      if (!settled) {
        settled = true;
        reject(new Error(`wal-lock-holder exited before locking (code=${String(code)}, signal=${String(signal)})`));
      }
    });
  });
}

const liveHolders = new Set<ChildProcess>();

/** Kills any lock holders still alive — call from afterEach/afterAll so a
 *  test that threw before its own stop() never leaks a lock-holding child. */
export function stopAllWalLockHolders(): void {
  for (const child of liveHolders) {
    if (!child.killed) child.kill("SIGKILL");
  }
  liveHolders.clear();
}
