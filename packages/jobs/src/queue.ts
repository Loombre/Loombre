// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/src/queue.ts
//
// createJobQueue() — the typed queue abstraction (D5, P1.15). pg-boss is
// the Tier-0 driver (no Redis daemon required for small installs); it owns
// its own `pgboss` schema in the same database, entirely separate from
// packages/db's migrations (verified: db:migrate-check's scratch-schema
// replay and packages/db's live-DB test suites are unaffected by pg-boss
// having started against the same DATABASE_URL — see packages/jobs/README
// notes in this file's PR).
//
// Every enqueue and lifecycle transition is mirrored into the `jobs` table
// via src/ledger.ts so the admin UI never has to read pg-boss internals.

import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { createLedger, type Ledger } from './ledger.js';
import { JOB_TYPES, type JobPayloads, type JobType } from './types.js';

export interface EnqueueOptions {
  priority?: number;
  subjectItemId?: string | null;
}

export interface WorkOptions {
  /** Number of jobs this node processes concurrently for this queue.
   *  @default 1 */
  concurrency?: number;
}

export type JobHandler<T extends JobType> = (
  payload: JobPayloads[T],
  meta: { jobId: string }
) => Promise<void>;

export interface JobQueue {
  enqueue<T extends JobType>(type: T, payload: JobPayloads[T], opts?: EnqueueOptions): Promise<string>;
  work<T extends JobType>(type: T, handler: JobHandler<T>, opts?: WorkOptions): void;
  stop(): Promise<void>;
}

export function createJobQueue(connectionString: string): JobQueue {
  const boss = new PgBoss(connectionString);
  const ledger: Ledger = createLedger(connectionString);

  boss.on('error', (err: unknown) => {
    console.error('[@loombre/jobs] pg-boss error:', err);
  });

  let startPromise: Promise<void> | null = null;
  function ensureStarted(): Promise<void> {
    startPromise ??= (async () => {
      await boss.start();
      for (const type of JOB_TYPES) {
        await boss.createQueue(type);
      }
    })();
    return startPromise;
  }

  return {
    async enqueue(type, payload, opts = {}) {
      await ensureStarted();

      // Own the job id so the ledger row is written BEFORE the job is
      // published to pg-boss. Otherwise boss.send() can make the job visible
      // to a worker (and its recordActive/recordCompleted fire) before
      // recordQueued commits the row — the worker's transition then hits a
      // missing row. Writing queued-first closes that race deterministically;
      // pg-boss accepts our id via SendOptions.id.
      const jobId = randomUUID();
      await ledger.recordQueued(jobId, type, opts);

      let sent: string | null;
      try {
        sent = await boss.send(type, payload, {
          id: jobId,
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        });
      } catch (err) {
        // The queued ledger row now describes a job that never made it into
        // pg-boss — mark it failed so the admin UI doesn't show a phantom
        // job stuck 'queued' forever.
        await ledger
          .recordFailed(jobId, err instanceof Error ? err.message : String(err))
          .catch(() => undefined);
        throw err;
      }

      if (!sent) {
        // send() returns null only under a throttle/debounce policy, which
        // this queue's `standard` queues never configure — kept as a hard
        // failure rather than a silently-swallowed enqueue.
        await ledger.recordFailed(jobId, `enqueue(${type}) returned no job id`).catch(() => undefined);
        throw new Error(`@loombre/jobs: enqueue(${type}) returned no job id`);
      }

      return jobId;
    },

    work(type, handler, opts = {}) {
      // Fire-and-register: work() itself is synchronous in this
      // abstraction's API (matches the task's `work(...): void` shape), so
      // the async pg-boss registration is chained onto ensureStarted()
      // rather than awaited here.
      void ensureStarted()
        .then(() =>
          boss.work(
            type,
            { localConcurrency: opts.concurrency ?? 1, perJobResults: true },
            async (jobs) => {
              const results: { id: string; status: 'completed' | 'failed'; output?: unknown }[] = [];
              for (const job of jobs) {
                // recordActive is INSIDE the try: a missing ledger row (e.g.
                // a crash between boss.send and recordQueued left a job with
                // no ledger row) must not throw out of the batch handler —
                // that would abort every remaining job in this fetched batch
                // and leave them dequeued-but-never-run. Ledger bookkeeping
                // failures degrade to a failed-status result for that one
                // job, never a lost batch.
                try {
                  await ledger.recordActive(job.id);
                  await handler(job.data as JobPayloads[typeof type], { jobId: job.id });
                  await ledger.recordCompleted(job.id);
                  results.push({ id: job.id, status: 'completed' });
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  await ledger.recordFailed(job.id, message).catch((ledgerErr: unknown) => {
                    console.error(`[@loombre/jobs] ledger recordFailed failed for job ${job.id}:`, ledgerErr);
                  });
                  results.push({ id: job.id, status: 'failed', output: { message } });
                }
              }
              return results;
            }
          )
        )
        .catch((err: unknown) => {
          console.error(`[@loombre/jobs] failed to register work handler for "${type}":`, err);
        });
    },

    async stop() {
      if (startPromise) {
        await startPromise.catch(() => undefined);
      }
      await boss.stop();
      await ledger.destroy();
    },
  };
}
