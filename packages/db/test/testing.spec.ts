// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/testing.spec.ts

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ensureTestDatabase, resolveTestDatabaseUrl } from '../src/testing.js';

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

describe('resolveTestDatabaseUrl', () => {
  const ORIGINAL_DATABASE_URL = process.env['DATABASE_URL'];
  const ORIGINAL_TEST_DATABASE_URL = process.env['LOOMBRE_TEST_DATABASE_URL'];

  beforeEach(() => {
    delete process.env['DATABASE_URL'];
    delete process.env['LOOMBRE_TEST_DATABASE_URL'];
  });

  afterEach(() => {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = ORIGINAL_DATABASE_URL;
    if (ORIGINAL_TEST_DATABASE_URL === undefined) delete process.env['LOOMBRE_TEST_DATABASE_URL'];
    else process.env['LOOMBRE_TEST_DATABASE_URL'] = ORIGINAL_TEST_DATABASE_URL;
  });

  it('returns the hardcoded default with a "_test" suffix when nothing is set', () => {
    expect(resolveTestDatabaseUrl()).toBe('postgres://loombre:loombre@localhost:5442/loombre_test');
  });

  it('rewrites DATABASE_URL\'s database name to "<name>_test"', () => {
    process.env['DATABASE_URL'] = 'postgres://loombre:loombre@localhost:5442/loombre';
    expect(resolveTestDatabaseUrl()).toBe('postgres://loombre:loombre@localhost:5442/loombre_test');
  });

  it('preserves host, port, credentials, and query params while rewriting only the database name', () => {
    process.env['DATABASE_URL'] = 'postgres://someuser:somepass@db.example.internal:6543/mydb?sslmode=require';
    const resolved = resolveTestDatabaseUrl();
    const parsed = new URL(resolved);
    expect(parsed.hostname).toBe('db.example.internal');
    expect(parsed.port).toBe('6543');
    expect(parsed.username).toBe('someuser');
    expect(parsed.password).toBe('somepass');
    expect(parsed.pathname).toBe('/mydb_test');
    expect(parsed.searchParams.get('sslmode')).toBe('require');
  });

  it('does not double-suffix a DATABASE_URL that already ends in "_test"', () => {
    process.env['DATABASE_URL'] = 'postgres://loombre:loombre@localhost:5442/loombre_test';
    expect(resolveTestDatabaseUrl()).toBe('postgres://loombre:loombre@localhost:5442/loombre_test');
  });

  it('LOOMBRE_TEST_DATABASE_URL overrides everything, including a set DATABASE_URL', () => {
    process.env['DATABASE_URL'] = 'postgres://loombre:loombre@localhost:5442/loombre';
    process.env['LOOMBRE_TEST_DATABASE_URL'] = 'postgres://someone:elsewhere@otherhost:9999/explicit_test_db';
    expect(resolveTestDatabaseUrl()).toBe('postgres://someone:elsewhere@otherhost:9999/explicit_test_db');
  });
});
