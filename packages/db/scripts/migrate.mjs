#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/scripts/migrate.mjs
//
// Tiny, dependency-light (node-pg only) migration runner. Plain SQL files in
// migrations/*.sql, applied in filename order, tracked in a
// `schema_migrations` table. No ORM, no magic — see docs/PLAN.md §4.2 and
// packages/db/migrations/0001_init.sql's header for the full rationale.
//
// Commands:
//   migrate        apply every migration not yet recorded as applied
//   reset          drop and recreate the public schema, then migrate
//                  (GUARDED — see below)
//   status         list migrations and whether each is applied
//   migrate-check  (a) sha256-compare schema.sql against the concatenation
//                  of migrations/*.sql, (b) replay every migration into a
//                  disposable scratch schema in the SAME database to prove
//                  the chain actually applies cleanly, then drop the scratch
//                  schema. Fails loudly on either mismatch.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre
//
// RESET GUARD (2026-08-10 incident: packages/jobs/test/queue.spec.ts's
// beforeAll spawned `reset` — DROP SCHEMA public CASCADE — straight
// against DATABASE_URL's bare default, which was the live dev database,
// because nothing but convention distinguished "a test run" from "an
// operator's real database"). `reset` now REFUSES to run unless the
// TARGET database's name contains "_test" as an underscore-delimited
// segment (matches both the `<name>_test` convention
// packages/db/src/testing.ts's resolveTestDatabaseUrl() produces AND the
// pre-existing `ensureTestDatabase`-derived per-suite names already in
// use across the test suites, e.g. "loombre_server_test",
// "loombre_test_export_spec") — or LOOMBRE_ALLOW_RESET=1 is set (the
// operator/CI escape hatch; `pnpm db:reset` sets it inline). `migrate`,
// `status`, `migrate-check`, and `generate-schema` are all read-only or
// additive and stay unguarded.
//
// AUTO-PROVISION: when `reset` targets a database that doesn't exist yet
// (first run against a freshly-derived `<name>_test`), it is CREATEd via
// a maintenance connection to the same server's `postgres` database
// before the real connection is opened — every consumer (test suite,
// operator) gets this for free without provisioning its own database
// first. Concurrent creation (two suites racing the same missing
// database) is resolved by catching duplicate_database (42P04) and
// continuing. This step is best-effort (see ensureDatabaseExists's own
// header below) — an operator-managed external Postgres is not required
// to grant CONNECT on `postgres` or CREATEDB (docs/ops/external-postgres.md
// never promises either), so a failure here is logged and swallowed
// rather than raised.
//
// SERIALIZATION (task #11 residual (b), CLOSED 2026-08-11 — this block
// used to read "RESIDUAL RACE (not fixed by this guard)"): the name guard
// only decides WHETHER a reset may proceed against a given database; it
// says nothing about two processes resetting the SAME database at once.
// apps/worker and packages/jobs both derive their live-DB suites from the
// same shared `resolveTestDatabaseUrl()` default (`<base>_test`, e.g.
// "loombre_test") rather than each having its own `ensureTestDatabase`-
// isolated database, turbo runs their `test` tasks in parallel, and
// several worktree lanes can share one Postgres instance — so two
// concurrent DROP SCHEMA public CASCADE + replay calls against ONE
// database really do collide. Reproduced as a red check first
// (test/concurrent-reset.spec.ts): simultaneous starts fail with
// `schema "public" already exists`, and a start ~60ms in fails with
// `relation "media_files" does not exist` mid-replay.
//
// Fixed by SERIALIZING rather than namespacing: `reset` and `migrate` both
// hold a session-level Postgres ADVISORY LOCK (withMigrationLock below)
// for the whole drop+replay. Advisory locks live in a per-database lock
// space, so one fixed key serializes exactly the processes that would
// collide (same database) and never contends across different databases —
// which namespacing per package would not have covered anyway (two
// worktree lanes' `loombre_test` are the same database). `lock_timeout`
// bounds the wait so a wedged holder surfaces as a clear error instead of
// hanging a test run forever.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(PKG_ROOT, 'migrations');
const SCHEMA_SQL_PATH = path.join(PKG_ROOT, 'schema.sql');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

