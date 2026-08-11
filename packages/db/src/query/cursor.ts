// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/cursor.ts
//
// Shared opaque-cursor codec for the keyset-pagination pattern
// src/query/items.ts established (base64url of a small JSON payload). Every
// NEW guarded query in this wave (search, people, tags, progress) uses this
// instead of re-deriving its own encode/decode pair. As of Fix Wave 4
// (audit fafa47f, FW4-A) items.ts itself ALSO routes through this codec —
// its original local helpers threw bare Errors on malformed cursors and
// were deleted in favor of decodeCursor + isCursorRowId here.
//
// Security note (adversarial "cursor forgery" test, packages/db/test/
// leak.spec.ts): a cursor is ONLY ever used as a keyset comparison bound
// (`WHERE (sortKey, id) < (cursor.sortKey, cursor.id)`) applied AFTER the
// guard's WHERE clauses, never as a lookup key. Handing the codec a
// hand-crafted payload pointing at a restricted row's id lets an attacker
// pick *where in the already-guard-filtered result set* pagination resumes
// — it cannot make an invisible row visible, because the guard predicates
// are unconditional on every guarded query regardless of cursor content.

// Tie-break law for every keyset cursor built with this codec (Task #9
// triage, STATE.md): every list/search surface in this package that pages
// on an application sort key (created_at_ms, added_at_ms, started_at_ms,
// name, ord, ...) ALSO orders on a unique secondary key — `id` (the row's
// own UUIDv7 PK) for globally-unique tables, or a column unique within the
// query's fixed scope (e.g. progress/watchlist/restricted-home's
// `item_id`, already unique per user since those tables are always
// additionally filtered to `user_id = ctx.userId`) where there is no
// row-level PK to reach for. That secondary key is what makes the
// resulting keyset pagination CORRECT — no row is ever skipped or
// duplicated across pages, including when many rows share the exact same
// primary sort-key value — because `(primary key, secondary key)` is
// always unique per row, so the keyset comparison
// `(k, secondary) < (cursor.k, cursor.secondary)` strictly and completely
// orders the result set with no ties left over.
//
// What it does NOT give you: causal/insertion order among rows that tie on
// the primary sort key. When the secondary key is a UUIDv7 `id`, its
// non-timestamp bits are plain `random()` with no monotonic fallback for
// same-millisecond collisions (migrations/0039_events_seq.sql's header has
// the full analysis) — so on a tie, which row sorts first is a stable
// coin flip, not "whichever was written first". That is an acceptable,
// deliberate trade-off for these browse/list/admin surfaces: a user
// paging through a catalog or admin list needs "never see a dup, never
// miss a row" (guaranteed above), not "same-millisecond siblings appear in
// write order" (not guaranteed, and no surface here depends on it). When a
// caller DOES need genuine causal order — e.g. an audit trail or an
// outbox read where "which of two same-millisecond events happened first"
// is part of the contract — `events.seq` (migrations/0039_events_seq.sql)
// is the pattern: a Postgres identity-sequence column, assigned
// synchronously in call order with no possible tie and no dependence on
// any clock, used as the ENTIRE sort key rather than a tiebreak alongside
// a timestamp (packages/jobs/test/ledger-events.spec.ts's
// jobUpdatedEventsFor is the worked example, including the historical
// flake `ORDER BY id` caused before that column existed).

export function encodeCursor<T>(payload: T): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Postgres's own `uuid` input format — the shared copy of the pattern
 * catalog-detail.ts/restricted-browse.ts each carry for filter ids. Every
 * cursor payload in this package keys on a UUIDv7 row id, so validating it
 * belongs with the codec: binding a non-uuid string into a `uuid` column
 * comparison raises 22P02 inside the driver, which the HTTP layer can only
 * render as a 500 for what is a client input mistake (R1 review lane —
 * three zone list surfaces did exactly that, see isCursorRowId's callers).
 */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True iff `value` is a string in Postgres's `uuid` input format — the
 *  check every cursor payload validator must apply to its row-id field
 *  before that value can reach a `uuid` column comparison. */
export function isCursorRowId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Thrown by decodeCursor for a cursor this server did not mint (bad
 * base64url/JSON, wrong payload shape, or a row id that is not a uuid).
 * A distinct class rather than a bare Error so apps/server can map it to
 * a 4xx problem+json without string-matching a message — the same
 * typed-error-across-the-package-boundary pattern
 * LibraryNotFoundForStashError (src/query/stash-connections.ts) already
 * establishes. Client input is never a 500.
 */
export class MalformedCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedCursorError';
  }
}

/**
 * Decodes and validates a cursor payload against `isValid`. Throws
 * MalformedCursorError on malformed base64url/JSON or a payload failing
 * `isValid` — callers should treat it as "bad request", never silently
 * ignore the cursor (which would produce a confusing "page 1 again"
 * result).
 */
export function decodeCursor<T>(cursor: string, isValid: (value: unknown) => value is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new MalformedCursorError('malformed cursor: not valid base64url-encoded JSON');
  }
  if (!isValid(parsed)) {
    throw new MalformedCursorError('malformed cursor: payload shape mismatch');
  }
  return parsed;
}
