// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/worker-liveness.spec.ts
//
// Runs against a REAL PostgreSQL, because the whole point of
// src/query/worker-liveness.ts is that it reads PostgreSQL's own session
// catalog — pg_stat_activity, extract(epoch from ...), current_database().
// None of that can be exercised by a mock, and a typo in it would fail
// exactly where it matters least visibly: the IPC status handler catches
// the rejection and quietly falls back to the old ledger heuristic, so a
// broken query would present as "the bug we just fixed came back".
//
// Connection: an ISOLATED per-suite database (ensureTestDatabase), NOT the
// live default — this spec is non-destructive, but it scopes its
// pg_stat_activity reads to current_database(), so pointing it at the dev
// database made a RUNNING dev worker's labeled connection fail the
// "no worker connected" case. The suite needs no schema at all (it reads
// only PostgreSQL's session catalog), just a database of its own to
// connect to; isolating it retires the stop-the-dev-stack-before-gate
// ritual for good.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../src/types.js';
import { getWorkerLiveness, workerApplicationName } from '../src/query/worker-liveness.js';
import { ensureTestDatabase } from '../src/testing.js';

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';
let DATABASE_URL: string;

/** A pool that identifies itself the way apps/worker's queue pool does. */
function poolAs(applicationName: string | undefined): pg.Pool {
  return new pg.Pool(
    applicationName === undefined
      ? { connectionString: DATABASE_URL }
      : { connectionString: DATABASE_URL, application_name: applicationName },
  );
}

describe('getWorkerLiveness (real PostgreSQL)', () => {
  let readerPool: pg.Pool;
  let db: Kysely<DB>;

  beforeAll(async () => {
    DATABASE_URL = await ensureTestDatabase(BASE_DATABASE_URL, 'worker_liveness_test');
    // The READER is deliberately unlabelled — it stands in for the server,
    // and must never match its own query.
    readerPool = poolAs(undefined);
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: readerPool }) });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('returns null when no worker is connected', async () => {
    await expect(getWorkerLiveness(db)).resolves.toBeNull();
  });

  it('finds a connected worker and parses its real pid + start time', async () => {
    const pid = 424242;
    const startedAtMs = 1_700_000_000_000;
    const workerPool = poolAs(workerApplicationName(pid, startedAtMs));
    try {
      // Force a connection to actually open — a pg.Pool is lazy, and an
      // unopened pool has no pg_stat_activity row at all.
      await workerPool.query('select 1');

      const liveness = await getWorkerLiveness(db);
      expect(liveness).not.toBeNull();
      expect(liveness?.pid).toBe(pid);
      expect(liveness?.startedAtMs).toBe(startedAtMs);
      // backend_start is a real timestamp, so this proves the epoch
      // extraction produced a sane millisecond value rather than seconds
      // (a units bug would show up here as a value ~1000x too small).
      expect(liveness?.connectedAtMs).toBeGreaterThan(1_600_000_000_000);
      expect(liveness?.connectedAtMs).toBeLessThan(Date.now() + 60_000);
    } finally {
      await workerPool.end();
    }
  });

  it('ignores connections that are not the worker', async () => {
    const otherPool = poolAs('some-other-application');
    try {
      await otherPool.query('select 1');
      await expect(getWorkerLiveness(db)).resolves.toBeNull();
    } finally {
      await otherPool.end();
    }
  });

  it('still reports a connection whose application_name lost its suffix', async () => {
    // Defensive-parse contract: a bare/truncated label still proves a
    // worker is CONNECTED, which is the question being asked. The pid and
    // start time degrade to null rather than the answer degrading to
    // "stopped" — the failure mode this module exists to eliminate.
    const workerPool = poolAs('loombre-worker:');
    try {
      await workerPool.query('select 1');
      const liveness = await getWorkerLiveness(db);
      expect(liveness).not.toBeNull();
      expect(liveness?.pid).toBeNull();
      expect(liveness?.startedAtMs).toBeNull();
    } finally {
      await workerPool.end();
    }
  });
});
