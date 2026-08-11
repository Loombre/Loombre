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
 * Residual footgun (case 2, the "does not double-suffix" branch): if
 * `DATABASE_URL` is ALREADY pointed at a database whose name ends in
 * `_test`, this function returns it verbatim — it never asks whether that
 * database is actually disposable, only whether its name looks like a
 * test database. The guarantee this function (and the migrate.mjs reset
 * guard it's designed to satisfy) actually provides is "the name says
 * test", not "this database's contents don't matter". A dev stack whose
 * `DATABASE_URL` was pointed at `.../loombre_test` for some other reason
 * (e.g. manually, or by a stale env file) would sail straight through the
 * guard and get DROP SCHEMA'd by a test run — this is the exact shape of
 * the 2026-08-10 incident this function exists to prevent, just one layer
 * further out: naming a real database `..._test` recreates the hole the
 * naming convention was supposed to close.
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
 * Ensures `<base database>_<suffix>` exists on the same Postgres server as
 * `baseConnectionString`, creating it if necessary, and returns its
 * connection string. Idempotent — safe to call from every test file's
 * `beforeAll` (only the first caller actually issues `CREATE DATABASE`).
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
  } finally {
    await admin.end();
  }

  return isolatedUrl.toString();
}
