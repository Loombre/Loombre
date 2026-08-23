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
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';

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
  /**
   * Remediation adi-F2: restrict the page to this SET of item types — the
   * many-valued sibling of `itemType` above, for callers (today:
   * getRecentlyAdded, via apps/server's GET /home/recently-added) whose
   * response schema only admits a SUBSET of ItemType. It exists because a
   * caller that filters the returned page itself gets short — often EMPTY —
   * pages with a non-null `nextCursor`, since the keyset LIMIT was already
   * spent on rows it then threw away. Filtering here makes `limit` mean
   * "up to N rows you can actually use".
   *
   * An EMPTY array means "no type can match" (kysely renders `eb.or([])` as
   * `1 = 0`), never "no filter" — a caller computing the set dynamically
   * must not silently fall back to every type. Omit the key for "no filter".
   * Combines with `itemType` by AND if both are given; no caller does.
   */
  itemTypes?: readonly ItemType[];
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

// V1-002 (audit fafa47f, Fix Wave 4 lane FW4-A): this used to be a local
// encode/decode pair that predated src/query/cursor.ts's shared codec (see
// that file's header) and never adopted it — its `typeof parsed.id !==
// 'string'` shape check accepted ANY string, so a cursor whose `id` was
// not valid `uuid` input format (a corrupt/truncated/hand-edited cursor,
// not only a hand-forged one — this is the mainline `listItems`/
// `getRecentlyAdded` path) reached `eb('id', '<', id)` unvalidated and
// raised Postgres's 22P02 as an uncaught 500 instead of the 422 the
// contract declares. Routed through the shared decodeCursor/isCursorRowId
// so a malformed cursor here throws the same MalformedCursorError every
// other list surface in this package throws — never a bare Error/
// SyntaxError the HTTP layer can only render as a 500.
function isItemsCursorPayload(value: unknown): value is CursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).addedAtMs === 'number' &&
    isCursorRowId((value as Record<string, unknown>).id)
  );
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

  if (params.itemTypes) {
    const itemTypes = params.itemTypes;
    query = query.where((eb) => eb.or(itemTypes.map((t) => eb('item_type', '=', t))));
  }

  if (params.cursor) {
    const { addedAtMs, id } = decodeCursor(params.cursor, isItemsCursorPayload);
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
  /** See ListItemsParams.itemTypes (remediation adi-F2). The HTTP caller's
   *  RecentlyAddedEntry schema admits movie/series/album only, so it passes
   *  exactly those and gets full pages of them. */
  itemTypes?: readonly ItemType[];
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
