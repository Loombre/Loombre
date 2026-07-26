// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/admin-storage-pool.ts
//
// Storage-pool aggregate for GET /system/info's additive `storagePool`
// field (STATE.md Phosphor retheme, W1c "contract enablers" lane;
// design/phosphor/README.md Shell spec: sidebar "POOL 43.1 / 60.8 TB"
// meter). CLAUDE.md invariant 9 (Tier-0 rule): request paths do no
// CPU-heavy work — this does exactly two cheap syscalls (fs.stat +
// fs.statfs) per DISTINCT filesystem a library root lives on, never one
// pair per library. No DB access, no ViewerContext: disk capacity across
// library root paths is admin-only infrastructure data, not catalog
// content (see packages/db/src/query/libraries.ts's listLibraryPathsAdmin
// doc comment for why that query function needs no guard either).
//
// Dedup key: fs.stat's `dev` (the POSIX device id of the filesystem a path
// resides on; Node populates the equivalent on Windows too) — NOT the path
// string, since two different library root paths can be the same mounted
// volume, which would double-count its capacity.

import { statfs, stat } from "node:fs/promises";

export interface StoragePoolStats {
  usedBytes: number;
  totalBytes: number;
}

/**
 * Aggregates total/used bytes across every DISTINCT filesystem in
 * `libraryPaths`. Returns `null` when there are zero paths to probe, or
 * every probe failed (missing mount, permission denied) — the caller
 * treats `null` as "no pool data available" and hides the sidebar meter
 * rather than rendering fabricated zeros (U9). A single unreadable path
 * does not fail the whole aggregate — the other libraries' filesystems
 * still contribute.
 */
export async function computeStoragePool(libraryPaths: string[]): Promise<StoragePoolStats | null> {
  const seenDeviceIds = new Set<number>();
  let totalBytes = 0;
  let usedBytes = 0;
  let sawAny = false;

  for (const libraryPath of libraryPaths) {
    try {
      const stats = await stat(libraryPath);
      if (seenDeviceIds.has(stats.dev)) {
        continue; // Already counted this filesystem via another library path.
      }
      seenDeviceIds.add(stats.dev);

      const fsStats = await statfs(libraryPath);
      const total = fsStats.bsize * fsStats.blocks;
      const free = fsStats.bsize * fsStats.bfree;
      totalBytes += total;
      usedBytes += Math.max(0, total - free);
      sawAny = true;
    } catch {
      // Unreadable/missing mount — skip this path's filesystem, don't fail
      // the whole aggregate (a single dropped library root shouldn't blank
      // the pool meter for every other library).
    }
  }

  return sawAny ? { usedBytes, totalBytes } : null;
}
