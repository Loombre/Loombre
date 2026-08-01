// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/cursor.ts
//
// Shared opaque-cursor codec for the keyset-pagination pattern
// src/query/items.ts established (base64url of a small JSON payload). Every
// NEW guarded query in this wave (search, people, tags, progress) uses this
// instead of re-deriving its own encode/decode pair. items.ts's original
// local helpers are left as-is (untouched, still tested, no behavior
// change) — this is purely for the additions in this package.
//
// Security note (adversarial "cursor forgery" test, packages/db/test/
// leak.spec.ts): a cursor is ONLY ever used as a keyset comparison bound
// (`WHERE (sortKey, id) < (cursor.sortKey, cursor.id)`) applied AFTER the
// guard's WHERE clauses, never as a lookup key. Handing the codec a
// hand-crafted payload pointing at a restricted row's id lets an attacker
// pick *where in the already-guard-filtered result set* pagination resumes
// — it cannot make an invisible row visible, because the guard predicates
// are unconditional on every guarded query regardless of cursor content.

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
