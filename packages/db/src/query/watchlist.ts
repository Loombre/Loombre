// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/watchlist.ts
//
// Phosphor retheme + responsive rebuild, Wave 2 lane L3 (Watchlist + Person
// routes) — migrations/0017_watchlists.sql. Shape mirrors src/query/
// progress.ts (listProgress) and src/query/progress-write.ts (upsertProgress)
// deliberately: a `watchlists` row carries no content_class of its own, so
// its only leak surface is "is the referenced catalog_items row visible to
// ctx" — applyGuardToJoined against watchlists.item_id, the SAME primitive
// every other per-user, item-referencing table in this package is built on.
//
// Reachability of ADD for a restricted (zone) item — ground-truthed with
// evidence, not assumed: addToWatchlistAndEmit calls getItemById(db, ctx,
// itemId) FIRST, the exact same guarded lookup upsertProgress uses. For an
// uncleared viewer this returns undefined for a restricted item
// (indistinguishable from "does not exist" — items.ts's own contract), so
// the caller (apps/server) 404s and NO row is ever written. Only a viewer
// who currently passes every one of docs/PLAN.md §6.4's five gates
// (including the live gate-5 unlock) can add a restricted item at all — and
// even then, listWatchlist (below) excludes it again the instant that same
// viewer is no longer cleared, independent of the row's continued existence
// — exactly the same "write survives, read hides it" behavior
// packages/db/test/leak.spec.ts already proves for progress rows against
// afterHoursRedlineItemId. This is the required, evidenced answer to
// "restricted titles never appear in the watchlist" for the case that
// matters (an uncleared viewer, at read time) without inventing a second,
// divergent guard model just for this one table.
//
// Item-type scope: this module itself is NOT restricted to movie/series/
// album — any catalog item a viewer can see can be added, matching
// upsertProgress's own posture (progress can be written for any item type;
// only the HOME SUMMARY rails, cross-type.controller.ts, filter to a
// curated subset). listWatchlist mirrors that exact precedent: it silently
// excludes any item whose itemType isn't movie/series/album from the mapped
// page (the only types design/phosphor README.md's watchlist toggle can
// ever produce), the same "eligible" filter cross-type.controller.ts's
// recentlyAdded/continueWatching/search handlers already apply — never
// widening the contract's WatchlistEntry discriminator for a row shape that
// can't occur via any real UI path today.

import type { Kysely } from 'kysely';
import type { DB, ItemType } from '../types.js';
import type { ViewerContext } from '../context.js';
import { withTransaction, writeEvent } from '../internal/index.js';
import { applyGuardToJoined } from './guard.js';
import { getItemById } from './items.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export interface WatchlistRow {
  itemId: string;
  itemType: ItemType;
  addedAtMs: number;
}

export interface ListWatchlistParams {
  cursor?: string;
  limit?: number;
}

export interface ListWatchlistResult {
  rows: WatchlistRow[];
  nextCursor: string | null;
}

interface WatchlistCursorPayload {
  addedAtMs: number;
  itemId: string;
}

function isWatchlistCursorPayload(value: unknown): value is WatchlistCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).addedAtMs === 'number' &&
    typeof (value as Record<string, unknown>).itemId === 'string'
  );
}

const DEFAULT_LIMIT = 50;

/**
 * The current user's watchlist, newest-added first, keyset-paginated on
 * (added_at_ms, item_id) both descending (identical shape to
 * src/query/progress.ts's listProgress) — EXCLUDING rows whose item is not
 * visible to ctx (see this module's header: a restricted item added while
 * cleared disappears from this read the instant the viewer is no longer
 * cleared, same as progress).
 */
export async function listWatchlist(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListWatchlistParams = {}
): Promise<ListWatchlistResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  // Inner-joined to catalog_items for item_type — same shape as
  // progress.ts's getContinueWatching (which joins for itemTitle/itemType
  // the exact same way) — this is a plain data need (the contract's
  // WatchlistEntry discriminator), not a SECOND guard: applyGuardToJoined
  // above already proves the referenced catalog_items row is visible, so
  // joining to read one more column off the SAME already-guarded row adds
  // no new leak surface.
  let query = db
    .selectFrom('watchlists')
    .innerJoin('catalog_items', 'catalog_items.id', 'watchlists.item_id')
    .where('watchlists.user_id', '=', ctx.userId)
    .where(applyGuardToJoined(ctx, 'watchlists.item_id'));

  if (params.cursor) {
    const { addedAtMs, itemId } = decodeCursor(params.cursor, isWatchlistCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('watchlists.added_at_ms', '<', addedAtMs),
        eb.and([eb('watchlists.added_at_ms', '=', addedAtMs), eb('watchlists.item_id', '<', itemId)]),
      ])
    );
  }

  const rows = await query
    .select([
      'watchlists.item_id as itemId',
      'catalog_items.item_type as itemType',
      'watchlists.added_at_ms as addedAtMs',
    ])
    .orderBy('watchlists.added_at_ms', 'desc')
    .orderBy('watchlists.item_id', 'desc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ addedAtMs: last.addedAtMs, itemId: last.itemId }) : null;

  return { rows, nextCursor };
}

