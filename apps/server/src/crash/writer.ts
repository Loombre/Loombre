// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/crash/writer.ts
//
// Synchronous, on purpose: a process about to call process.exit(1) from
// inside an uncaughtException/unhandledRejection handler cannot rely on an
// async fs write's promise settling before the event loop is torn down —
// Node makes no guarantee an in-flight async write survives past
// process.exit(). Sync fs calls block until the bytes are actually on disk,
// which is exactly the guarantee "the crash file appears" needs.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crashDirPath } from "@loombre/shared";
import type { CrashReport } from "./report.js";

/** Filesystem-safe, sortable, collision-resistant: ISO timestamp with `:`
 *  stripped (invalid in Windows filenames) plus a short random suffix so
 *  two crashes in the same millisecond (e.g. an uncaughtException firing
 *  while an unhandledRejection handler is already mid-write) never collide. */
function crashFileName(nowMs: number): string {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `crash-${iso}-${suffix}.json`;
}

/** Writes `report` under crashDirPath(dataDir), creating the directory if
 *  needed. Returns the full path written. Throws only if the filesystem
 *  itself is unwritable (dataDir on read-only media, permissions) — callers
 *  in handlers.ts wrap this in a try/catch so a crash-file write failure
 *  never prevents the process from still exiting on a crash. */
export function writeCrashReport(dataDir: string, report: CrashReport): string {
  const dir = crashDirPath(dataDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = join(dir, crashFileName(report.ts));
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
  return path;
}