const SCHEMA_BANNER = `-- GENERATED FILE — do not hand-edit.
-- Produced by concatenating migrations/*.sql (filename order) with this
-- banner prepended. Source of truth is migrations/; regenerate with:
--   node scripts/migrate.mjs generate-schema
-- Verified in sync by: node scripts/migrate.mjs migrate-check
`;

function listMigrationFiles() {
  // Dotfiles excluded (KEEP IN SYNC with src/migrate.ts's
  // isMigrationFile): macOS tar writes AppleDouble "._*.sql" entries
  // into archives — never migrations.
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('.'))
    .sort();
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function buildExpectedSchemaSql() {
  const files = listMigrationFiles();
  const bodies = files.map((f) =>
    readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
  );
  return SCHEMA_BANNER + '\n' + bodies.join('\n');
}

function nowMs() {
  return Date.now();
}

async function ensureBookkeepingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename      TEXT PRIMARY KEY,
      checksum      TEXT NOT NULL,
      applied_at_ms BIGINT NOT NULL
    );
  `);
}

async function getAppliedFilenames(client) {
  const { rows } = await client.query(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  return new Set(rows.map((r) => r.filename));
}

async function applyMigrationFile(client, filename) {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await ensureBookkeepingTable(client);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, applied_at_ms)
       VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO NOTHING`,
      [filename, sha256(sql), nowMs()]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`migration ${filename} failed: ${err.message}`, { cause: err });
  }
}

async function cmdMigrate(client) {
  await ensureBookkeepingTable(client);
  const applied = await getAppliedFilenames(client);
  const files = listMigrationFiles();
  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) {
      console.log(`skip  ${filename} (already applied)`);
      continue;
    }
    console.log(`apply ${filename}`);
    await applyMigrationFile(client, filename);
    count += 1;
  }
  console.log(`migrate: ${count} migration(s) applied, ${files.length} total.`);
}

// Matches "loombre_test", "loombre_test_export_spec", "server_test_x",
// bare "test" — anything with "_test" as an underscore-delimited segment.
// Deliberately NOT a strict "ends with _test" check: several already-
// isolated per-suite database names (ensureTestDatabase-derived, e.g.
// "loombre_server_test_review_findings") carry a suffix AFTER "_test",
// not just before it.
function isTestDatabaseName(name) {
  return /(^|_)test(_|$)/.test(name);
}

function assertResetAllowed(databaseUrl) {
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  // Two equivalent escape hatches: the env var (documented, works from any
  // caller including a spawned child process) and a `--allow-reset` CLI
  // flag (what `pnpm db:reset` actually uses — package.json scripts run
  // through cmd.exe on the Windows dev/installer channel, which does not
  // understand `VAR=1 command` shell syntax, and this repo has no
  // cross-env dependency to paper over that; a plain argv flag needs
  // neither).
  const allowed =
    isTestDatabaseName(dbName) ||
    process.env.LOOMBRE_ALLOW_RESET === '1' ||
    process.argv.includes('--allow-reset');
  if (allowed) return;
  throw new Error(
    `reset: refusing to drop schema "public" on database "${dbName}" — its name ` +
    `does not contain "_test", so this does not look like a disposable test ` +
    `database.\n` +
    `Escape hatches:\n` +
    `  - point DATABASE_URL at a database whose name contains "_test" (test ` +
    `suites derive this automatically via resolveTestDatabaseUrl, which honors ` +
    `LOOMBRE_TEST_DATABASE_URL), e.g. "${dbName}_test"\n` +
    `  - pass --allow-reset / set LOOMBRE_ALLOW_RESET=1 for a deliberate reset ` +
    `(operator/CI use only — \`pnpm db:reset\` already does this for you)`
  );
}

