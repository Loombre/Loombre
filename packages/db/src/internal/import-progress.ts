// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/import-progress.ts
//
// Data-freedom import addition (apps/worker/src/import — deliverable E).
// ADDITIVE, minimal: src/query/progress-write.ts's public upsertProgress()
// is the wrong tool for restore — it (a) is ViewerContext-guarded (calls
// getItemById(db, ctx, itemId) first, so it silently no-ops against an item
// this import transaction just created a moment ago but that the guard
// can't yet prove visible for unrelated reasons — e.g. a restricted library
// still mid-import, or the missing-file guard clause now that every
// imported leaf item's media_files placeholder is born already-missing,
// see apps/worker/src/import/consumer.ts's module header) and (b) derives
// play_count from a transition rule (increments by exactly one on a
// state->'played' edge) rather than accepting an exact value — the archive
// carries the CALLER's own already-exact play_count (packages/contract/
// openapi.yaml's Progress schema), and restoring it means writing that
// number verbatim, not re-deriving a new one from a fabricated transition.
// Guard-free by the same P1.13 carve-out as every sibling writer in this
// module: this is bulk-restore bookkeeping, not a live viewer action.

import type { Selectable } from 'kysely';
import type { ProgressTable, WatchState } from '../types.js';
import type { DbOrTx } from './tx.js';

export type ImportProgressRow = Selectable<ProgressTable>;

export interface InsertProgressExactInput {
  userId: string;
  itemId: string;
  positionMs: number;
  durationMs: number | null;
  state: WatchState;
  playCount: number;
  updatedAtMs: number;
}

/**
 * Exact-value progress insert for import. ON CONFLICT DO NOTHING rather
 * than an upsert: within one import run every (userId, itemId) pair is
 * write-once (the archive's own `progress` array has at most one entry per
 * item — see the import consumer's validator), so a conflict here can only
 * mean a re-run/retry against a target that already has this exact row;
 * leaving the existing row alone is the safe, idempotent choice.
 */
export async function insertProgressExact(db: DbOrTx, input: InsertProgressExactInput): Promise<void> {
  await db
    .insertInto('progress')
    .values({
      user_id: input.userId,
      item_id: input.itemId,
      position_ms: input.positionMs,
      duration_ms: input.durationMs,
      state: input.state,
      play_count: input.playCount,
      updated_at_ms: input.updatedAtMs,
    })
    .onConflict((oc) => oc.columns(['user_id', 'item_id']).doNothing())
    .execute();
}
