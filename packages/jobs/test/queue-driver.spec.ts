// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/test/queue-driver.spec.ts
//
// Driver-seam tests for createJobQueue: the behaviours that are invisible
// to the live-DB suite in queue.spec.ts because they only manifest against
// pg-boss's own bookkeeping (queue provisioning options, and how a handler
// failure is mirrored while pg-boss still owns the job for a retry).
// pg-boss and the ledger are both stubbed here — this file asserts what the
// driver is TOLD, not what Postgres ends up holding.

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** pg-boss's own QUEUE_DEFAULTS.expire_seconds — the value this package must
 *  never silently inherit for a job that can outlive 15 minutes. */
const PG_BOSS_DEFAULT_EXPIRE_SECONDS = 900;
/** pg-boss asserts `expireInSeconds / 3600 < 24`. */
const PG_BOSS_MAX_EXPIRE_SECONDS = 24 * 60 * 60;

type BatchJob = { id: string; data: unknown; retryCount: number; retryLimit: number };
type BatchHandler = (jobs: BatchJob[]) => Promise<{ id: string; status: string; output?: unknown }[]>;

const mocks = vi.hoisted(() => {
  const ledger = {
    recordQueued: vi.fn(async () => {}),
    recordActive: vi.fn(async () => {}),
    recordCompleted: vi.fn(async () => {}),
    recordRetrying: vi.fn(async () => {}),
    recordFailed: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };
  const boss = {
    on: vi.fn(),
    start: vi.fn(async () => {}),
    createQueue: vi.fn(async (_name: string, _options?: unknown) => {}),
    updateQueue: vi.fn(async (_name: string, _options?: unknown) => {}),
    send: vi.fn(async (_name: string, _data: unknown, options: { id: string }) => options.id),
    work: vi.fn(async (_name: string, _options: Record<string, unknown>, _handler: BatchHandler) => 'worker-id'),
    stop: vi.fn(async () => {}),
  };
  return { ledger, boss };
});

vi.mock('pg-boss', () => ({
  // A constructor: queue.ts does `new PgBoss(...)`, and returning an object
  // from a constructor is what substitutes the stub for the real instance.
  PgBoss: function PgBossStub() {
    return mocks.boss;
  },
}));
vi.mock('../src/ledger.js', () => ({ createLedger: () => mocks.ledger }));

import { createJobQueue } from '../src/queue.js';
import { JOB_QUEUE_OPTIONS, JOB_TYPES } from '../src/types.js';

const DSN = 'postgres://loombre:loombre@localhost:5442/loombre';

/** Registers a work() handler and returns the batch handler createJobQueue
 *  actually handed to pg-boss (registration is chained onto ensureStarted,
 *  so it lands a microtask or two after work() returns). */
async function registerHandler(handler: () => Promise<void>): Promise<BatchHandler> {
  const queue = createJobQueue(DSN);
  queue.work('probe', handler);
  await vi.waitFor(() => {
    expect(mocks.boss.work).toHaveBeenCalled();
  });
  const call = mocks.boss.work.mock.calls[0];
  if (!call) throw new Error('boss.work was never called');
  return call[2];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createJobQueue queue provisioning', () => {
  it('declares an explicit expiry for every job type, above pg-boss’s 900s default and below its 24h ceiling', async () => {
    const queue = createJobQueue(DSN);
    await queue.enqueue('scan', { libraryId: 'lib-1', full: true });

    for (const type of JOB_TYPES) {
      const options = JOB_QUEUE_OPTIONS[type];
      expect(options.expireInSeconds).toBeGreaterThan(PG_BOSS_DEFAULT_EXPIRE_SECONDS);
      expect(options.expireInSeconds).toBeLessThan(PG_BOSS_MAX_EXPIRE_SECONDS);
      expect(mocks.boss.createQueue).toHaveBeenCalledWith(type, options);
      // createQueue is ON CONFLICT DO NOTHING, so an install provisioned
      // before these options existed only picks them up via updateQueue.
      expect(mocks.boss.updateQueue).toHaveBeenCalledWith(type, options);
    }
  });

  it('gives every job type whose handler promise can span an entire session/library a multi-hour expiry', () => {
    const FOUR_HOURS_SECONDS = 4 * 60 * 60;
    for (const type of ['scan', 'import', 'hwprobe', 'transcode', 'subtitle-extract'] as const) {
      expect(JOB_QUEUE_OPTIONS[type].expireInSeconds).toBeGreaterThanOrEqual(FOUR_HOURS_SECONDS);
    }
    // Re-running a transcode against a live playback_sessions row is not
    // idempotent, so it opts out of pg-boss's automatic retries entirely.
    expect(JOB_QUEUE_OPTIONS.transcode.retryLimit).toBe(0);
  });
});

