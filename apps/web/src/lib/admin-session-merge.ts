// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-session-merge.ts
//
// Applying a fresh PAGE 1 of GET /admin/sessions to a list the admin may
// have paged past — the "how" half of the live refresh (lib/
// admin-live-refresh.ts owns the "when").
//
// WHY (d3-e4): app/admin/sessions' silent refresh used to `setSessions(page
// .items)` outright, which is correct only while the admin is still on page
// 1. With more than PAGE_LIMIT live sessions, every "Load more" page they
// opened was thrown away within one tick (10s) — the list visibly snapped
// back and the button reappeared.
//
// The keyset this merge relies on is the server's own ORDER BY
// (packages/db/src/query/admin.ts's listActiveSessionsAdmin): startedAtMs
// DESC, then id DESC. Page 1 is therefore authoritative for EVERYTHING at
// or above its oldest row — a previously-known row inside that window that
// page 1 no longer contains has genuinely ended — and says nothing at all
// about rows below it, which is exactly the set "Load more" fetched.

/** The subset of an AdminSession this merge needs (kept structural so the
 *  SDK type, and any test fixture, both satisfy it). */
export interface MergeableAdminSession {
  id: string;
  startedAtMs: number;
}

/** True when `row` sorts strictly AFTER `boundary` in the server's
 *  (startedAtMs DESC, id DESC) order — i.e. it lies below page 1's window. */
function isOlderThan(row: MergeableAdminSession, boundary: MergeableAdminSession): boolean {
  if (row.startedAtMs !== boundary.startedAtMs) return row.startedAtMs < boundary.startedAtMs;
  return row.id < boundary.id;
}

/**
 * Merge a freshly-fetched page 1 into the currently-displayed list.
 *
 * - Rows in `incoming` win outright (they carry the live status/heartbeat
 *   fields the refresh exists to update), and their order is kept.
 * - Rows the caller already had that are OLDER than page 1's last row are
 *   preserved untouched — page 1 never claimed anything about them.
 * - Rows inside page 1's window that page 1 no longer returns are dropped:
 *   those sessions ended.
 *
 * `complete` (nextCursor === null on the fresh page) means page 1 IS the
 * whole live set, so there is no window to be outside of — anything absent
 * from it is gone.
 */
export function mergeAdminSessionFirstPage<T extends MergeableAdminSession>(
  previous: readonly T[],
  incoming: readonly T[],
  options: { complete: boolean },
): T[] {
  if (options.complete) return [...incoming];

  const boundary = incoming[incoming.length - 1];
  // An empty non-complete page is a contradiction the server cannot
  // produce; treat it as "nothing new to say" rather than wiping the list.
  if (!boundary) return [...previous];

  const incomingIds = new Set(incoming.map((row) => row.id));
  const kept = previous.filter((row) => !incomingIds.has(row.id) && isOlderThan(row, boundary));
  return [...incoming, ...kept];
}
