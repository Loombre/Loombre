// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/progress.ts
//
// getContinueWatching / listProgress — progress is keyed (user_id, item_id)
// with no content_class of its own, so its only guard surface is "does the
// referenced item pass the SAME guard applyGuard() enforces on direct
// catalog_items reads" — applyGuardToJoined against progress.item_id (see
// src/query/guard.ts header). Both queries additionally scope to
// ctx.userId: this module never returns another user's progress rows
// (that is a separate, non-restricted-content authorization concern the
// caller — apps/server — is expected to enforce at the route level by
// always passing ctx.userId as the subject; these two functions hard-code
// it as the only user_id they will ever query, so there is no parameter
// that could widen it).
//
// listProgress exists as its own leak-suite checklist item (todo 9)
// specifically because a progress row's mere EXISTENCE — an item id plus a
// playback position, with no title/metadata attached — is already a leak
// once the item is restricted and the viewer is uncleared: it confirms
// "this user has watched *something* in the restricted library" and hands
// back the item id to correlate elsewhere. Excluding rows whose item fails
// applyGuardToJoined closes that.
//
// Remediation adi-F1: BOTH functions here are now keyset-paginated on the
// identical (updated_at_ms DESC, item_id DESC) cursor (one shared
// ProgressCursorPayload below). getContinueWatching was the odd one out —
// `{limit?}`-only, by an intent recorded in its own doc comment that the
// contract it serves never agreed with. See that function's header.

import type { Kysely } from 'kysely';
import type { DB, ItemType, WatchState } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuardToJoined } from './guard.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';

export interface ContinueWatchingRow {
  itemId: string;
  itemTitle: string;
  itemType: ItemType;
  positionMs: number;
  state: WatchState;
  playCount: number;
  updatedAtMs: number;
}

export interface GetContinueWatchingParams {
  cursor?: string;
  limit?: number;
}

export interface GetContinueWatchingResult {
  rows: ContinueWatchingRow[];
  nextCursor: string | null;
}

/** The cursor payload BOTH queries in this module page on. One shape is
 *  correct here, not a coincidence: getContinueWatching and listProgress
 *  read the same table, hard-scoped to the same `user_id = ctx.userId`,
 *  ordered on the same (updated_at_ms DESC, item_id DESC) keyset — so the
 *  same (sort key, unique secondary key) pair identifies a position in
 *  either result set. */
interface ProgressCursorPayload {
  updatedAtMs: number;
  itemId: string;
}

function isProgressCursorPayload(value: unknown): value is ProgressCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).updatedAtMs === 'number' &&
    isCursorRowId((value as Record<string, unknown>).itemId)
  );
}

const CONTINUE_WATCHING_DEFAULT_LIMIT = 20;

/**
 * `progress.state = 'in-progress'` rows for ctx.userId whose item is
 * visible to ctx, newest-updated first, keyset-paginated on
 * (updated_at_ms, item_id) both descending — the SAME ordering and the
 * same cursor payload listProgress below pages on (deliberately shared:
 * both queries are hard-scoped to `user_id = ctx.userId`, so `item_id` is
 * the unique secondary key src/query/cursor.ts's tie-break law requires,
 * and a payload shape per function would be two names for one thing).
 *
 * Remediation adi-F1: this used to be `{limit?}`-only, documented as "not
 * cursor-paginated ... a bounded home row, not a browseable list". That
 * intent was never reconciled with the contract it serves —
 * packages/contract/openapi.yaml's `getContinueWatching` declares
 * #/components/parameters/Cursor and a ContinueWatchingPage whose
 * `nextCursor` is REQUIRED — so `GET /home/continue-watching?limit=1`
 * silently dropped every entry after the first and an SDK consumer
 * walking `nextCursor` could never reach them. Contract-first (CLAUDE.md
 * invariant #1) makes the contract the thing that wins, so the query
 * function grew the cursor rather than the contract losing it. A rail
 * caller that wants the old behaviour simply passes `limit` and ignores
 * `nextCursor` — the default limit is unchanged.
 */
export async function getContinueWatching(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: GetContinueWatchingParams = {}
): Promise<GetContinueWatchingResult> {
  const limit = params.limit ?? CONTINUE_WATCHING_DEFAULT_LIMIT;

  let query = db
    .selectFrom('progress')
    .innerJoin('catalog_items', 'catalog_items.id', 'progress.item_id')
    .where('progress.user_id', '=', ctx.userId)
    .where('progress.state', '=', 'in-progress')
    .where(applyGuardToJoined(ctx, 'progress.item_id'));

  if (params.cursor) {
    const { updatedAtMs, itemId } = decodeCursor(params.cursor, isProgressCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('progress.updated_at_ms', '<', updatedAtMs),
        eb.and([
          eb('progress.updated_at_ms', '=', updatedAtMs),
          eb('progress.item_id', '<', itemId),
        ]),
      ])
    );
  }

  const rows = await query
    .select([
      'progress.item_id as itemId',
      'catalog_items.title as itemTitle',
      'catalog_items.item_type as itemType',
      'progress.position_ms as positionMs',
      'progress.state as state',
      'progress.play_count as playCount',
      'progress.updated_at_ms as updatedAtMs',
    ])
    .orderBy('progress.updated_at_ms', 'desc')
    .orderBy('progress.item_id', 'desc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor({ updatedAtMs: last.updatedAtMs, itemId: last.itemId })
      : null;

  return { rows, nextCursor };
}

export interface ProgressRow {
  itemId: string;
  positionMs: number;
  durationMs: number | null;
  state: WatchState;
  playCount: number;
  updatedAtMs: number;
}

export interface ListProgressParams {
  cursor?: string;
  limit?: number;
}

export interface ListProgressResult {
  rows: ProgressRow[];
  nextCursor: string | null;
}

const LIST_PROGRESS_DEFAULT_LIMIT = 50;

/**
 * ALL progress rows for ctx.userId (any state), keyset-paginated on
 * (updated_at_ms, item_id) both descending — EXCLUDING rows whose item is
 * not visible to ctx (leak todo 9; see module header).
 */
export async function listProgress(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListProgressParams = {}
): Promise<ListProgressResult> {
  const limit = params.limit ?? LIST_PROGRESS_DEFAULT_LIMIT;

  let query = db
    .selectFrom('progress')
    .where('progress.user_id', '=', ctx.userId)
    .where(applyGuardToJoined(ctx, 'progress.item_id'));

  if (params.cursor) {
    const { updatedAtMs, itemId } = decodeCursor(params.cursor, isProgressCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('progress.updated_at_ms', '<', updatedAtMs),
        eb.and([
          eb('progress.updated_at_ms', '=', updatedAtMs),
          eb('progress.item_id', '<', itemId),
        ]),
      ])
    );
  }

  const rows = await query
    .select([
      'progress.item_id as itemId',
      'progress.position_ms as positionMs',
      'progress.duration_ms as durationMs',
      'progress.state as state',
      'progress.play_count as playCount',
      'progress.updated_at_ms as updatedAtMs',
    ])
    .orderBy('progress.updated_at_ms', 'desc')
    .orderBy('progress.item_id', 'desc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor({ updatedAtMs: last.updatedAtMs, itemId: last.itemId })
      : null;

  return { rows, nextCursor };
}