// `reset` against a database that doesn't exist yet (first run against a
// freshly-derived <name>_test) would otherwise fail at client.connect()
// before cmdReset ever runs. Connects to the same server's `postgres`
// maintenance database (present on every Postgres install this repo
// targets — docker-compose.dev.yml's image, CI's action-setup-postgres on
// all 3 OSes) to check for and, if missing, create the target database.
//
// BEST-EFFORT, not required: docs/ops/external-postgres.md's documented
// setup only grants the loombre role "ordinary DDL+DML privileges on
// [its] database" — it never promises CONNECT on the `postgres` database
// or CREATEDB, and an operator-managed Postgres is free to withhold both.
// Against that setup this whole auto-provision step would previously fail
// outright (throwing before `reset`'s real connection ever opens),
// breaking `pnpm db:reset --allow-reset` for exactly the external-Postgres
// path docs/ops/external-postgres.md documents as first-class (D1). Any
// failure here — connect refused, permission denied, `postgres` database
// not reachable, anything — is therefore caught and logged as a note, not
// raised: if the target database genuinely doesn't exist, the real
// connection opened right after this returns fails with Postgres's own
// (accurate) error, which is a better failure than this function's guess.
async function ensureDatabaseExists(databaseUrl) {
  const target = new URL(databaseUrl);
  const dbName = target.pathname.replace(/^\//, '');
  if (!dbName) return;

  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: maintenanceUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    console.log(
      `reset: could not auto-provision database "${dbName}" (failed to connect to the ` +
      `maintenance database "postgres" on the same server): ${err.message}; proceeding — ` +
      `if the database does not exist the next step will fail with the real error.`
    );
    return;
  }
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount > 0) return;
    try {
      // CREATE DATABASE cannot be parameterized or run inside a
      // transaction; dbName is either the _test-suffix convention or
      // already passed the assertResetAllowed guard above, never
      // unvalidated request input.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`reset: created database "${dbName}" (did not exist).`);
    } catch (err) {
      // 42P04 = duplicate_database: a sibling test suite created it
      // concurrently between our existence check and our CREATE — the
      // exact race two independent packages' beforeAll hooks can hit
      // under turbo's parallel package execution. Not our problem to
      // fail on; the database exists either way.
      if (err && err.code === '42P04') {
        console.log(`reset: database "${dbName}" was created concurrently by another process — continuing.`);
      } else {
        console.log(
          `reset: could not auto-provision database "${dbName}" (CREATE DATABASE failed): ` +
          `${err.message}; proceeding — if the database does not exist the next step will ` +
          `fail with the real error.`
        );
      }
    }
  } catch (err) {
    console.log(
      `reset: could not auto-provision database "${dbName}" (checking pg_database failed): ` +
      `${err.message}; proceeding — if the database does not exist the next step will fail ` +
      `with the real error.`
    );
  } finally {
    await admin.end();
  }
}

// One fixed advisory-lock key for "this database's schema is being
// rewritten". Advisory locks are scoped to the DATABASE the session is
// connected to, so a constant is exactly right: two processes resetting
// `loombre_test` serialize, while a reset of `loombre_worker_test` never
// waits on them. Value: an arbitrary, stable 64-bit constant — chosen
// literally rather than hashed at runtime so it is greppable and can never
// drift between callers.
const MIGRATION_LOCK_KEY = '7261551246031918001';

// How long to wait for a sibling process's drop+replay before giving up.
// A full replay is well under a second locally and a few seconds on the
// slowest CI runner; a two-minute ceiling therefore only ever fires for a
// genuinely wedged holder, where hanging forever would be the worse
// outcome.
const MIGRATION_LOCK_TIMEOUT_MS = 120_000;

/**
 * Runs `fn` while holding this database's migration advisory lock.
 *
 * Session-level (`pg_advisory_lock`, not `_xact_`) because the work it
 * guards is deliberately NOT one transaction: cmdReset issues DROP/CREATE
 * SCHEMA and then commits each migration file separately, and the whole
 * sequence — not any single statement — is what must not interleave.
 * `lock_timeout` applies to advisory-lock waits, so a wedged holder
 * surfaces as a clear error rather than an unbounded hang. The lock is
 * released explicitly and would be released by the backend on disconnect
 * anyway, so a crashed holder never wedges the next run.
 */
