// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/live-db-guard.spec.ts
//
// Task #11 residual (a), an upstream media server-study implementation run Lane A1.
//
// The 2026-08-10 incident (a test suite's `migrate.mjs reset` DROP SCHEMA
// CASCADE'd the live dev database) was closed by a NAME guard: `reset`
// refuses unless the target database's name carries a "_test" segment. The
// residual that guard left is documented verbatim in
// packages/db/src/testing.ts's own header:
//
//   "if DATABASE_URL is ALREADY pointed at a database whose name ends in
//    `_test`, this function returns it verbatim — it never asks whether
//    that database is actually disposable ... naming a real database
//    `..._test` recreates the hole the naming convention was supposed to
//    close."
//
// A name is not evidence. This spec pins the two pieces of REAL evidence
// the guard must additionally demand before it is willing to drop a
// schema:
//
//   1. LIVE STACK — no Loombre application process may be attached to the
//      target database. The worker labels its (durable, continuously
//      polling) pg-boss connection `loombre-worker:<pid>:<startedAtMs>`
//      exactly so this question is answerable from pg_stat_activity;
//      src/query/worker-liveness.ts is built on the same fact.
//   2. PROVENANCE — the database must have been CLAIMED as disposable by
//      the test harness itself (a `loombre:disposable-test-database`
//      comment on the database, which survives DROP SCHEMA because it is a
//      database-level object). A populated database nothing ever claimed
//      is somebody's data, whatever its name says.
//
// `--allow-reset`/LOOMBRE_ALLOW_RESET=1 remains the deliberate operator
// escape hatch for both (that is what `pnpm db:reset` passes).
//
// Every case runs against its own throwaway database, created and dropped
// by this spec — never the shared `<base>_test`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveTestDatabaseUrl } from '../src/testing.js';
import { workerApplicationName } from '../src/query/worker-liveness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');
const MIGRATE_SCRIPT = path.join(PKG_ROOT, 'scripts', 'migrate.mjs');

const TIME_SCALE = Math.max(1, Number(process.env['LOOMBRE_TEST_TIME_SCALE'] ?? '1') || 1);

const BASE_URL = resolveTestDatabaseUrl();

function urlFor(dbName: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(BASE_URL);
  url.pathname = '/postgres';
  return url.toString();
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function recreateDatabase(dbName: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  });
}

async function dropDatabase(dbName: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin
      .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName])
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => undefined);
  });
}

interface CliOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runMigrate(dbName: string, args: string[]): CliOutcome {
  const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL: urlFor(dbName), LOOMBRE_ALLOW_RESET: '' },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** True when the database still carries the migrated schema (i.e. no reset
 *  actually happened, or one happened and completed). */
async function tableExists(dbName: string, table: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: urlFor(dbName) });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    return (rows[0]?.n ?? 0) > 0;
  } finally {
    await client.end();
  }
}

async function rowCount(dbName: string, table: string): Promise<number> {
  const client = new pg.Client({ connectionString: urlFor(dbName) });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

const LIVE_DB = 'loombre_a1_live_stack_guard_test';
const UNCLAIMED_DB = 'loombre_a1_unclaimed_guard_test';
const CLAIMED_DB = 'loombre_a1_claimed_guard_test';

describe('reset refuses a *_test-named database that is actually LIVE (task #11 residual a)', () => {
  afterAll(async () => {
    await dropDatabase(LIVE_DB);
    await dropDatabase(UNCLAIMED_DB);
    await dropDatabase(CLAIMED_DB);
  }, 60_000 * TIME_SCALE);

  describe('evidence 1: a Loombre worker process is attached', () => {
    let workerPool: pg.Pool;

    beforeAll(async () => {
      await recreateDatabase(LIVE_DB);
      // A migrated, harness-CLAIMED database — so the only thing standing
      // between this reset and a DROP SCHEMA is the live-stack evidence.
      expect(runMigrate(LIVE_DB, ['reset', '--allow-reset']).status).toBe(0);
      // Exactly how apps/worker labels its pg-boss pool
      // (packages/db/src/query/worker-liveness.ts).
      workerPool = new pg.Pool({
        connectionString: urlFor(LIVE_DB),
        application_name: workerApplicationName(4242, Date.now()),
      });
      await workerPool.query('SELECT 1');
    }, 120_000 * TIME_SCALE);

    afterAll(async () => {
      await workerPool.end().catch(() => undefined);
    });

    it('refuses, names the attached process, and leaves the schema intact', async () => {
      const outcome = runMigrate(LIVE_DB, ['reset']);
      expect(outcome.status, `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`).not.toBe(0);
      expect(`${outcome.stdout}${outcome.stderr}`).toMatch(/loombre-worker/);
      expect(await tableExists(LIVE_DB, 'users')).toBe(true);
    }, 60_000 * TIME_SCALE);

    it('--allow-reset is still the deliberate operator override', async () => {
      const outcome = runMigrate(LIVE_DB, ['reset', '--allow-reset']);
      expect(outcome.status, `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`).toBe(0);
      expect(await tableExists(LIVE_DB, 'users')).toBe(true);
    }, 120_000 * TIME_SCALE);
  });

  describe('evidence 2: the database was never claimed as disposable by the harness', () => {
    beforeAll(async () => {
      await recreateDatabase(UNCLAIMED_DB);
      // `migrate` (never `reset`) — exactly how a real stack's database
      // comes into existence. Nothing claims it as disposable.
      expect(runMigrate(UNCLAIMED_DB, ['migrate']).status).toBe(0);
      const client = new pg.Client({ connectionString: urlFor(UNCLAIMED_DB) });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
           VALUES ('real-operator', 'operator@example.invalid', 'x', $1, $1)`,
          [Date.now()],
        );
      } finally {
        await client.end();
      }
    }, 120_000 * TIME_SCALE);

    it('refuses to drop a populated, unclaimed database and keeps its data', async () => {
      const outcome = runMigrate(UNCLAIMED_DB, ['reset']);
      expect(outcome.status, `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`).not.toBe(0);
      expect(await rowCount(UNCLAIMED_DB, 'users')).toBe(1);
    }, 60_000 * TIME_SCALE);

    it('--allow-reset overrides it AND claims the database, so later resets need no flag', async () => {
      expect(runMigrate(UNCLAIMED_DB, ['reset', '--allow-reset']).status).toBe(0);
      expect(await rowCount(UNCLAIMED_DB, 'users')).toBe(0);

      const outcome = runMigrate(UNCLAIMED_DB, ['reset']);
      expect(outcome.status, `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`).toBe(0);
    }, 180_000 * TIME_SCALE);
  });

  describe('regression: an ordinary harness-provisioned database still resets freely', () => {
    it('auto-provisioned + empty databases are claimed on sight and reset with no flag', async () => {
      await dropDatabase(CLAIMED_DB);
      // No CREATE DATABASE here on purpose: `reset`'s own auto-provision
      // path creates it, which is how every per-suite test database is
      // born. It must be claimed at that moment, and every subsequent
      // unflagged reset must keep working.
      const first = runMigrate(CLAIMED_DB, ['reset']);
      expect(first.status, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0);
      const second = runMigrate(CLAIMED_DB, ['reset']);
      expect(second.status, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0);
      expect(await tableExists(CLAIMED_DB, 'playback_sessions')).toBe(true);
    }, 180_000 * TIME_SCALE);
  });
});