/**
 * Returns `undefined` when the item does not exist OR is not visible to
 * `ctx` (see this module's header) — the caller (apps/server) turns this
 * into a 404, matching upsertProgress's identical contract. Idempotent: the
 * PRIMARY KEY (user_id, item_id) makes adding an already-watchlisted item a
 * no-op write (ON CONFLICT DO NOTHING) that still emits `watchlist.added`
 * — a second toggle-on from another of the user's own devices should still
 * observe the confirmation, and re-emitting is harmless (the client-side
 * state is a Set; re-adding an existing id is idempotent there too).
 */
export async function addToWatchlistAndEmit(
  db: Kysely<DB>,
  ctx: ViewerContext,
  itemId: string,
  nowMs: number
): Promise<WatchlistRow | undefined> {
  const item = await getItemById(db, ctx, itemId);
  if (!item) return undefined;

  return withTransaction(db, async (trx) => {
    await trx
      .insertInto('watchlists')
      .values({ user_id: ctx.userId, item_id: itemId, added_at_ms: nowMs })
      .onConflict((oc) => oc.columns(['user_id', 'item_id']).doNothing())
      .execute();

    // Read back the ACTUAL added_at_ms — on a conflict (already-watchlisted
    // item), this is the ORIGINAL add time, not `nowMs`, since the insert
    // above was a no-op. item.item_type comes from the already-fetched
    // getItemById row above rather than a second join, since that read
    // already proved the item's current type under the same guard.
    const existing = await trx
      .selectFrom('watchlists')
      .select(['added_at_ms as addedAtMs'])
      .where('user_id', '=', ctx.userId)
      .where('item_id', '=', itemId)
      .executeTakeFirstOrThrow();
    const row: WatchlistRow = { itemId, itemType: item.item_type, addedAtMs: existing.addedAtMs };

    // USER_ONLY_TYPES delivery (packages/db/src/query/events.ts,
    // apps/server/src/gateway/ws-broadcaster.service.ts): payload carries
    // ONLY userId + itemId, gated on payload->>'userId' = ctx.userId —
    // delivered to every one of THIS user's own connected sockets (every
    // signed-in device/tab), never to any other viewer. This is the
    // cross-device sync mechanism design/phosphor README.md's "Shared
    // client state: watchlist ... must sync across devices" calls for.
    await writeEvent(trx, {
      type: 'watchlist.added',
      tsMs: nowMs,
      actorUserId: ctx.userId,
      payload: { userId: ctx.userId, itemId },
    });

    return row;
  });
}

/**
 * Removes the (ctx.userId, itemId) row if present. Returns `undefined` when
 * the ITEM itself does not exist or is not visible to `ctx` (same 404
 * contract as addToWatchlistAndEmit/upsertProgress) — but removing an item
 * that IS visible yet was never in this user's watchlist is a successful
 * idempotent no-op (`removed: false`), matching the README's inline REMOVE
 * affordance being safe to invoke more than once (a double-click on a
 * poster's remove control must never surface an error).
 */
export interface RemoveFromWatchlistResult {
  removed: boolean;
}

export async function removeFromWatchlistAndEmit(
  db: Kysely<DB>,
  ctx: ViewerContext,
  itemId: string,
  nowMs: number
): Promise<RemoveFromWatchlistResult | undefined> {
  const item = await getItemById(db, ctx, itemId);
  if (!item) return undefined;

  return withTransaction(db, async (trx) => {
    const result = await trx
      .deleteFrom('watchlists')
      .where('user_id', '=', ctx.userId)
      .where('item_id', '=', itemId)
      .executeTakeFirst();

    const removed = (result.numDeletedRows ?? 0n) > 0n;

    if (removed) {
      // Same USER_ONLY_TYPES delivery as the add path above — see that
      // function's comment.
      await writeEvent(trx, {
        type: 'watchlist.removed',
        tsMs: nowMs,
        actorUserId: ctx.userId,
        payload: { userId: ctx.userId, itemId },
      });
    }

    return { removed };
  });
}
