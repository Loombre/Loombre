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
