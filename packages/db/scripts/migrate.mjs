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
//   status         list migrations and whether each is applied
//   migrate-check  (a) sha256-compare schema.sql against the concatenation
//                  of migrations/*.sql, (b) replay every migration into a
//                  disposable scratch schema in the SAME database to prove
//                  the chain actually applies cleanly, then drop the scratch
//                  schema. Fails loudly on either mismatch.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

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
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
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

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    switch (command) {
      case 'migrate':
        await cmdMigrate(client);
        break;
      case 'reset':
        await cmdReset(client);
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
