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
 * Decodes and validates a cursor payload against `isValid`. Throws on
 * malformed base64url/JSON or a payload failing `isValid` — callers should
 * treat a thrown error as "bad request", never silently ignore the cursor
 * (which would produce a confusing "page 1 again" result).
 */
export function decodeCursor<T>(cursor: string, isValid: (value: unknown) => value is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed cursor: not valid base64url-encoded JSON');
  }
  if (!isValid(parsed)) {
    throw new Error('malformed cursor: payload shape mismatch');
  }
  return parsed;
}
