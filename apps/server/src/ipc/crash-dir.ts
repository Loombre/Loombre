// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/crash-dir.ts
//
// GET /ipc/v1/crash-files backing implementation. Lists path+mtimeMs for
// every file under the shared crash-log directory — see
// packages/controller-ipc/src/crash-files.ts's own header: this is the
// "reveal in folder" surface only (content is never served over IPC v1;
// the web admin's authenticated /v1 surface is the separate lane for
// reading crash content, per that file's own doc comment).
//
// This lane's brief flagged crashDirPath(dataDir) as landing mid-wave in
// packages/shared (lane G1, P4.14 crash/signal-handler work) and said to
// define a local TODO-import stand-in if it wasn't there yet when this
// file was first written. It landed during this lane's own development
// (packages/shared/src/crash-dir.ts — same "crashes" subdirectory
// convention this file had independently assumed, matching
// packages/controller-ipc's own test fixture:
// packages/controller-ipc/test/crash-files.spec.ts's
// "/var/lib/loombre/crashes/server-....log"), so this now imports the real,
// shared implementation directly — @loombre/shared is already a real
// apps/server dependency, no shim needed.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { crashDirPath } from "@loombre/shared";
import type { CrashFileEntry } from "@loombre/controller-ipc";

/** Re-exported under this file's existing name for call-site stability —
 *  just @loombre/shared's crashDirPath. */
export function resolveCrashDir(dataDir: string): string {
  return crashDirPath(dataDir);
}

/** Lists crash files sorted by mtime descending (most recent first) — the
 *  natural order for a "recent crashes" list. A missing directory (the
 *  common case: no crash has ever happened) is NOT an error, just an empty
 *  list — crash-files.ts's CrashFilesResponse has no error variant for
 *  "no crashes yet", and there shouldn't be one. */
export function listCrashFiles(dataDir: string): CrashFileEntry[] {
  const dir = resolveCrashDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: CrashFileEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      // Raced with something removing the file between readdir and stat —
      // skip it rather than fail the whole listing.
      continue;
    }
    if (!stat.isFile()) continue;
    entries.push({ path, mtimeMs: Math.round(stat.mtimeMs) });
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}