async function withMigrationLock(client, label, fn) {
  await client.query(`SET lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
  try {
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  } catch (err) {
    if (err && err.code === '55P03') {
      throw new Error(
        `${label}: timed out after ${MIGRATION_LOCK_TIMEOUT_MS}ms waiting for another process to finish ` +
        `migrating this database. Another test suite or operator command is holding the migration lock; ` +
        `re-run once it finishes.`,
        { cause: err }
      );
    }
    throw err;
  } finally {
    await client.query('RESET lock_timeout');
  }
  try {
    return await fn();
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).catch(() => undefined);
  }
}

async function cmdReset(client) {
  console.log('reset: dropping and recreating schema "public"...');
  // IF EXISTS: a reset aborted between DROP and CREATE (task kill, turbo
  // sibling-failure teardown) must not brick the database for every later
  // reset — observed live 2026-07-24 (schema "public" does not exist).
  await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
  await client.query('CREATE SCHEMA public;');
  await client.query('GRANT ALL ON SCHEMA public TO PUBLIC;');
  console.log('reset: schema recreated, running migrate...');
  await cmdMigrate(client);
}

async function cmdStatus(client) {
  await ensureBookkeepingTable(client);
  const applied = await getAppliedFilenames(client);
  const files = listMigrationFiles();
  for (const filename of files) {
    console.log(`${applied.has(filename) ? '[applied]' : '[pending]'} ${filename}`);
  }
}

function cmdGenerateSchema() {
  const content = buildExpectedSchemaSql();
  writeFileSync(SCHEMA_SQL_PATH, content, 'utf8');
  console.log(`generate-schema: wrote ${SCHEMA_SQL_PATH} (${content.length} bytes).`);
}

async function cmdMigrateCheck(client) {
  // Part A: schema.sql must be byte-identical to the generated concatenation
  // of migrations/*.sql.
  const expected = buildExpectedSchemaSql();
  if (!existsSync(SCHEMA_SQL_PATH)) {
    throw new Error(`migrate-check: ${SCHEMA_SQL_PATH} does not exist. Run generate-schema first.`);
  }
  const actual = readFileSync(SCHEMA_SQL_PATH, 'utf8');
  const expectedHash = sha256(expected);
  const actualHash = sha256(actual);
  if (expectedHash !== actualHash) {
    throw new Error(
      `migrate-check: schema.sql is out of sync with migrations/*.sql\n` +
      `  expected sha256 ${expectedHash}\n` +
      `  actual   sha256 ${actualHash}\n` +
      `Run: node scripts/migrate.mjs generate-schema`
    );
  }
  console.log(`migrate-check: schema.sql matches migrations/*.sql (sha256 ${actualHash}).`);

  // Part B: replay every migration into a disposable scratch schema in the
  // same database, proving the chain actually applies cleanly end to end.
  const scratchSchema = `loombre_migrate_check_${nowMs()}`;
  console.log(`migrate-check: replaying migrations into scratch schema "${scratchSchema}"...`);
  await client.query(`CREATE SCHEMA "${scratchSchema}";`);
  try {
    // "public" stays on the path (after the scratch schema) so that
    // extension-provided types (e.g. citext, already installed database-wide
    // in public by a prior real `migrate` run) resolve even though
    // CREATE EXTENSION IF NOT EXISTS is a no-op here. New objects still land
    // in the scratch schema because it is first on the path.
    await client.query(`SET search_path TO "${scratchSchema}", public;`);
    const files = listMigrationFiles();
    for (const filename of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migrate-check: replay of ${filename} failed: ${err.message}`, { cause: err });
      }
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
      [scratchSchema]
    );
    console.log(`migrate-check: replay succeeded, ${rows[0].n} table(s) created in scratch schema.`);
  } finally {
    await client.query('RESET search_path;');
    await client.query(`DROP SCHEMA "${scratchSchema}" CASCADE;`);
  }
  console.log('migrate-check: PASS');
}

async function main() {
  const command = process.argv[2];
  if (command === 'generate-schema') {
    cmdGenerateSchema();
    return;
  }

  if (command === 'reset') {
    assertResetAllowed(DATABASE_URL);
    await ensureDatabaseExists(DATABASE_URL);
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    switch (command) {
      // Both schema-WRITING commands run under the migration advisory lock
      // (see withMigrationLock): concurrent replays against one database
      // collide statement-for-statement, and a reset landing mid-way
      // through someone else's replay drops the tables underneath it.
      case 'migrate':
        await withMigrationLock(client, 'migrate', () => cmdMigrate(client));
        break;
      case 'reset':
        await withMigrationLock(client, 'reset', () => cmdReset(client));
        break;
      case 'status':
        await cmdStatus(client);
        break;
      case 'migrate-check':
        await cmdMigrateCheck(client);
        break;
      default:
        console.error(
          `usage: node scripts/migrate.mjs <migrate|reset|status|migrate-check|generate-schema>`
        );
        process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
