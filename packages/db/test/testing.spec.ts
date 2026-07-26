// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/testing.spec.ts

import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ensureTestDatabase } from '../src/testing.js';

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';
const SUFFIX = `ensure_test_db_spec_${Date.now()}`;

let createdDbName: string;

afterAll(async () => {
  if (!createdDbName) return;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${createdDbName}"`);
  } finally {
    await admin.end();
  }
});

describe('ensureTestDatabase', () => {
  it('creates the derived database and returns a connection string pointing at it', async () => {
    const url = await ensureTestDatabase(BASE_URL, SUFFIX);
    const parsed = new URL(url);
    createdDbName = parsed.pathname.replace(/^\//, '');
    expect(createdDbName).toBe(`${new URL(BASE_URL).pathname.replace(/^\//, '')}_${SUFFIX}`);

    // The returned connection string actually connects.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
  });

  it('is idempotent — calling it again for the same suffix does not error', async () => {
    const url = await ensureTestDatabase(BASE_URL, SUFFIX);
    expect(url).toContain(createdDbName);
  });
});
