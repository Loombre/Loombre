// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/migrate-reset-guard.spec.ts
//
// Feedback-loop-first coverage for scripts/migrate.mjs's `reset` guard,
// added after the 2026-08-10 incident: packages/jobs/test/queue.spec.ts's
// beforeAll spawned `migrate.mjs reset` (DROP SCHEMA public CASCADE)
// straight against DATABASE_URL's bare default, which was the live dev
// database — nothing but convention distinguished "a test run" from "an
// operator's real database". `reset` now refuses to run unless the target
// database's name contains "_test" as an underscore-delimited segment, or
// LOOMBRE_ALLOW_RESET=1 / --allow-reset is explicitly passed. See
// migrate.mjs's own header for the full design.
//
// Exercises the REAL script as a child process (same `spawnSync` convention
// every other packages/db/test/*.spec.ts file already uses), against real
// disposable databases on the same Postgres server as DATABASE_URL — NEVER
// the live default itself, which is exactly the property under test. Every
// database this file creates is dropped in afterAll.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureTestDatabase } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const MIGRATE_SCRIPT = path.join(PKG_ROOT, 'scripts', 'migrate.mjs');

const BASE_DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://loombre:loombre@localhost:5442/loombre';
const BASE_DB_NAME = new URL(BASE_DATABASE_URL).pathname.replace(/^\//, '');

/** Spawns the real migrate.mjs. LOOMBRE_ALLOW_RESET is stripped from the
 * inherited environment by default so this file's own ambient env (or a
 * CI runner's) can never accidentally grant the escape hatch a test is
 * trying to prove is ABSENT. */
function runMigrate(args: string[], databaseUrl: string, extraEnv: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl };
  delete env['LOOMBRE_ALLOW_RESET'];
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, ...args], {
    cwd: PKG_ROOT,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const createdDbNames: string[] = [];

function urlFor(dbName: string): string {
  const url = new URL(BASE_DATABASE_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

afterAll(async () => {
  if (createdDbNames.length === 0) return;
  const admin = new pg.Client({ connectionString: BASE_DATABASE_URL });
  await admin.connect();
  try {
    for (const name of createdDbNames) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    }
  } finally {
    await admin.end();
  }
});

describe('scripts/migrate.mjs reset guard', () => {
  it('refuses to reset a database whose name does not contain "_test", and never connects to it', () => {
    const dbName = `${BASE_DB_NAME}_migrate_guard_no_suffix_probe_${Date.now()}`;
    // Deliberately NOT created — the guard must reject before ever trying
    // to connect, so a nonexistent target proves this as strongly as a
    // real one would.
    const result = runMigrate(['reset'], urlFor(dbName));
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('refusing to drop schema "public"');
    expect(output).toContain(dbName);
    expect(output).toContain('LOOMBRE_ALLOW_RESET');
    expect(output).toContain('--allow-reset');
  });

  it('refuses the live default database name outright ("loombre" itself)', () => {
    // The exact shape of the 2026-08-10 incident: DATABASE_URL unset,
    // migrate.mjs's own hardcoded default resolves to the live dev db name.
    const result = runMigrate(['reset'], 'postgres://loombre:loombre@localhost:5442/loombre');
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('refusing to drop schema "public" on database "loombre"');
  });

  it('proceeds against a non-"_test" name when LOOMBRE_ALLOW_RESET=1 is set', async () => {
    const suffix = `guard_allow_env_${Date.now()}`;
    const dbName = `${BASE_DB_NAME}_${suffix}`;
    createdDbNames.push(dbName);
    // Pre-create via the normal helper so this test isolates "does the env
    // escape hatch work" from "does auto-provision work" (covered below).
    await ensureTestDatabase(BASE_DATABASE_URL, suffix);
    const result = runMigrate(['reset'], urlFor(dbName), { LOOMBRE_ALLOW_RESET: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('migrate:');
  });

  it('proceeds against a non-"_test" name when --allow-reset is passed', async () => {
    const suffix = `guard_allow_flag_${Date.now()}`;
    const dbName = `${BASE_DB_NAME}_${suffix}`;
    createdDbNames.push(dbName);
    await ensureTestDatabase(BASE_DATABASE_URL, suffix);
    const result = runMigrate(['reset', '--allow-reset'], urlFor(dbName));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('migrate:');
  });

  it('auto-creates a missing "_test"-suffixed database instead of failing at connect', () => {
    const dbName = `${BASE_DB_NAME}_migrate_guard_autoprovision_${Date.now()}_test`;
    createdDbNames.push(dbName);
    const result = runMigrate(['reset'], urlFor(dbName));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`created database "${dbName}"`);
    expect(result.stdout).toContain('migrate:');
  });

  it('accepts a database name that merely contains "_test" as a segment, not just as a trailing suffix', () => {
    // Matches the pre-existing ensureTestDatabase-derived convention, e.g.
    // "loombre_test_export_spec" — "_test" is not the LAST segment there.
    const dbName = `${BASE_DB_NAME}_test_migrate_guard_segment_${Date.now()}`;
    createdDbNames.push(dbName);
    const result = runMigrate(['reset'], urlFor(dbName));
    expect(result.status).toBe(0);
  });

  it('a second reset against an already-provisioned "_test" database succeeds without re-creating it', () => {
    const dbName = `${BASE_DB_NAME}_migrate_guard_idempotent_${Date.now()}_test`;
    createdDbNames.push(dbName);
    const first = runMigrate(['reset'], urlFor(dbName));
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('created database');

    const second = runMigrate(['reset'], urlFor(dbName));
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain('created database');
    expect(second.stdout).toContain('migrate:');
  });

  it('best-effort auto-provision: an unreachable maintenance ("postgres") database does not crash reset outright — it logs a note and lets the real connection attempt fail with its own error (external-Postgres regression: docs/ops/external-postgres.md never promises CONNECT on "postgres" or CREATEDB)', () => {
    const dbName = `${BASE_DB_NAME}_migrate_guard_unreachable_maint_${Date.now()}_test`;
    // Port 1 on the same host: almost never has a listener, so both the
    // maintenance-DB connect attempt AND the real target connect attempt
    // that follows it refuse immediately (no long OS-level timeout to wait
    // out) rather than hanging.
    const bogusUrl = new URL(urlFor(dbName));
    bogusUrl.port = '1';
    const result = runMigrate(['reset'], bogusUrl.toString());
    // The overall command still fails — this does NOT prove reset can
    // succeed against an unreachable server, only that auto-provisioning
    // degrades gracefully (logs, returns) instead of being the thing that
    // throws before the real, informative connection error gets a chance
    // to surface.
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('could not auto-provision');
    expect(output).toContain(dbName);
  });
});
