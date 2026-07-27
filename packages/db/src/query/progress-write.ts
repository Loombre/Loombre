// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/progress-write.ts
//
// DECISION BEYOND SPEC (see catalog-detail.ts's header for the same
// pattern applied elsewhere this wave): the pre-existing public barrel only
// exposed progress READS (getContinueWatching/listProgress,
// src/query/progress.ts) — there was no progress WRITE function anywhere
// in this package, guarded or otherwise, yet the mission requires
// `PUT /progress/{itemId}` to upsert progress with "guarded item visibility
// check first (writing progress against an invisible item = 404)". This
// file is that missing write surface, kept in the PUBLIC barrel (not
// @loombre/db/internal) for the identical reason src/query/identity.ts's
// writes live there: apps/server (the only caller) is fenced off from the
// internal subpath by dependency-cruiser, and this write IS
// viewer-scoped — it is exactly the kind of guard-gated operation
// packages/db/query exists for (CLAUDE.md invariant 4), not scanner-
// internal bookkeeping.
//
// Visibility check: reuses getItemById(db, ctx, itemId) — the SAME guard
// every other surface in this package is built on — so "can this viewer
// write progress against this item" can never drift from "can this viewer
// read this item" (docs/PLAN.md §6.4: an uncleared viewer must not be able
// to confirm a restricted item's existence via a progress write side
// channel any more than via a read).
//
// play_count semantics (not specified by the contract beyond "increments on
// completed plays" being the conventional meaning): increments by exactly
// one when the INCOMING state is 'played' and the PREVIOUS row's state
// (if any) was NOT already 'played' — this avoids over-counting when a
// client keeps sending state:'played' heartbeats after the position has
// already settled at the end of a file.

import type { Kysely } from 'kysely';
import type { DB, WatchState } from '../types.js';
import type { ViewerContext } from '../context.js';
import { withTransaction, writeEvent } from '../internal/index.js';
import { getItemById } from './items.js';

export interface UpsertProgressInput {
  positionMs: number;
  state: WatchState;
  nowMs: number;
  /** migrations/0006_playback_sessions.sql — contract Progress.durationMs;
   *  client-supplied snapshot of the played file's duration. Omitted/undefined
   *  leaves the stored value untouched on an update (not reset to NULL) so a
   *  client that doesn't yet know the duration on an early heartbeat can't
   *  clobber a value a previous heartbeat already recorded. */
  durationMs?: number | null;
}

export interface ProgressWriteRow {
  itemId: string;
  positionMs: number;
  durationMs: number | null;
  state: WatchState;
  playCount: number;
  updatedAtMs: number;
}

/**
 * Single-item progress read (gap-closure lane, deliverable per STATE.md's
 * §6.4 leak checklist note n5 "GET /progress missing"). Returns `undefined`
 * in THREE indistinguishable cases, matching getItemById's own contract —
 * the caller (apps/server) turns all of them into the same 404:
 *   - the item does not exist,
 *   - the item exists but is not visible to `ctx` (unowned library /
 *     restricted-without-clearance — same guard upsertProgress uses, so
 *     this read can never leak an item's existence a write-side check
 *     wouldn't also already confirm), or
 *   - the item IS visible but this user has never recorded progress
 *     against it (no row to return — this is a single-resource read, not
 *     a list, so "no progress yet" is a 404 like any other missing
 *     resource, not an empty/default object).
 */
export async function getProgressForItem(
  db: Kysely<DB>,
  ctx: ViewerContext,
  itemId: string
): Promise<ProgressWriteRow | undefined> {
  const item = await getItemById(db, ctx, itemId);
  if (!item) return undefined;

  const row = await db
    .selectFrom('progress')
    .select(['item_id', 'position_ms', 'duration_ms', 'state', 'play_count', 'updated_at_ms'])
    .where('user_id', '=', ctx.userId)
    .where('item_id', '=', itemId)
    .executeTakeFirst();
  if (!row) return undefined;

  return {
    itemId: row.item_id,
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    state: row.state,
    playCount: row.play_count,
    updatedAtMs: row.updated_at_ms,
  };
}

/** Returns `undefined` when the item does not exist OR is not visible to
 *  `ctx` — indistinguishable, matching getItemById's own contract; the
 *  caller (apps/server) turns this into a 404.
 *
 *  Emits `progress.updated` in the SAME transaction as the upsert
 *  (docs/PLAN.md §4.3's outbox invariant), which is also why the
 *  read-then-upsert play_count computation below now runs inside that
 *  transaction rather than against two separate autocommit statements.
 *  Deliberately UNTHROTTLED, unlike playback-sessions.ts's
 *  `playback.progress` (at most once per 30s per session): that event
 *  tracks a live session's liveness, this one is the outbox record of a
 *  `progress` ROW CHANGE, and packages/contract/event-schemas/
 *  progress.updated.schema.json says "on each upsert ... including
 *  heartbeat-driven updates" — a consumer that skipped an upsert would
 *  observe a position that never existed in the table. */
export async function upsertProgress(
  db: Kysely<DB>,
  ctx: ViewerContext,
  itemId: string,
  input: UpsertProgressInput
): Promise<ProgressWriteRow | undefined> {
  const item = await getItemById(db, ctx, itemId);
  if (!item) return undefined;

  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('progress')
      .select(['play_count', 'state'])
      .where('user_id', '=', ctx.userId)
      .where('item_id', '=', itemId)
      .executeTakeFirst();

    const incrementPlayCount = input.state === 'played' && existing?.state !== 'played';
    const nextPlayCount = (existing?.play_count ?? 0) + (incrementPlayCount ? 1 : 0);

    const row = await trx
      .insertInto('progress')
      .values({
        user_id: ctx.userId,
        item_id: itemId,
        position_ms: input.positionMs,
        state: input.state,
        play_count: incrementPlayCount ? 1 : 0,
        updated_at_ms: input.nowMs,
        duration_ms: input.durationMs ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'item_id']).doUpdateSet({
          position_ms: input.positionMs,
          state: input.state,
          play_count: nextPlayCount,
          updated_at_ms: input.nowMs,
          // Only overwrite duration_ms when THIS heartbeat actually supplied
          // one — see UpsertProgressInput.durationMs's doc comment.
          ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    const result: ProgressWriteRow = {
      itemId: row.item_id,
      positionMs: row.position_ms,
      durationMs: row.duration_ms,
      state: row.state,
      playCount: row.play_count,
      updatedAtMs: row.updated_at_ms,
    };

    // ITEM_ONLY_TYPES delivery (src/query/events.ts): the payload carries
    // itemId, so the read side re-resolves the item's CURRENT visibility
    // per viewer. `userId` is additionally what LPP v1's
    // apps/worker/src/plugin-delivery/actor-field-map.ts pseudonymizes for
    // this type. Payload fields are exactly the schema's required set
    // (additionalProperties: false) — durationMs is not one of them.
    await writeEvent(trx, {
      type: 'progress.updated',
      tsMs: input.nowMs,
      actorUserId: ctx.userId,
      payload: {
        userId: ctx.userId,
        itemId,
        positionMs: result.positionMs,
        state: result.state,
        playCount: result.playCount,
        updatedAtMs: result.updatedAtMs,
      },
    });

    return result;
  });
}
