// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/pool-error.spec.ts
//
// An idle pooled client whose backend goes away emits 'error' on the
// pg.Pool. Without a listener that is an unhandled EventEmitter error —
// an uncaughtException that the worker's crash handler files as a crash
// and exits on. Live finding (native Linux install, the tray's "Stop
// server"): the server hosts the embedded PostgreSQL, so stopping it
// terminated every worker connection ("terminating connection due to
// administrator command", 57P01) and the worker crashed, restarted, and
// sat waiting — one crash report per server stop. createDb() now owns a
// pool-level error handler; this proves it by terminating our own backend
// from a second connection and querying again through the same handle.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

describe('createDb pool resilience', () => {
  let db: Kysely<DB>;
  let admin: pg.Client;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end();
    await db.destroy();
  });

  it('survives its idle backend being terminated (57P01) and serves the next query on a fresh client', async () => {
    const before = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
    const pid = before.rows[0]!.pid;

    const uncaught: unknown[] = [];
    const listener = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on('uncaughtException', listener);
    try {
      await admin.query('select pg_terminate_backend($1)', [pid]);
      // Give the pool's idle client time to observe the FATAL and emit.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(uncaught).toEqual([]);

      const after = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
      expect(after.rows[0]!.pid).not.toBe(pid);
    } finally {
      process.off('uncaughtException', listener);
    }
  });
});
