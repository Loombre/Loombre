// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/src/ledger.ts
//
// Mirrors pg-boss enqueue/lifecycle transitions into the existing `jobs`
// table (typed columns only, P1.15) via @loombre/db/internal, so the admin
// UI always reads our table, never pg-boss's own `pgboss` schema. This is
// the reason packages/jobs is one of the callers the repo-root
// dependency-cruiser rule "no-internal-db-outside-worker" allows to import
// @loombre/db/internal.
//
// P4.13 (STATE.md, deliverable D): every transition below ALSO writes a
// `job.updated` outbox event, in the SAME transaction as the ledger
// row write/update — the identical outbox pattern
// packages/db/src/query/libraries.ts's createLibrary and
// apps/worker/src/scan/scanner.ts's scan.started/scan.completed already
// use (writeEvent only accepts a live `Transaction<DB>` handle, so "write
// the event outside the transaction" is a compile error, not a runtime
// foot-gun). This makes the admin jobs dashboard live via the events
// socket instead of a poll loop (apps/server's WS broadcaster delivers
// job.updated to admin-context sockets only — see that module). Emission
// is deliberately status-transition-granular, not progress-tick-granular
// (job.updated.schema.json's own header): the ledger has no notion of
// per-tick progress at all, so `progress` is simply omitted from every
// payload here (the schema marks it optional for exactly this reason)
// rather than faked with a placeholder value.
//
// M-7 fix wave (second half): recordRetrying/recordFailed redact
// filesystem-path components out of the caller-supplied `errorMessage`
// BEFORE it is used anywhere — both the persisted `jobs.last_error` column
// and the emitted `job.updated` payload get the SAME already-redacted
// string, by construction (there is no code path that could persist the
// raw one to either place). See redact-paths.ts's own header for why this
// is a deliberate LOCAL duplicate of packages/shared's implementation.
// Narrow: only path components are touched, never the rest of the message.
//
// browser-admin-F13: every payload also carries `attempts` — the value the
// ledger WRITE ITSELF RETURNED (insertJobLedgerRow/transitionJobLedgerRow
// both `returningAll()`), never the caller's argument echoed back. That is
// what makes it the committed column value by construction at every call
// site, for free (no extra read): recordCompleted/recordFailed don't take
// an attempts argument at all and would otherwise have nothing to send,
// and recordActive's argument is optional (an omitted one leaves the column
// untouched, so echoing it would emit `undefined` where the row still holds
// a real count). apps/web's admin jobs surface renders its "N attempts"
// chip straight off this, so a live-merged row now has the same anatomy as
// a GET /admin/jobs one instead of waiting for a refetch.

import { createDb } from '@loombre/db';
import { insertJobLedgerRow, transitionJobLedgerRow, withTransaction, writeEvent } from '@loombre/db/internal';
import { redactAllPaths } from './redact-paths.js';
import type { JobType } from './types.js';

interface EmitJobUpdatedInput {
  jobId: string;
  jobType: string;
  status: 'queued' | 'active' | 'completed' | 'failed';
  /** The committed `jobs.attempts` value, read off the row the write
   *  returned. The schema marks it optional (a consumer that sees it
   *  absent must keep whatever count it already had) — this emitter
   *  always sends it. */
  attempts: number;
  errorMessage: string | null;
  updatedAtMs: number;
}

// `Transaction<DB>` isn't exported from either @loombre/db barrel (see
// packages/db/src/internal/events.ts's own header for why writeEvent's
// signature is pinned to it) — reusing writeEvent's own first-parameter
// type here avoids needing that export just for this one local helper.
function emitJobUpdated(trx: Parameters<typeof writeEvent>[0], input: EmitJobUpdatedInput): Promise<unknown> {
  return writeEvent(trx, {
    type: 'job.updated',
    tsMs: input.updatedAtMs,
    actorUserId: null,
    payload: {
      jobId: input.jobId,
      jobType: input.jobType,
      status: input.status,
      attempts: input.attempts,
      errorMessage: input.errorMessage,
      updatedAtMs: input.updatedAtMs,
    },
  });
}

