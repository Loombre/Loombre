// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/transcode/atomic-replace.ts
//
// Write-temp-then-rename is how the runner rewrites the served playlist so a
// concurrent reader (apps/server's hls-file.controller.ts, polling on behalf
// of a real client) sees either the previous complete file or the next one,
// never a torn one (runner.ts's "ATOMIC rewrite" comment). rename(2) is
// atomic on POSIX and Node's rename replaces an existing destination on
// Windows too (MOVEFILE_REPLACE_EXISTING) — but Windows adds a failure mode
// POSIX has no equivalent for: the replace is REFUSED with
// ERROR_ACCESS_DENIED (Node: EPERM, sometimes EACCES/EBUSY) for as long as
// any handle opened without FILE_SHARE_DELETE holds the destination. An
// antivirus real-time scan of the file the previous tick wrote, the search
// indexer, or a reader that is not libuv (which does request share-delete)
// all do that, for milliseconds at a time.
//
// The first Windows gate leg hit it live (run 34156680703): one EPERM out
// of the runner's poll loop rejected runTranscodeSession, the session
// never served its restart run, and the client waited forever. So the
// replace is a BOUNDED RETRY on win32 — the same remedy graceful-fs applies
// to rename — and stays a single attempt everywhere else, where EPERM on
// rename is a real permission problem that must surface immediately.
import { rename as fsRename } from "node:fs/promises";

/** The Windows sharing-violation spellings Node surfaces for a refused
 *  MoveFileEx(REPLACE_EXISTING). Nothing else is retried: ENOENT means the
 *  temp file is gone, EXDEV a cross-device move — both are programming
 *  errors, not transient contention. */
export const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** 100 × 10 ms: a second of patience, two orders of magnitude above the
 *  handle lifetimes that cause this, far below any poll loop's tolerance. */
export const DEFAULT_RENAME_ATTEMPTS = 100;
export const DEFAULT_RENAME_BACKOFF_MS = 10;

export interface ReplaceFileDeps {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  attempts?: number;
  backoffMs?: number;
}

export interface ReplaceFileOutcome {
  /** How many rename calls it took — 1 on every host that is not fighting a
   *  sharing violation. Exposed for the poll loop's own telemetry/tests. */
  attempts: number;
}

/**
 * Move `tmpPath` over `destPath`, replacing it. On win32, a sharing
 * violation (`RENAME_RETRY_CODES`) is retried up to `attempts` times with
 * `backoffMs` between tries; the last error is rethrown when the budget is
 * exhausted. On every other platform the first error is thrown as-is.
 */
export async function replaceFileAtomically(tmpPath: string, destPath: string, deps: ReplaceFileDeps = {}): Promise<ReplaceFileOutcome> {
  const rename = deps.rename ?? fsRename;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const platform = deps.platform ?? process.platform;
  const attempts = platform === "win32" ? Math.max(1, deps.attempts ?? DEFAULT_RENAME_ATTEMPTS) : 1;
  const backoffMs = deps.backoffMs ?? DEFAULT_RENAME_BACKOFF_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(tmpPath, destPath);
      return { attempts: attempt };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= attempts || code === undefined || !RENAME_RETRY_CODES.has(code)) throw error;
      await sleep(backoffMs);
    }
  }
}
