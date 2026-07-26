// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/admin-crash-files.ts
//
// GET /admin/crash-files + GET /admin/crash-files/{name} backing
// implementation (STATE.md P4.5/P4.14, Phase 4 deliverable D). Uses
// @loombre/shared's `crashDirPath(dataDir)` (G1's P4.14 work, landed this
// same wave) for the directory path — the ONE shared convention every
// crash-writing/reading surface uses (apps/server's and apps/worker's
// crash modules, the controller-ipc `crash-files` op via apps/server/src/
// ipc/crash-dir.ts's own `resolveCrashDir` re-export). No local TODO-import
// stand-in needed here; the real export was already available when this
// module was written.
//
// This is the CONTENT-reading half (list metadata + read one file's text);
// apps/server/src/ipc/crash-dir.ts's listCrashFiles is the "reveal in
// folder" path+mtime-only half for the loopback IPC surface — see that
// file's header for why the two are deliberately separate (content is
// never served over IPC v1).
//
// Traversal safety (contract requirement, packages/contract/openapi.yaml's
// GET /admin/crash-files/{name} parameter description): the strict
// filename pattern `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` makes traversal
// structurally impossible — the first character class excludes `.` and
// `/`, so neither `..` nor an absolute path nor any path-separator-bearing
// string can ever match. `isValidCrashFileName` is the ONE place that
// pattern lives; the controller must reject before ever building a path
// with a caller-supplied name, and a defense-in-depth `isStrictlyUnder`
// check (mirroring apps/server/src/playback/subtitle-file.controller.ts's
// own helper) still runs afterwards, so a future pattern-loosening bug
// would still be caught by this second, path-arithmetic layer.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { crashDirPath } from "@loombre/shared";

/** Strict, closed pattern — see this module's header. Exported so the
 *  controller and this module's own tests share exactly one definition. */
export const CRASH_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidCrashFileName(name: string): boolean {
  return CRASH_FILE_NAME_PATTERN.test(name);
}

function isStrictlyUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface CrashFileMeta {
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** Newest-first list of crash file metadata. A missing directory (the
 *  common case — no crash has ever happened) is an empty list, not an
 *  error (mirrors listCrashFiles's identical posture in ipc/crash-dir.ts).
 *  Retention-cap note (contract description): the crash WRITER (P4.14,
 *  apps/server's process-level handlers) is what bounds how many files
 *  ever accumulate here — this read-only lister has no cap logic of its
 *  own to duplicate; it always lists everything currently on disk. */
export function listCrashFileMetas(dataDir: string): CrashFileMeta[] {
  const dir = crashDirPath(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: CrashFileMeta[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      // Raced with something removing the file between readdir and stat —
      // skip it rather than fail the whole listing (same tolerance as
      // ipc/crash-dir.ts's listCrashFiles).
      continue;
    }
    if (!stat.isFile()) continue;
    entries.push({ name, sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

/**
 * Reads one crash file's content by basename. Returns `null` — never
 * throws — for: an invalid name (caller should reject before calling this
 * at all; checked again here as the defense-in-depth layer), a name that
 * resolves outside the crash directory, or a file that doesn't exist/isn't
 * a regular file. The controller maps `null` to 404.
 */
export function readCrashFileContent(dataDir: string, name: string): string | null {
  if (!isValidCrashFileName(name)) return null;

  const dir = crashDirPath(dataDir);
  const filePath = join(dir, name);
  if (!isStrictlyUnder(dir, filePath)) return null;

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