export interface Ledger {
  recordQueued(
    id: string,
    type: JobType,
    opts: { priority?: number; subjectItemId?: string | null }
  ): Promise<void>;
  /** `attempts` is the 1-based attempt number the queue driver is starting
   *  (pg-boss's `retryCount + 1`); omitted by callers that don't dispatch
   *  through a retrying driver, which leaves the column untouched. */
  recordActive(id: string, attempts?: number): Promise<void>;
  recordCompleted(id: string): Promise<void>;
  /** NON-terminal failure: the driver still owns the job and will re-dispatch
   *  it. The row goes back to 'queued' (the `jobs.job_status` enum has no
   *  'retrying' member) carrying the error, and `finished_at_ms` stays unset
   *  so nothing downstream reads it as a completed job. */
  recordRetrying(id: string, errorMessage: string, attempts: number): Promise<void>;
  recordFailed(id: string, errorMessage: string): Promise<void>;
  destroy(): Promise<void>;
}

export function createLedger(connectionString: string): Ledger {
  const db = createDb(connectionString);

  return {
    async recordQueued(id, type, opts) {
      const now = Date.now();
      await withTransaction(db, async (trx) => {
        const row = await insertJobLedgerRow(trx, {
          id,
          type,
          status: 'queued',
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          subjectItemId: opts.subjectItemId ?? null,
          createdAtMs: now,
          updatedAtMs: now,
        });
        await emitJobUpdated(trx, { jobId: id, jobType: type, status: 'queued', attempts: row.attempts, errorMessage: null, updatedAtMs: now });
      });
    },

    async recordActive(id, attempts) {
      const now = Date.now();
      await withTransaction(db, async (trx) => {
        const row = await transitionJobLedgerRow(trx, id, {
          status: 'active',
          ...(attempts !== undefined ? { attempts } : {}),
          startedAtMs: now,
          // Cleared explicitly: a row the W1 boot reconciliation marked
          // failed (finished_at_ms set) that pg-boss then delivers anyway
          // must not report an 'active' job with a finish time in the
          // past (negative durations for any consumer that subtracts).
          finishedAtMs: null,
          updatedAtMs: now,
        });
        await emitJobUpdated(trx, { jobId: id, jobType: row.type, status: 'active', attempts: row.attempts, errorMessage: null, updatedAtMs: now });
      });
    },

    async recordCompleted(id) {
      const now = Date.now();
      await withTransaction(db, async (trx) => {
        const row = await transitionJobLedgerRow(trx, id, {
          status: 'completed',
          finishedAtMs: now,
          updatedAtMs: now,
        });
        await emitJobUpdated(trx, { jobId: id, jobType: row.type, status: 'completed', attempts: row.attempts, errorMessage: null, updatedAtMs: now });
      });
    },

    async recordRetrying(id, errorMessage, attempts) {
      const now = Date.now();
      // M-7: redact ONCE — the same already-redacted string is what gets
      // persisted AND emitted, so there is no path that could send the raw
      // one to either place.
      const redactedErrorMessage = redactAllPaths(errorMessage);
      await withTransaction(db, async (trx) => {
        const row = await transitionJobLedgerRow(trx, id, {
          status: 'queued',
          attempts,
          lastError: redactedErrorMessage,
          updatedAtMs: now,
        });
        await emitJobUpdated(trx, { jobId: id, jobType: row.type, status: 'queued', attempts: row.attempts, errorMessage: redactedErrorMessage, updatedAtMs: now });
      });
    },

    async recordFailed(id, errorMessage) {
      const now = Date.now();
      const redactedErrorMessage = redactAllPaths(errorMessage); // M-7 — see recordRetrying's comment
      await withTransaction(db, async (trx) => {
        const row = await transitionJobLedgerRow(trx, id, {
          status: 'failed',
          lastError: redactedErrorMessage,
          finishedAtMs: now,
          updatedAtMs: now,
        });
        await emitJobUpdated(trx, { jobId: id, jobType: row.type, status: 'failed', attempts: row.attempts, errorMessage: redactedErrorMessage, updatedAtMs: now });
      });
    },

    async destroy() {
      await db.destroy();
    },
  };
}
