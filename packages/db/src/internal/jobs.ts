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
import { withTransaction } from './tx.js';
import { writeEvent } from './events.js';

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

/**
 * One horizon-homogeneous slice of the boot sweep (item C7 generalized the
 * single flat `types` list into these). A group exists because different
 * job types are stale for different reasons and at wildly different
 * timescales — a background probe queued 23 hours ago may still be worth
 * running; a transcode job queued 23 hours ago belongs to a playback
 * session that was swept out of existence 22 hours and 45 minutes ago.
 */
export interface ReconcileJobLedgerGroup {
  /** ONLY these job types are swept. Keep each group's list to types whose
   *  staleness really is governed by the same two horizons; sweeping every
   *  type in one undifferentiated group would mean an unbounded loop (one
   *  'probe' row per media file after an interrupted scan) and a matching
   *  flood of job.updated outbox events for rows nothing is guarded on. */
  types: readonly string[];
  /** 'queued' rows older than this are treated as orphaned. For the
   *  singleton-guarded background types, pick a horizon past the longest
   *  per-attempt expiry (23h for scan/hwprobe) — old enough that a
   *  still-live queue job re-running promptly after this worker's
   *  consumers register makes the row self-heal anyway. For a job type
   *  tied to a live user session (transcode), the horizon is that
   *  session's own lifetime instead. */
  queuedStaleBeforeMs: number;
  /** 'active' rows last updated before this are treated as orphaned. The
   *  correct value is THIS WORKER PROCESS'S OWN START TIME: the ledger
   *  writes 'active' at fetch time, so under the shipped one-worker-per-
   *  database topology (every installer + docker-compose.prod.yml run
   *  exactly one worker; packages/db/src/query/worker-liveness.ts embeds
   *  the same assumption) any row still 'active' from BEFORE this process
   *  existed was orphaned by a dead predecessor — a crash 5 minutes into
   *  a probe must not wedge the guard until a 24h horizon passes. A row
   *  this process itself marked active always has updated_at_ms >= the
   *  process start and can never qualify. */
  activeStaleBeforeMs: number;
  /** Hard cap on rows this group may reconcile in ONE pass. Omit for a
   *  singleton group (bounded by construction — one row per type). REQUIRED
   *  in spirit for any many-concurrent-rows type: it is what keeps the
   *  sweep, and the job.updated outbox events it writes, bounded on an
   *  install that accumulated a large backlog. Whatever is left over is
   *  swept by the next boot; nothing is lost, it just takes longer to
   *  drain than it does to accumulate — the correct trade for a boot-path
   *  step on Tier-0 hardware. */
  maxRows?: number;
}

export interface ReconcileAbandonedJobsInput {
  /** Swept in order, all inside ONE transaction — a partial sweep would
   *  leave the ledger in a state no single boot ever produced. */
  groups: readonly ReconcileJobLedgerGroup[];
  nowMs: number;
}

export interface AbandonedJobLedgerRow {
  id: string;
  type: string;
  previousStatus: Extract<JobStatus, 'queued' | 'active'>;
}

/** Plain language on purpose: this string lands in jobs.last_error and is
 *  surfaced verbatim to end users (admin jobs panel, and — for hwprobe —
 *  GET /admin/capabilities' probe.lastError on the System page and setup
 *  wizard). No ledger/sweep/retention jargon. */
const RECONCILED_MESSAGE =
  'This job was interrupted — the background worker stopped before it finished. ' +
  'It was marked failed when the worker restarted, and runs again automatically if still needed.';

