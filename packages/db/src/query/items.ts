// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/items.ts
//
// The two real guarded catalog queries the Phase 0 skeleton ships with.
// Every row that reaches a caller has already passed applyGuard() — see
// src/query/guard.ts. These are the entry points src/index.ts exports;
// nothing else in this package reads catalog_items.

import type { Kysely, Selectable } from 'kysely';
import type { DB, CatalogItemsTable, ItemType } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyGuard } from './guard.js';

export type CatalogItemRow = Selectable<CatalogItemsTable>;

/**
 * Fetch a single catalog item by id, or `undefined` if it does not exist OR
 * the viewer's context does not clear it (wrong library, or restricted and
 * not cleared). Callers cannot distinguish "does not exist" from "exists but
 * hidden" from the return value alone — this is deliberate: it is the same
 * shape a 404 becomes at the API layer, and leaking existence of hidden rows
 * (even without content) is exactly the kind of side channel §6.4 requires
 * closed.
 */
export async function getItemById(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string
): Promise<CatalogItemRow | undefined> {
  const query = applyGuard(
    db.selectFrom('catalog_items').selectAll().where('id', '=', id),
    ctx
  );
  return query.executeTakeFirst();
}

export interface ListItemsParams {
  itemType?: ItemType;
  /** Opaque cursor from a previous page's `nextCursor`. Omit for page 1. */
  cursor?: string;
  /** Page size. Defaults to 50. */
  limit?: number;
}

export interface ListItemsResult {
  rows: CatalogItemRow[];
  /** Base64 cursor for the next page, or null if this was the last page. */
  nextCursor: string | null;
}

interface CursorPayload {
  addedAtMs: number;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorPayload {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.addedAtMs !== 'number' ||
    typeof parsed.id !== 'string'
  ) {
    throw new Error('listItems: malformed cursor');
  }
  return { addedAtMs: parsed.addedAtMs, id: parsed.id };
}

const DEFAULT_LIMIT = 50;

/**
 * List catalog items visible to `ctx`, newest-added first, keyset-paginated
 * on `(added_at_ms, id)` (both descending) so pagination is stable under
 * concurrent inserts — no OFFSET drift.
 */
export async function listItems(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListItemsParams = {}
): Promise<ListItemsResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = applyGuard(db.selectFrom('catalog_items').selectAll(), ctx);

  if (params.itemType) {
    query = query.where('item_type', '=', params.itemType);
  }

  if (params.cursor) {
    const { addedAtMs, id } = decodeCursor(params.cursor);
    query = query.where((eb) =>
      eb.or([
        eb('added_at_ms', '<', addedAtMs),
        eb.and([eb('added_at_ms', '=', addedAtMs), eb('id', '<', id)]),
      ])
    );
  }

  const rows = await query
    .orderBy('added_at_ms', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor({ addedAtMs: last.added_at_ms, id: last.id })
      : null;

  return { rows, nextCursor };
}

export interface GetRecentlyAddedParams {
  cursor?: string;
  limit?: number;
}

/**
 * "Recently added" home row (docs/PLAN.md §6.4 task spec item 5): guarded
 * items newest-added first. listItems() already IS exactly this query
 * (guard + `added_at_ms DESC, id DESC` keyset pagination, no itemType
 * filter needed) — this is a documented thin wrapper, not a reimplementation,
 * so there is only one place the ordering/guard logic can drift.
 *
 * Deliberately per-ViewerContext and never cached across differing
 * clearances (leak todo 6) — see clearanceDigest() in
 * src/query/clearance.ts, the cache-key input a caller must mix in if it
 * memoizes this; this function itself does no caching. See
 * packages/db/test/leak.spec.ts for the test proving two contexts with
 * different clearance get different output from the same call shape.
 */
export async function getRecentlyAdded(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: GetRecentlyAddedParams = {}
): Promise<ListItemsResult> {
  return listItems(db, ctx, params);
}
