// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/checkpoints.ts
//
// scan_checkpoints reader/writer (P1.12, migrations/0002_phase1_catalog.sql).

import type { Selectable } from 'kysely';
import type { ScanCheckpointsTable } from '../types.js';
import type { DbOrTx } from './tx.js';

export type ScanCheckpointRow = Selectable<ScanCheckpointsTable>;

export interface WriteCheckpointInput {
  jobId: string;
  libraryId: string;
  phase: string;
  lastProcessedPath?: string | null;
  filesSeen?: number;
  filesProcessed?: number;
  /** FW2-E/AUD-A2d-003 (migrations/0033_scan_checkpoint_item_counters.sql)
   *  — running itemsAdded/itemsUpdated/itemsRemoved totals, carried across
   *  a resumed attempt the same way filesProcessed already is. Optional
   *  for the same reason filesSeen/filesProcessed are: not every caller
   *  (e.g. a test seeding a bare checkpoint) needs to set them. */
  itemsAdded?: number;
  itemsUpdated?: number;
  itemsRemoved?: number;
  updatedAtMs: number;
}

export async function writeCheckpoint(
  db: DbOrTx,
  input: WriteCheckpointInput
): Promise<ScanCheckpointRow> {
  return db
    .insertInto('scan_checkpoints')
    .values({
      job_id: input.jobId,
      library_id: input.libraryId,
      phase: input.phase,
      last_processed_path: input.lastProcessedPath ?? null,
      ...(input.filesSeen !== undefined ? { files_seen: input.filesSeen } : {}),
      ...(input.filesProcessed !== undefined ? { files_processed: input.filesProcessed } : {}),
      ...(input.itemsAdded !== undefined ? { items_added: input.itemsAdded } : {}),
      ...(input.itemsUpdated !== undefined ? { items_updated: input.itemsUpdated } : {}),
      ...(input.itemsRemoved !== undefined ? { items_removed: input.itemsRemoved } : {}),
      updated_at_ms: input.updatedAtMs,
    })
    .onConflict((oc) =>
      oc.column('job_id').doUpdateSet({
        phase: (eb) => eb.ref('excluded.phase'),
        last_processed_path: (eb) => eb.ref('excluded.last_processed_path'),
        files_seen: (eb) => eb.ref('excluded.files_seen'),
        files_processed: (eb) => eb.ref('excluded.files_processed'),
        items_added: (eb) => eb.ref('excluded.items_added'),
        items_updated: (eb) => eb.ref('excluded.items_updated'),
        items_removed: (eb) => eb.ref('excluded.items_removed'),
        updated_at_ms: (eb) => eb.ref('excluded.updated_at_ms'),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getCheckpoint(
  db: DbOrTx,
  jobId: string
): Promise<ScanCheckpointRow | undefined> {
  return db.selectFrom('scan_checkpoints').selectAll().where('job_id', '=', jobId).executeTakeFirst();
}
