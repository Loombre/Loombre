// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";

/**
 * The one shared path convention for where every process writes its local
 * crash files (STATE.md P4.14, docs/PLAN.md §10 "Crash reports are written
 * to a local file only"): `<dataDir>/crashes`. Both apps/server's and
 * apps/worker's crash modules (Phase 4 lane G1) AND the controller-ipc
 * listener lane's `crash-files` op (STATE.md Wave-0 seam,
 * @loombre/controller-ipc's ops surface) import this ONE function rather
 * than each hardcoding the "crashes" subdirectory name — a lane that needs
 * to point a file picker or an IPC response at the crash directory gets the
 * exact same path apps/server/apps/worker actually write to, by
 * construction, with zero coordination beyond this export.
 *
 * Pure — takes the already-resolved app-data directory as an argument
 * rather than reading LOOMBRE_DATA_DIR itself, matching this package's
 * "no I/O, no environment reads" posture (packages/shared/src/time.ts's own
 * header sets the same precedent for nowMs()).
 */
export function crashDirPath(dataDir: string): string {
  return join(dataDir, "crashes");
}
