// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/db.ts
//
// createDb() is the only way to get a Kysely handle out of this package.
// It is exported from the barrel (src/index.ts) because the query functions
// (getItemById, listItems) take it as their first argument — server code
// needs to construct one and hand it in. It is deliberately NOT the same
// thing as exporting a raw ambient `db` singleton or `applyGuard`: nothing
// here bypasses the guard on its own, and dependency-cruiser (configured at
// the repo root) forbids importing `pg`/`kysely` outside packages/db, so
// call sites outside this package can only ever obtain a handle through
// createDb() and can only query it through the guarded functions this
// package chooses to export.
//
// Hardening note (tracked as a known gap, not swept under the rug): a
// Kysely instance is a general-purpose query builder, so a caller *inside*
// packages/db — or anything holding a reference returned by createDb() —
// is not physically prevented from calling `.selectFrom('catalog_items')`
// directly. The guard is enforced by (a) code review + this file's comment,
// and (b) every exported query function in src/query/* always routing
// through applyGuard(). A future hardening pass could return a narrower
// object instead of the full Kysely instance; left as-is for Phase 0 since
// the spec calls for exporting createDb() directly.

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';

// BIGINT (OID 20) comes back from node-postgres as a string by default,
// because JS numbers cannot safely hold all 64-bit values. Every BIGINT in
// this schema is an epoch-millisecond timestamp (or a byte/duration count
// far below 2^53), so parsing it straight to a JS number is safe and much
// more ergonomic for the query layer than juggling strings everywhere.
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

// DATE (OID 1082) comes back from node-postgres as a JS Date by default,
// silently applying a local-timezone interpretation to a value that has no
// time-of-day or zone component at all (users.birth_date). Every DATE
// column in this schema is typed `string` (YYYY-MM-DD, matching the
// contract's `format: date` fields — CLAUDE.md invariant 5's "no Date
// objects cross a boundary" spirit) — pass the raw text through unchanged.
pg.types.setTypeParser(1082, (value: string) => value);

export function createDb(connectionString: string): Kysely<DB> {
  const pool = new pg.Pool({ connectionString });
  const dialect = new PostgresDialect({ pool });
  return new Kysely<DB>({ dialect });
}
