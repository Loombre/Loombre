// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/concurrent-reset.spec.ts
//
// Task #11 residual (b), an upstream media server-study implementation run Lane A1:
// scripts/migrate.mjs's own header documents this hole verbatim —
//
//   "RESIDUAL RACE (not fixed by this guard): ... two concurrent `reset`
//    (DROP SCHEMA public CASCADE + replay) calls against the SAME
//    `loombre_test` database can race each other (lost schema, a replay
//    observing a half-dropped schema, or a Postgres deadlock)"
//
// apps/worker and packages/jobs both derive their live-DB suites from the
// same shared `resolveTestDatabaseUrl()` default, and turbo runs their
// `test` tasks in parallel, so this is a real, reachable failure — and
// with several worktree lanes on one Postgres instance it is reachable
// several times over.
//
// This spec REPRODUCES the failure mode directly: two `migrate.mjs reset`
// processes against ONE database, the second deliberately staggered a few
// hundred milliseconds so it lands squarely in the middle of the first
// one's migration replay (the interleaving that actually hurts — the
// second process's DROP SCHEMA CASCADE deletes the tables the first is
// still building on top of).
//
// Runs against its OWN isolated database (ensureTestDatabase), never the
// shared `<base>_test` — this spec is about the reset mechanism itself and
// must not yank the schema out from under a sibling suite (or a parallel
// worktree lane) while proving that exact hazard exists.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureTestDatabase, resolveTestDatabaseUrl } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');
const MIGRATE_SCRIPT = path.join(PKG_ROOT, 'scripts', 'migrate.mjs');
const MIGRATIONS_DIR = path.join(PKG_ROOT, 'migrations');

const TIME_SCALE = Math.max(1, Number(process.env['LOOMBRE_TEST_TIME_SCALE'] ?? '1') || 1);

interface ResetOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runReset(databaseUrl: string, delayMs: number): Promise<ResetOutcome> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const child = spawn(process.execPath, [MIGRATE_SCRIPT, 'reset'], {
        cwd: PKG_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => {
        stdout += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    }, delayMs);
  });
}

function migrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('.'))
    .sort();
}

describe('concurrent `migrate.mjs reset` against one database (task #11 residual b)', () => {
  let databaseUrl: string;

  beforeAll(async () => {
    databaseUrl = await ensureTestDatabase(resolveTestDatabaseUrl(), 'concurrent_reset_test');
    // A populated starting point: the interleaving that breaks is the
    // second process dropping a schema the first is mid-way through
    // building, which needs a real schema to exist first.
    const seed = await runReset(databaseUrl, 0);
    expect(seed.status).toBe(0);
  }, 120_000 * TIME_SCALE);

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect().catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  async function assertSchemaComplete(): Promise<void> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const applied = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
      expect(applied.rows.map((r) => r.filename)).toEqual(migrationFilenames());

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const names = new Set(tables.rows.map((r) => r.table_name));
      for (const required of ['users', 'catalog_items', 'media_files', 'playback_sessions', 'jobs', 'events']) {
        expect(names.has(required), `table ${required} must exist after both resets`).toBe(true);
      }
    } finally {
      await client.end();
    }
  }

  // Two interleavings, both real: simultaneous start (the two replays
  // collide statement-for-statement) and a staggered start (the second
  // process's DROP SCHEMA CASCADE lands mid-way through the first one's
  // replay). Both must be survivable.
  for (const staggerMs of [0, 60]) {
    it(`two resets ${staggerMs}ms apart both succeed and leave a COMPLETE schema behind`, async () => {
      const [first, second] = await Promise.all([runReset(databaseUrl, 0), runReset(databaseUrl, staggerMs)]);

      // (1) Neither process may fail. Pre-fix this is where it breaks: the
      // loser's replay hits "relation ... already exists"/"does not exist"
      // (its tables were created or dropped underneath it) or deadlocks.
      expect(
        { status: first.status, tail: first.stderr.slice(-800) },
        'first reset must succeed',
      ).toEqual({ status: 0, tail: '' });
      expect(
        { status: second.status, tail: second.stderr.slice(-800) },
        'second reset must succeed',
      ).toEqual({ status: 0, tail: '' });

      // (2) The surviving schema must be COMPLETE — a reset that "succeeds"
      // while another process concurrently dropped half its output is not a
      // reset. Every migration recorded, and the tables really there.
      await assertSchemaComplete();
    }, 180_000 * TIME_SCALE);
  }
});