describe('createJobQueue job ids', () => {
  it('mints UUIDv7 job ids (CLAUDE.md invariant 5), not node crypto UUIDv4s', async () => {
    const queue = createJobQueue(DSN);
    const before = Date.now();
    const jobId = await queue.enqueue('probe', { mediaFileId: 'file-abc' });
    const after = Date.now();

    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // The v7 timestamp is the point of the invariant: decode the leading
    // 48 bits back out and check they describe now, not randomness.
    const timestampMs = Number.parseInt(jobId.slice(0, 8) + jobId.slice(9, 13), 16);
    expect(timestampMs).toBeGreaterThanOrEqual(before);
    expect(timestampMs).toBeLessThanOrEqual(after);

    expect(mocks.boss.send).toHaveBeenCalledWith('probe', { mediaFileId: 'file-abc' }, { id: jobId });
  });
});

describe('createJobQueue failure mirroring', () => {
  it('asks pg-boss for job metadata so the ledger can see retryCount/retryLimit', async () => {
    await registerHandler(async () => {});
    expect(mocks.boss.work).toHaveBeenCalledWith(
      'probe',
      expect.objectContaining({ perJobResults: true, includeMetadata: true }),
      expect.any(Function)
    );
  });

  it('records a NON-terminal retry transition when pg-boss still has attempts left', async () => {
    const batch = await registerHandler(async () => {
      throw new Error('transient probe failure');
    });

    const results = await batch([{ id: 'job-1', data: {}, retryCount: 0, retryLimit: 2 }]);

    expect(mocks.ledger.recordActive).toHaveBeenCalledWith('job-1', 1);
    expect(mocks.ledger.recordRetrying).toHaveBeenCalledWith('job-1', 'transient probe failure', 1);
    expect(mocks.ledger.recordFailed).not.toHaveBeenCalled();
    // The job is still reported failed to pg-boss — that IS its retry path.
    expect(results).toEqual([{ id: 'job-1', status: 'failed', output: { message: 'transient probe failure' } }]);
  });

  it('records a terminal failure only once pg-boss has exhausted the attempt budget', async () => {
    const batch = await registerHandler(async () => {
      throw new Error('permanent probe failure');
    });

    await batch([{ id: 'job-2', data: {}, retryCount: 2, retryLimit: 2 }]);

    expect(mocks.ledger.recordActive).toHaveBeenCalledWith('job-2', 3);
    expect(mocks.ledger.recordFailed).toHaveBeenCalledWith('job-2', 'permanent probe failure');
    expect(mocks.ledger.recordRetrying).not.toHaveBeenCalled();
  });

  it('records a terminal failure on the first throw for a queue configured with no retries', async () => {
    const batch = await registerHandler(async () => {
      throw new Error('session failure');
    });

    await batch([{ id: 'job-3', data: {}, retryCount: 0, retryLimit: 0 }]);

    expect(mocks.ledger.recordFailed).toHaveBeenCalledWith('job-3', 'session failure');
    expect(mocks.ledger.recordRetrying).not.toHaveBeenCalled();
  });
});
