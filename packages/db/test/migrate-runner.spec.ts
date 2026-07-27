// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/migrate-runner.spec.ts
//
// runPendingMigrations is the RUNTIME half of the migration story: an
// installed embedded-mode server (macOS/Windows/Linux installer channels)
// has no repo checkout and no pnpm — apps/server's bootstrap calls this
// after provisioning the embedded cluster, so a first boot yields a fully
// migrated schema instead of the schema-less database the installer audit
// found. The dev CLI (scripts/migrate.mjs) stays the operator/dev path —
// the two share the same migrations/ files and bookkeeping table contract.

import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ensureTestDatabase } from '../src/testing.js';
import { runPendingMigrations } from '../src/migrate.js';

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';
const SUFFIX = `migrate_runner_spec_${Date.now()}`;

let scratchUrl: string;
let scratchDbName: string;

afterAll(async () => {
  if (!scratchDbName) return;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${scratchDbName}"`);
  } finally {
    await admin.end();
  }
});

describe('runPendingMigrations', () => {
  it('applies the full chain to an empty database and reports each file', async () => {
    scratchUrl = await ensureTestDatabase(BASE_URL, SUFFIX);
    scratchDbName = new URL(scratchUrl).pathname.replace(/^\//, '');

    const applied: string[] = [];
    const result = await runPendingMigrations(scratchUrl, { log: (m) => applied.push(m) });

    expect(result.appliedCount).toBeGreaterThan(0);
    expect(result.totalCount).toBe(result.appliedCount);

    const client = new pg.Client({ connectionString: scratchUrl });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
      expect(rows.length).toBe(result.totalCount);
      // A real product table from 0001_init proves the SQL actually ran.
      const users = await client.query("SELECT to_regclass('public.users') AS reg");
      expect(users.rows[0].reg).toBe('users');
    } finally {
      await client.end();
    }
  });

  it('is idempotent — a second run applies nothing', async () => {
    const result = await runPendingMigrations(scratchUrl, { log: () => {} });
    expect(result.appliedCount).toBe(0);
    expect(result.totalCount).toBeGreaterThan(0);
  });
});
