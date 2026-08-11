// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/jobs-reconcile.spec.ts
//
// W1/D-1 (2026-08-07) regression: pg-boss's SQL-side sweeps (timeout-fail
// of 'active' jobs, retention-delete of never-fetched jobs) never touch
// Loombre's own jobs LEDGER, so a worker outage could leave rows stuck
// 'queued'/'active' forever — permanently satisfying
// hasQueuedOrActiveJobOfType's singleton guard and wedging the boot-time
// hwprobe/image-backfill/stash re-enqueues (a probe that could never run
// again = "no hardware capabilities, ever" on the System page). This spec
// pins the boot-time reconciliation that unwedges it, including the
// opus-review hardenings (W1-R1/R3): type-scoped to the singleton-guarded
// job types only; split horizons ('queued' after 24h, 'active' the moment
// it predates the booting process — a crash minutes into a probe unwedges
// on the NEXT boot); per-row UPDATEs re-assert the staleness predicate so
// a concurrent recordActive can never be clobbered; and the last_error
// text is plain language because it surfaces verbatim to end users via
// probe.lastError.
//
// SELF-SUFFICIENT like internal.spec.ts (schema reset in beforeAll);
// connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db.js';
import {
  getJobLedgerRow,
  hasQueuedOrActiveJobOfType,
  insertJobLedgerRow,
  reconcileAbandonedJobLedgerRows,
} from '../src/internal/index.js';
import { resolveTestDatabaseUrl } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = resolveTestDatabaseUrl();

