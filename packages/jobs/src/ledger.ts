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

import { createDb } from '@loombre/db';
import { insertJobLedgerRow, transitionJobLedgerRow, withTransaction, writeEvent } from '@loombre/db/internal';
import type { JobType } from './types.js';

interface EmitJobUpdatedInput {
  jobId: string;
  jobType: string;
  status: 'queued' | 'active' | 'completed' | 'failed';
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
  recordActive(id: string): Promise<void>;
  recordCompleted(id: string): Promise<void>;
  recordFailed(id: string, errorMessage: string): Promise<void>;
  destroy(): Promise<void>;
}

export function createLedger(connectionString: string): Ledger {
  const db = createDb(connectionString);

  return {
    async recordQueued(id, type, opts) {
      const now = Date.now();
      await withTransaction(db, async (trx) => {
        await insertJobLedgerRow(trx, {
          id,
          type,
          status: 'queued',
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
          subjectItemId: opts.subjectItemId ?? null,
          createdAtMs: now,
          updatedAtMs: now,
        });
        await emitJobUpdated(trx, { jobId: id, jobType: type, status: 'queued', errorMessage: null, updatedAtMs: now });
      });
    },

    async recordActive(id) {
      const now = Date.now();
      await withTransaction(db, async (trx) => {
        const row = await transitionJobLedgerRow(trx, id, {
          status: 'active',
          startedAtMs: now,
          updatedAtMs: now,
        });
        await emitJobUpdated(trx, { jobId: id, jobType: row.type, status: 'active', errorMessage: null, updatedAtMs: now });
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
        await emitJobUpdated(trx, { jobId: id, jobType: row.type, status: 'completed', errorMessage: null, updatedAtMs: now });
      });
    },

    async recordFailed(id, errorMessage) {
      const now = Date.now();
      await withTransaction(db, async (trx) => {
        const row = await transitionJobLedgerRow(trx, id, {
          status: 'failed',
          lastError: errorMessage,
          finishedAtMs: now,
          updatedAtMs: now,
        });
        await emitJobUpdated(trx, { jobId: id, jobType: row.type, status: 'failed', errorMessage, updatedAtMs: now });
      });
    },

    async destroy() {
      await db.destroy();
    },
  };
}