/**
 * W1/D-1 (2026-08-07): boot-time ledger reconciliation. The ledger only
 * ever transitions inside the worker's in-process batch handler
 * (packages/jobs/src/queue.ts) — pg-boss's SQL-side sweeps (timeout-fail
 * of fetched jobs whose worker died; retention-delete of never-fetched
 * jobs, default 14 days) never mirror into it. A worker outage could
 * therefore leave rows stuck 'queued'/'active' forever, which (a) lies to
 * the admin jobs UI and (b) permanently satisfies
 * hasQueuedOrActiveJobOfType's singleton guard — the hwprobe boot
 * re-enqueue then never fires again, so hardware capabilities read
 * "never probed" for the install's remaining lifetime.
 *
 * Flips each such stale row to 'failed' and writes a job.updated outbox
 * event in the SAME transaction — the exact pattern packages/jobs/src/
 * ledger.ts uses for every ordinary transition.
 *
 * Item C7 (2026-08-11) generalized the original single flat type list into
 * `groups`, each with its own two horizons and an optional row cap. That
 * is what let 'transcode' — the one job type whose orphaned rows are the
 * signature of a detached ffmpeg still burning CPU — be folded in WITHOUT
 * pretending it is a singleton: it is one row per playback session, many
 * concurrent, and its staleness is measured against a session's lifetime
 * rather than a background job's retry window.
 *
 * Concurrency: the worker's queue consumers register at module scope and
 * can be fetching jobs WHILE main() runs this, so a row this sweep read as
 * stale may be moved to 'active' by recordActive at any moment. Two
 * defenses, both required: the SELECT takes FOR UPDATE row locks (a
 * concurrent recordActive blocks until this transaction commits, then
 * overwrites 'failed' with 'active' — self-healing by design, since
 * transitionJobLedgerRow has no status guard), and every per-row UPDATE
 * re-asserts the full staleness predicate, so a row that changed between
 * any interleaving (or a second worker boot racing this one) updates zero
 * rows and emits zero events instead of clobbering live state.
 */
export async function reconcileAbandonedJobLedgerRows(
  db: DbOrTx,
  input: ReconcileAbandonedJobsInput
): Promise<AbandonedJobLedgerRow[]> {
  const groups = input.groups.filter((group) => group.types.length > 0);
  if (groups.length === 0) return [];
  return withTransaction(db, async (trx) => {
    const reconciled: AbandonedJobLedgerRow[] = [];

    for (const group of groups) {
      let query = trx
        .selectFrom('jobs')
        .select(['id', 'type', 'status', 'updated_at_ms'])
        .where('type', 'in', [...group.types])
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'queued'), eb('updated_at_ms', '<', group.queuedStaleBeforeMs)]),
            eb.and([eb('status', '=', 'active'), eb('updated_at_ms', '<', group.activeStaleBeforeMs)]),
          ])
        );
      if (group.maxRows !== undefined) {
        // Oldest first, so a bounded pass always drains the rows that have
        // been wrong for longest rather than an arbitrary slice.
        query = query.orderBy('updated_at_ms', 'asc').limit(group.maxRows);
      }
      const stale = await query.forUpdate().execute();
      if (stale.length === 0) continue;

      for (const row of stale) {
        const previousStatus = row.status as AbandonedJobLedgerRow['previousStatus'];
        const staleBeforeMs = previousStatus === 'queued' ? group.queuedStaleBeforeMs : group.activeStaleBeforeMs;
        const updated = await trx
          .updateTable('jobs')
          .set({
            status: 'failed',
            last_error: RECONCILED_MESSAGE,
            finished_at_ms: input.nowMs,
            updated_at_ms: input.nowMs,
          })
          .where('id', '=', row.id)
          .where('status', '=', previousStatus)
          .where('updated_at_ms', '<', staleBeforeMs)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows ?? 0) === 0) continue;

        await writeEvent(trx, {
          type: 'job.updated',
          tsMs: input.nowMs,
          actorUserId: null,
          payload: {
            jobId: row.id,
            jobType: row.type,
            status: 'failed',
            errorMessage: RECONCILED_MESSAGE,
            updatedAtMs: input.nowMs,
          },
        });
        reconciled.push({ id: row.id, type: row.type, previousStatus });
      }
    }

    return reconciled;
  });
}
