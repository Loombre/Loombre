// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/test/queue.spec.ts
//
// Live-DB test for the pg-boss driver (P1.15). SELF-SUFFICIENT like
// packages/db/test/*.spec.ts: beforeAll resets packages/db's schema so the
// `jobs` ledger table exists. Verification reads the ledger via
// @loombre/db/internal's getJobLedgerRow (not raw pg/kysely — this package
// stays inside the same guard-free-but-typed boundary its own source does)
// and does NOT touch pg-boss's own `pgboss` schema directly, proving the
// admin-facing surface is entirely our typed table.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, ensureTestDatabase, resolveTestDatabaseUrl } from '@loombre/db';
import { getJobLedgerRow } from '@loombre/db/internal';
import { createJobQueue, type JobQueue } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../db');

// PER-SUITE DATABASE (Wave A / A1's recommendation, swept at pre-D
// consolidation). This suite RESETS the schema in its own hook; on the
// shared `<base>_test` database a sibling package's reset landing mid-run
// wipes it out from under whatever is executing and presents as a product
// bug. `ensureTestDatabase` gives it one of its own — resolved at module
// load (top-level await) so every describe-scope handle below is built
// against the right connection string.
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), 'jobs_queue_test');

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && predicate(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

let queue: JobQueue;
const readDb = createDb(DATABASE_URL);

beforeAll(() => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  queue = createJobQueue(DATABASE_URL);
}, 30_000);

afterAll(async () => {
  await queue?.stop();
  await readDb.destroy();
});

describe('createJobQueue (P1.15)', () => {
  it(
    'enqueue("scan") is delivered to a typed work() handler, and the jobs ledger row transitions queued -> active -> completed',
    async () => {
      let receivedPayload: unknown;
      let receivedJobId: string | undefined;

      queue.work('scan', async (payload, meta) => {
        receivedPayload = payload;
        receivedJobId = meta.jobId;
      });

      const jobId = await queue.enqueue('scan', { libraryId: 'lib-123', full: true });
      expect(typeof jobId).toBe('string');

      // Immediately after enqueue, the ledger row exists as 'queued'.
      const queuedRow = await getJobLedgerRow(readDb, jobId);
      expect(queuedRow).toBeDefined();
      expect(queuedRow?.type).toBe('scan');
      expect(['queued', 'active', 'completed']).toContain(queuedRow?.status);

      const completedRow = await waitFor(
        () => getJobLedgerRow(readDb, jobId),
        (row) => row.status === 'completed',
        15_000
      );

      expect(completedRow.status).toBe('completed');
      expect(completedRow.started_at_ms).not.toBeNull();
      expect(completedRow.finished_at_ms).not.toBeNull();

      expect(receivedJobId).toBe(jobId);
      expect(receivedPayload).toEqual({ libraryId: 'lib-123', full: true });
    },
    20_000
  );

  it('a handler that throws marks the ledger row failed with the error message recorded', async () => {
    queue.work('probe', async () => {
      throw new Error('deliberate probe failure');
    });

    const jobId = await queue.enqueue('probe', { mediaFileId: 'file-abc' });

    const failedRow = await waitFor(
      () => getJobLedgerRow(readDb, jobId),
      (row) => row.status === 'failed',
      15_000
    );

    expect(failedRow.status).toBe('failed');
    expect(failedRow.last_error).toContain('deliberate probe failure');
  }, 20_000);
});
