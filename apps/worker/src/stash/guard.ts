// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/guard.ts
//
// STATE.md S3: the schema-version guard. Reads Stash's own
// `schema_migrations` table (golang-migrate's default driver table —
// verified against Stash's source, pkg/sqlite/migrate.go +
// github.com/golang-migrate/migrate's sqlite3 driver, 2026-08-01: exactly
// one row, `SELECT version, dirty FROM schema_migrations LIMIT 1`) and
// checks it against a PINNED, fixture-tested supported range. Outside that
// range, the provider disables with the EXACT notice format
// "Stash schema vNN unsupported; supported: X-Y" — never best-effort
// parsing of an unrecognized shape.
//
// Range justification (recon, 2026-08-01 — see
// apps/worker/test/stash/fixtures/README.md for the full release-history
// table this was derived from): Stash schema versions 67-85 cover stable
// releases v0.27.0 (2024-09-23) through v0.31.1 (2026-04-13), i.e.
// everything supported-latest as of this run. 67 is the lower bound
// because it is the oldest schema version still shipped by a release line
// the owner is plausibly running (~1.5-2 years of stable releases); a
// pre-67 database asks the owner to upgrade Stash rather than asking
// Loombre to carry indefinite legacy-schema logic. 85 is the upper bound
// because it is literally the newest schema that exists upstream as of
// this recon (develop HEAD) — there is nothing newer to support yet.
export const STASH_SUPPORTED_SCHEMA_MIN = 67;
export const STASH_SUPPORTED_SCHEMA_MAX = 85;

export interface StashSchemaVersion {
  version: number;
  dirty: boolean;
}

/** Reads the exact S3 notice format — a single source so guard.ts and its
 *  tests, connect.ts's event payload, and library_stash_connections.
 *  status_detail can never drift from each other. */
export function formatUnsupportedSchemaNotice(seenVersion: number): string {
  return `Stash schema v${seenVersion} unsupported; supported: ${STASH_SUPPORTED_SCHEMA_MIN}-${STASH_SUPPORTED_SCHEMA_MAX}`;
}

export type StashSchemaGuardResult =
  | { supported: true; version: number }
  | { supported: false; version: number; notice: string };

/** Pure decision function — never touches the database itself (that's
 *  readSchemaVersion below); a connect.ts caller reads the version once
 *  and hands it here, so this rule is unit-testable with zero I/O. */
export function checkStashSchemaVersion(schema: StashSchemaVersion): StashSchemaGuardResult {
  if (schema.version >= STASH_SUPPORTED_SCHEMA_MIN && schema.version <= STASH_SUPPORTED_SCHEMA_MAX) {
    return { supported: true, version: schema.version };
  }
  return { supported: false, version: schema.version, notice: formatUnsupportedSchemaNotice(schema.version) };
}

/** Thrown when `schema_migrations` is missing/empty/malformed — this is a
 *  DIFFERENT failure class from "outside the supported range" (S3 is
 *  explicit: never best-effort parsing of an unrecognized shape). A
 *  database this alien is not a Stash database Loombre understands at
 *  all; connect.ts maps this to `status = 'unreachable'`, not
 *  `'unsupported_schema'` (which implies "recognized Stash shape, wrong
 *  version"). */
export class StashSchemaMigrationsUnreadableError extends Error {
  constructor(cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`stash: could not read schema_migrations (not a recognizable Stash database?): ${causeMessage}`);
    this.name = 'StashSchemaMigrationsUnreadableError';
  }
}

interface SqliteConnectionLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/** Reads the single schema_migrations row off an already-open connection
 *  (apps/worker/src/stash/adapter.ts's StashConnection.db, or a plain
 *  node:sqlite DatabaseSync in tests — the minimal `prepare().get()`
 *  shape is all this needs). */
export function readSchemaVersion(db: SqliteConnectionLike): StashSchemaVersion {
  let row: unknown;
  try {
    row = db.prepare('SELECT version, dirty FROM schema_migrations LIMIT 1').get();
  } catch (err) {
    throw new StashSchemaMigrationsUnreadableError(err);
  }
  if (
    row === null ||
    typeof row !== 'object' ||
    !('version' in row) ||
    typeof (row as { version: unknown }).version !== 'number'
  ) {
    throw new StashSchemaMigrationsUnreadableError(new Error(`unexpected schema_migrations row shape: ${JSON.stringify(row)}`));
  }
  const dirtyRaw = (row as { dirty?: unknown }).dirty;
  return { version: (row as { version: number }).version, dirty: Boolean(dirtyRaw) };
}
