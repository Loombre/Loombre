// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/jobs.ts
//
// Writers for the `jobs` ledger table (0001_init.sql: "queue-agnostic
// ledger"). Consumed by @loombre/jobs's pg-boss driver to mirror
// enqueue/lifecycle transitions so the admin UI always reads this table,
// never pg-boss's own `pgboss` schema (P1.15) — see
// .dependency-cruiser.cjs's "no-internal-db-outside-worker" rule for why
// packages/jobs is one of the two callers allowed to import this module.

import type { Selectable } from 'kysely';
import type { JobsTable, JobStatus } from '../types.js';
import type { DbOrTx } from './tx.js';

export type JobLedgerRow = Selectable<JobsTable>;

export interface InsertJobLedgerRowInput {
  /** The queue driver's own job id (pg-boss's job id) — kept identical so
   *  the ledger row and the underlying queue job are the same identity. */
  id: string;
  type: string;
  status?: JobStatus;
  priority?: number;
  subjectItemId?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export async function insertJobLedgerRow(
  db: DbOrTx,
  input: InsertJobLedgerRowInput
): Promise<JobLedgerRow> {
  return db
    .insertInto('jobs')
    .values({
      id: input.id,
      type: input.type,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      subject_item_id: input.subjectItemId ?? null,
      created_at_ms: input.createdAtMs,
      updated_at_ms: input.updatedAtMs,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface TransitionJobLedgerRowInput {
  status: JobStatus;
  attempts?: number;
  lastError?: string | null;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
  updatedAtMs: number;
}

/** Moves an existing ledger row to a new status (queued->active->completed/
 *  failed/cancelled), updating only the fields the caller supplies. */
export async function transitionJobLedgerRow(
  db: DbOrTx,
  id: string,
  input: TransitionJobLedgerRowInput
): Promise<JobLedgerRow> {
  return db
    .updateTable('jobs')
    .set({
      status: input.status,
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
      ...(input.startedAtMs !== undefined ? { started_at_ms: input.startedAtMs } : {}),
      ...(input.finishedAtMs !== undefined ? { finished_at_ms: input.finishedAtMs } : {}),
      updated_at_ms: input.updatedAtMs,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getJobLedgerRow(db: DbOrTx, id: string): Promise<JobLedgerRow | undefined> {
  return db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
}

/**
 * Application-level "singleton key" check (P2.11's one-time image-backfill
 * job): true if a ledger row of `type` is currently queued or active.
 * packages/jobs' createJobQueue() (out of this wave's edit scope) does not
 * expose pg-boss's native singletonKey option through EnqueueOptions, so
 * the boot-time enqueue instead consults this ledger read first — same
 * effect (a restart never stacks a second concurrent backfill job) without
 * touching the queue driver.
 */
export async function hasQueuedOrActiveJobOfType(db: DbOrTx, type: string): Promise<boolean> {
  const row = await db
    .selectFrom('jobs')
    .select('id')
    .where('type', '=', type)
    .where('status', 'in', ['queued', 'active'])
    .executeTakeFirst();
  return row !== undefined;
}