function resetSchema(): void {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate.mjs'), 'reset'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`migrate.mjs reset failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

const HOUR_MS = 60 * 60 * 1000;

describe('reconcileAbandonedJobLedgerRows (W1: unwedge the singleton guards)', () => {
  const db = createDb(DATABASE_URL);
  const nowMs = Date.now();
  // Simulates a worker that booted 1h ago sweeping at boot time.
  const workerStartedAtMs = nowMs - 1 * HOUR_MS;
  const input = {
    types: ['hwprobe', 'image-backfill', 'stash-inventory', 'stash-sync'] as const,
    queuedStaleBeforeMs: nowMs - 24 * HOUR_MS,
    activeStaleBeforeMs: workerStartedAtMs,
    nowMs,
  };

  const staleQueuedHwprobeId = randomUUID(); // the exact Windows-ARM-VM wedge
  const orphanedActiveStashId = randomUUID(); // predecessor died mid-run
  const crashRecentActiveHwprobeId = randomUUID(); // started AFTER this process booted — must survive
  const freshQueuedBackfillId = randomUUID();
  const outOfScopeQueuedProbeId = randomUUID(); // 'probe' is not singleton-guarded
  const oldCompletedId = randomUUID();
  const oldFailedId = randomUUID();

  beforeAll(async () => {
    resetSchema();
    await insertJobLedgerRow(db, {
      id: staleQueuedHwprobeId,
      type: 'hwprobe',
      status: 'queued',
      createdAtMs: nowMs - 240 * HOUR_MS,
      updatedAtMs: nowMs - 240 * HOUR_MS,
    });
    await insertJobLedgerRow(db, {
      id: orphanedActiveStashId,
      type: 'stash-sync',
      status: 'active',
      createdAtMs: nowMs - 3 * HOUR_MS,
      updatedAtMs: nowMs - 2 * HOUR_MS, // before workerStartedAtMs -> orphaned
    });
    await insertJobLedgerRow(db, {
      id: crashRecentActiveHwprobeId,
      type: 'image-backfill',
      status: 'active',
      createdAtMs: nowMs - 30 * 60 * 1000,
      updatedAtMs: nowMs - 30 * 60 * 1000, // AFTER workerStartedAtMs -> this process's own job
    });
    await insertJobLedgerRow(db, {
      id: freshQueuedBackfillId,
      type: 'stash-inventory',
      status: 'queued',
      createdAtMs: nowMs - 1 * HOUR_MS,
      updatedAtMs: nowMs - 1 * HOUR_MS, // inside the 24h queued horizon
    });
    await insertJobLedgerRow(db, {
      id: outOfScopeQueuedProbeId,
      type: 'probe',
      status: 'queued',
      createdAtMs: nowMs - 240 * HOUR_MS,
      updatedAtMs: nowMs - 240 * HOUR_MS, // stale, but NOT a singleton-guarded type
    });
    await insertJobLedgerRow(db, {
      id: oldCompletedId,
      type: 'hwprobe',
      status: 'completed',
      createdAtMs: nowMs - 240 * HOUR_MS,
      updatedAtMs: nowMs - 240 * HOUR_MS,
    });
    await insertJobLedgerRow(db, {
      id: oldFailedId,
      type: 'stash-sync',
      status: 'failed',
      createdAtMs: nowMs - 240 * HOUR_MS,
      updatedAtMs: nowMs - 240 * HOUR_MS,
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('the wedge exists before reconciliation: stale queued hwprobe satisfies the singleton guard', async () => {
    expect(await hasQueuedOrActiveJobOfType(db, 'hwprobe')).toBe(true);
  });

  it('flips exactly the orphaned singleton-guarded rows to failed; spares fresh, own-process-active, out-of-scope, and terminal rows', async () => {
    const reconciled = await reconcileAbandonedJobLedgerRows(db, input);

    expect(reconciled.map((r) => ({ id: r.id, type: r.type, previousStatus: r.previousStatus }))).toEqual(
      expect.arrayContaining([
        { id: staleQueuedHwprobeId, type: 'hwprobe', previousStatus: 'queued' },
        { id: orphanedActiveStashId, type: 'stash-sync', previousStatus: 'active' },
      ]),
    );
    expect(reconciled).toHaveLength(2);

    const staleQueued = await getJobLedgerRow(db, staleQueuedHwprobeId);
    expect(staleQueued?.status).toBe('failed');
    expect(staleQueued?.finished_at_ms).toBe(nowMs);
    expect(staleQueued?.updated_at_ms).toBe(nowMs);

    expect((await getJobLedgerRow(db, orphanedActiveStashId))?.status).toBe('failed');
    expect((await getJobLedgerRow(db, crashRecentActiveHwprobeId))?.status).toBe('active');
    expect((await getJobLedgerRow(db, freshQueuedBackfillId))?.status).toBe('queued');
    expect((await getJobLedgerRow(db, outOfScopeQueuedProbeId))?.status).toBe('queued');
    expect((await getJobLedgerRow(db, oldCompletedId))?.status).toBe('completed');
    expect((await getJobLedgerRow(db, oldFailedId))?.status).toBe('failed');
  });

  it('last_error is plain language (it surfaces verbatim to end users via probe.lastError), no queue jargon', async () => {
    const row = await getJobLedgerRow(db, staleQueuedHwprobeId);
    expect(row?.last_error).toMatch(/interrupted/i);
    expect(row?.last_error).toMatch(/runs again automatically/i);
    expect(row?.last_error).not.toMatch(/ledger|retention|sweep|stale/i);
  });

  it('unwedges the hwprobe singleton guard; legitimately-live guards stay intact', async () => {
    expect(await hasQueuedOrActiveJobOfType(db, 'hwprobe')).toBe(false);
    expect(await hasQueuedOrActiveJobOfType(db, 'stash-inventory')).toBe(true); // fresh queued row
    expect(await hasQueuedOrActiveJobOfType(db, 'image-backfill')).toBe(true); // this process's active row
  });

  it('writes a plain-language job.updated outbox event per reconciled row (and only those rows)', async () => {
    const events = await db.selectFrom('events').selectAll().where('type', '=', 'job.updated').execute();
    const payloads = events.map((e) => e.payload as { jobId: string; status: string; errorMessage: string | null });
    const reconciledIds = new Set([staleQueuedHwprobeId, orphanedActiveStashId]);
    const reconciledPayloads = payloads.filter((p) => reconciledIds.has(p.jobId));
    expect(reconciledPayloads).toHaveLength(2);
    for (const payload of reconciledPayloads) {
      expect(payload.status).toBe('failed');
      expect(payload.errorMessage).toMatch(/interrupted/i);
    }
    // No events for spared rows.
    const sparedIds = [crashRecentActiveHwprobeId, freshQueuedBackfillId, outOfScopeQueuedProbeId];
    expect(payloads.filter((p) => sparedIds.includes(p.jobId))).toHaveLength(0);
  });

  it('is idempotent: a second run finds nothing left to reconcile', async () => {
    const again = await reconcileAbandonedJobLedgerRows(db, { ...input, nowMs: nowMs + 1 });
    expect(again).toEqual([]);
  });

  it('a row whose status changed between SELECT and UPDATE is never clobbered (predicate re-asserted)', async () => {
    // Simulate the race outcome directly: a stale-looking queued row that a
    // concurrent recordActive moves to 'active' with a fresh timestamp
    // must survive a reconcile pass unchanged. (The FOR UPDATE lock makes
    // the true interleaving serialize; this pins the predicate half.)
    const racedId = randomUUID();
    await insertJobLedgerRow(db, {
      id: racedId,
      type: 'hwprobe',
      status: 'active',
      createdAtMs: nowMs - 240 * HOUR_MS,
      updatedAtMs: nowMs, // recordActive just touched it
    });
    const result = await reconcileAbandonedJobLedgerRows(db, { ...input, nowMs: nowMs + 2 });
    expect(result).toEqual([]);
    expect((await getJobLedgerRow(db, racedId))?.status).toBe('active');
  });
});
