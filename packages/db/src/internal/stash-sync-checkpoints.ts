// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/stash-sync-checkpoints.ts
//
// stash_sync_checkpoints reader/writer (deliverable 2, STATE.md S8,
// migrations/0020_stash_sync_reports.sql). Mirrors ./checkpoints.ts's own
// shape and onConflict-upsert mechanism exactly — see that migration's
// header for why this is a SEPARATE table rather than a reuse of
// scan_checkpoints (column-semantics honesty: a Stash scene id does not
// belong in a column named `last_processed_path`). Worker-internal only —
// no admin surface ever reads this table directly; apps/worker/src/stash/
// sync-consumer.ts is the sole reader/writer, via createDb(...).internal.

import type { Selectable } from 'kysely';
import type { StashSyncCheckpointsTable } from '../types.js';
import type { DbOrTx } from './tx.js';

export type StashSyncCheckpointRow = Selectable<StashSyncCheckpointsTable>;

export interface WriteStashSyncCheckpointInput {
  jobId: string;
  libraryId: string;
  phase: string;
  lastProcessedStashSceneId?: string | null;
  scenesSeen?: number;
  scenesProcessed?: number;
  updatedAtMs: number;
}

export async function writeStashSyncCheckpoint(
  db: DbOrTx,
  input: WriteStashSyncCheckpointInput
): Promise<StashSyncCheckpointRow> {
  return db
    .insertInto('stash_sync_checkpoints')
    .values({
      job_id: input.jobId,
      library_id: input.libraryId,
      phase: input.phase,
      last_processed_stash_scene_id: input.lastProcessedStashSceneId ?? null,
      ...(input.scenesSeen !== undefined ? { scenes_seen: input.scenesSeen } : {}),
      ...(input.scenesProcessed !== undefined ? { scenes_processed: input.scenesProcessed } : {}),
      updated_at_ms: input.updatedAtMs,
    })
    .onConflict((oc) =>
      oc.column('job_id').doUpdateSet({
        phase: (eb) => eb.ref('excluded.phase'),
        last_processed_stash_scene_id: (eb) => eb.ref('excluded.last_processed_stash_scene_id'),
        scenes_seen: (eb) => eb.ref('excluded.scenes_seen'),
        scenes_processed: (eb) => eb.ref('excluded.scenes_processed'),
        updated_at_ms: (eb) => eb.ref('excluded.updated_at_ms'),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getStashSyncCheckpoint(
  db: DbOrTx,
  jobId: string
): Promise<StashSyncCheckpointRow | undefined> {
  return db.selectFrom('stash_sync_checkpoints').selectAll().where('job_id', '=', jobId).executeTakeFirst();
}

/** Best-effort cleanup once a run reaches a genuinely terminal state
 *  (succeeded, or failed with no more retries) — the checkpoint's only
 *  purpose is resuming an IN-FLIGHT job, so a finished job's row is inert
 *  bookkeeping from then on. Never called on a still-retryable failure
 *  (the whole point of the row is to survive exactly that case). */
export async function deleteStashSyncCheckpoint(db: DbOrTx, jobId: string): Promise<void> {
  await db.deleteFrom('stash_sync_checkpoints').where('job_id', '=', jobId).execute();
}
