// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/testing.ts
//
// Test-support only (never imported by production code paths): provisions a
// dedicated Postgres database derived from a base connection string, so a
// package's own self-sufficient live-DB test suites (which each run
// `scripts/migrate.mjs reset` — DROP SCHEMA public CASCADE + replay — in
// their own beforeAll) never race a SIBLING package's concurrent reset
// against the same database. Discovered need: turbo's `test` task
// parallelizes independent packages (e.g. @loombre/jobs and @loombre/server
// both depend on @loombre/db but not on each other), and two concurrent
// `DROP SCHEMA ... CASCADE` + migrate replays against ONE database can
// Postgres-deadlock. Giving each package's test run its own
// `<base>_<suffix>` database removes the collision by construction, without
// touching packages/jobs or the shared reset script itself.
//
// Exported from the public barrel because it's the only place `pg` may be
// imported (dependency-cruiser); callers are still test files, never
// runtime request paths.

import pg from 'pg';

/**
 * Resolves the connection string a DB-backed test suite should use, NEVER
 * the operator's live database (2026-08-10 incident: packages/jobs/test/
 * queue.spec.ts's beforeAll spawned `migrate.mjs reset` — DROP SCHEMA
 * public CASCADE — straight against DATABASE_URL's bare default, which
 * happened to be the live dev database, because nothing distinguished "a
 * test run" from "an operator's real database" except convention. This
 * makes the distinction structural instead: scripts/migrate.mjs's `reset`
 * command (see its own header) now REFUSES to run against any database
 * whose name doesn't look like a test database, and this function is the
 * one place that decides what "looks like a test database" means, so
 * every caller derives the same name.
 *
 * Precedence:
 *   1. `LOOMBRE_TEST_DATABASE_URL` — explicit override, used verbatim.
 *   2. `DATABASE_URL` with its database name rewritten to `<name>_test`.
 *   3. The hardcoded default `postgres://loombre:loombre@localhost:5442/loombre_test`.
 *
 * This function still only decides what a test database is NAMED — it
 * never asks whether a given database is actually disposable, because it
 * does not connect. That used to be a live footgun (a dev stack pinned at
 * `.../loombre_test` sailed through the name guard and got DROP SCHEMA'd
 * by a test run — the 2026-08-10 incident one layer further out). It no
 * longer is: `scripts/migrate.mjs reset` additionally refuses any database
 * with a live Loombre process attached, and any populated database that
 * was never CLAIMED as disposable — see that script's LIVE-DATABASE GUARD
 * header, and `claimDisposableTestDatabase` below, which is how databases
 * this module provisions get claimed.
 *
 * Pure string manipulation — does not connect, does not create anything.
 * Pair with `ensureTestDatabase` (below) when a suite additionally needs
 * its own sibling-isolated database (avoiding a cross-package concurrent-
 * reset race under turbo — see that function's header) rather than the
 * single shared `<name>_test` database.
 */
export function resolveTestDatabaseUrl(): string {
  const override = process.env['LOOMBRE_TEST_DATABASE_URL'];
  if (override) return override;

  const base = process.env['DATABASE_URL'] ?? 'postgres://loombre:loombre@localhost:5442/loombre';
  const url = new URL(base);
  const baseDbName = url.pathname.replace(/^\//, '') || 'loombre';
  url.pathname = `/${baseDbName.endsWith('_test') ? baseDbName : `${baseDbName}_test`}`;
  return url.toString();
}

/**
 * The COMMENT ON DATABASE text marking a database as the test harness's
 * own disposable property — the "provenance" half of
 * `scripts/migrate.mjs reset`'s live-database guard (task #11 residual a).
 * A database comment is a shared-catalog object, so it survives
 * `DROP SCHEMA public CASCADE`: a database is claimed once and stays
 * claimed for every later reset.
 *
 * KEEP IN SYNC with DISPOSABLE_TEST_DATABASE_MARKER in
 * scripts/migrate.mjs (a plain script with no TypeScript build step, so it
 * cannot import this — the same keep-in-sync-by-inspection arrangement
 * isTestDatabaseName already has between migrate.mjs and
 * cleanup-test-databases.mjs).
 */
export const DISPOSABLE_TEST_DATABASE_MARKER = 'loombre:disposable-test-database';

/**
 * Marks `databaseName` as a disposable test database, so
 * `scripts/migrate.mjs reset` will wipe it without the `--allow-reset`
 * escape hatch. Best-effort: COMMENT ON DATABASE requires ownership, and
 * an operator-managed Postgres may own the database with a different role
 * — a failure is swallowed, exactly like migrate.mjs's own auto-provision
 * step, leaving the (louder, safer) "needs --allow-reset once" path.
 *
 * `client` must already be connected to ANY database on the same server;
 * database comments are cluster-wide.
 */
async function claimDisposableTestDatabase(client: pg.Client, databaseName: string): Promise<void> {
  try {
    await client.query(
      `COMMENT ON DATABASE "${databaseName.replace(/"/g, '""')}" IS '${DISPOSABLE_TEST_DATABASE_MARKER}'`
    );
  } catch {
    /* not the owner — reset will ask for --allow-reset once instead */
  }
}

/**
 * Ensures `<base database>_<suffix>` exists on the same Postgres server as
 * `baseConnectionString`, creating it if necessary, and returns its
 * connection string. Idempotent — safe to call from every test file's
 * `beforeAll` (only the first caller actually issues `CREATE DATABASE`).
 *
 * Also (re)stamps the disposable-database marker on every call, not only
 * on creation: this function IS the harness declaring "this database is
 * mine to destroy", and stamping unconditionally means the several hundred
 * per-suite databases that predate the marker are adopted the next time
 * their own suite runs, with no migration step for anyone.
 */
export async function ensureTestDatabase(
  baseConnectionString: string,
  suffix: string
): Promise<string> {
  const url = new URL(baseConnectionString);
  const baseDbName = url.pathname.replace(/^\//, '');
  if (!baseDbName) {
    throw new Error(`ensureTestDatabase: connection string has no database name: ${baseConnectionString}`);
  }
  const isolatedDbName = `${baseDbName}_${suffix}`;

  const isolatedUrl = new URL(baseConnectionString);
  isolatedUrl.pathname = `/${isolatedDbName}`;

  const admin = new pg.Client({ connectionString: baseConnectionString });
  await admin.connect();
  try {
    const existing = await admin.query<{ datname: string }>(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [isolatedDbName]
    );
    if (existing.rowCount === 0) {
      // CREATE DATABASE cannot be parameterized or run inside a
      // transaction; isolatedDbName is built from caller-controlled test
      // fixture strings only (never request input), quoted defensively.
      await admin.query(`CREATE DATABASE "${isolatedDbName.replace(/"/g, '""')}"`);
    }
    await claimDisposableTestDatabase(admin, isolatedDbName);
  } finally {
    await admin.end();
  }

  return isolatedUrl.toString();
}
