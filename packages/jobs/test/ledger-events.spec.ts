// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/jobs/test/ledger-events.spec.ts
//
// P4.13 (STATE.md, deliverable D): proves job.updated events are written
// TRANSACTIONALLY alongside every ledger status transition (queued/active/
// completed/failed), and proves the additive 'pg-upgrade' JobType +
// createLedger's package-boundary export work end to end for a caller that
// never touches createJobQueue()/pg-boss at all (packages/provisioning-pg's
// future boot-time use case — STATE.md Phase 4 Open item "Upgrade
// jobs-ledger follow-up (lane B)"). Self-sufficient like queue.spec.ts, but
// via its own ensureTestDatabase()-isolated database (packages/db/src/
// testing.ts's own header names this exact hazard: two live-DB spec files
// in the SAME package, each running `migrate.mjs reset` in beforeAll, race
// each other's DROP SCHEMA/replay when vitest runs them in parallel worker
// processes — observed directly while adding this second file) — reads
// back through a plain @loombre/db handle (never pg-boss's own `pgboss`
// schema).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, ensureTestDatabase } from '@loombre/db';
import { createLedger, type Ledger } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../db');

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

let ledger: Ledger;
let readDb: ReturnType<typeof createDb>;

interface JobUpdatedEventRow {
  id: string;
  type: string;
  ts_ms: number;
  payload: {
    jobId: string;
    jobType: string;
    status: string;
    errorMessage: string | null;
    updatedAtMs: number;
    progress?: unknown;
  };
}

async function jobUpdatedEventsFor(jobId: string): Promise<JobUpdatedEventRow[]> {
  // ORDER BY seq alone — NOT `id`, and NOT `ts_ms` even as a leading
  // sort key. `id` is a UUIDv7 (loombre_uuidv7(), packages/db/schema.sql):
  // its leading 48 bits are clock_timestamp() truncated to the
  // millisecond, but every remaining bit is plain `random()` with no
  // monotonic-counter fallback for same-millisecond collisions. Two events
  // written within the same Postgres clock millisecond (routine under
  // concurrent load) therefore tie on the ordered prefix and fall back to
  // comparing random tail bits — a coin flip uncorrelated with actual
  // write order (observed once as this exact spec flaking: events read
  // back ['queued','failed','active']). `ts_ms` is application-supplied
  // (Date.now()) and therefore not even monotonic on its own host: an NTP
  // step can walk it backwards mid-run, so ordering BY ts_ms first (even
  // with `seq` as a tie-break) reintroduces a version of the same hazard
  // `seq` exists to remove. `seq` (migrations/0039_events_seq.sql) is a
  // Postgres identity-sequence column: nextval() hands out strictly
  // increasing values in the exact order it is invoked, with no possible
  // tie and no dependence on any clock — it is the guaranteed total order
  // over insertion attempts by itself, so it is used alone.
  const rows = await readDb
    .selectFrom('events')
    .selectAll()
    .where('type', '=', 'job.updated')
    .orderBy('seq', 'asc')
    .execute();
  return (rows as unknown as JobUpdatedEventRow[]).filter((r) => r.payload.jobId === jobId);
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, 'jobs_ledger_events_test');
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset'], databaseUrl);
  ledger = createLedger(databaseUrl);
  readDb = createDb(databaseUrl);
}, 30_000);

afterAll(async () => {
  await ledger?.destroy();
  await readDb.destroy();
});

describe('createLedger job.updated emission (P4.13)', () => {
  it('recordQueued -> recordActive -> recordCompleted each write exactly one job.updated event, transactionally with the ledger row', async () => {
    const jobId = '018f6f1e-0000-7000-8000-0000000000a1';

    await ledger.recordQueued(jobId, 'scan', { subjectItemId: null });
    let events = await jobUpdatedEventsFor(jobId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ jobId, jobType: 'scan', status: 'queued', errorMessage: null });
    // Deliberately omitted (module header: the ledger knows nothing about
    // per-tick progress) rather than a faked null/placeholder value.
    expect(events[0]!.payload).not.toHaveProperty('progress');

    await ledger.recordActive(jobId);
    events = await jobUpdatedEventsFor(jobId);
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toMatchObject({ jobId, jobType: 'scan', status: 'active', errorMessage: null });

    await ledger.recordCompleted(jobId);
    events = await jobUpdatedEventsFor(jobId);
    expect(events).toHaveLength(3);
    expect(events[2]!.payload).toMatchObject({ jobId, jobType: 'scan', status: 'completed', errorMessage: null });

    // Envelope shape sanity: id/tsMs equivalents are real outbox columns.
    expect(typeof events[0]!.id).toBe('string');
    expect(events[0]!.ts_ms).toBeGreaterThan(0);
  });

  it('recordFailed writes a job.updated event carrying the error message, jobType recovered from the ledger row (not re-passed by the caller)', async () => {
    const jobId = '018f6f1e-0000-7000-8000-0000000000a2';

    await ledger.recordQueued(jobId, 'probe', { subjectItemId: null });
    await ledger.recordActive(jobId);
    await ledger.recordFailed(jobId, 'deliberate test failure');

    const events = await jobUpdatedEventsFor(jobId);
    expect(events).toHaveLength(3);
    expect(events[2]!.payload).toMatchObject({
      jobId,
      jobType: 'probe',
      status: 'failed',
      errorMessage: 'deliberate test failure',
    });
  });

  it("'pg-upgrade' additive JobType: createLedger writes a full queued->active->completed audit trail with no pg-boss/queue involvement at all", async () => {
    const jobId = '018f6f1e-0000-7000-8000-0000000000a3';

    // No createJobQueue()/enqueue()/work() anywhere in this test — exactly
    // the boot-time provisioning-pg use case (types.ts's PgUpgradeJobPayload
    // doc comment): a ledger row written entirely after the fact.
    await ledger.recordQueued(jobId, 'pg-upgrade', { subjectItemId: null });
    await ledger.recordActive(jobId);
    await ledger.recordCompleted(jobId);

    const jobRow = await readDb.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(jobRow.type).toBe('pg-upgrade');
    expect(jobRow.status).toBe('completed');
    expect(jobRow.started_at_ms).not.toBeNull();
    expect(jobRow.finished_at_ms).not.toBeNull();

    const events = await jobUpdatedEventsFor(jobId);
    expect(events.map((e) => e.payload.status)).toEqual(['queued', 'active', 'completed']);
    expect(events.every((e) => e.payload.jobType === 'pg-upgrade')).toBe(true);
  });

  it("'pg-upgrade' can also record a failed upgrade attempt", async () => {
    const jobId = '018f6f1e-0000-7000-8000-0000000000a4';

    await ledger.recordQueued(jobId, 'pg-upgrade', { subjectItemId: null });
    await ledger.recordActive(jobId);
    await ledger.recordFailed(jobId, 'verify step: server_version mismatch');

    const jobRow = await readDb.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(jobRow.status).toBe('failed');
    expect(jobRow.last_error).toBe('verify step: server_version mismatch');

    const events = await jobUpdatedEventsFor(jobId);
    expect(events.map((e) => e.payload.status)).toEqual(['queued', 'active', 'failed']);
    expect(events[2]!.payload.errorMessage).toBe('verify step: server_version mismatch');
  });

  it('read order does not depend on job.updated ids being insertion-ordered (root cause of the observed ms-tie flake, migrations/0039_events_seq.sql)', async () => {
    const jobId = '018f6f1e-0000-7000-8000-0000000000a5';
    const tsMs = Date.now();

    // Deterministic reproduction of the flake observed once under a
    // parallel gate:full run (events read back ['queued','failed','active']
    // instead of ['queued','active','failed']): inserted directly (bypassing
    // the ledger and loombre_uuidv7()) with explicit ids chosen so
    // lexicographic (`ORDER BY id ASC`) order is the REVERSE of physical
    // insertion order for the active/failed pair. This is exactly the shape
    // a same-millisecond loombre_uuidv7() collision can produce under load
    // (its non-timestamp bits are plain `random()`, uncorrelated with
    // insertion order — see migrations/0039_events_seq.sql's header) but
    // forced here instead of raced, so the test cannot flake.
    async function insertRaw(id: string, status: string, errorMessage: string | null) {
      await readDb
        .insertInto('events')
        .values({
          id,
          type: 'job.updated',
          ts_ms: tsMs,
          actor_user_id: null,
          payload: { jobId, jobType: 'pg-upgrade', status, errorMessage, updatedAtMs: tsMs },
        })
        .execute();
    }

    await insertRaw('018f6f1e-0000-7000-8000-0000000000b0', 'queued', null);
    // Inserted SECOND (i.e. first in physical/seq order among this pair)
    // but given the LEXICOGRAPHICALLY GREATER id.
    await insertRaw('ffffffff-ffff-7fff-8fff-ffffffffffff', 'active', null);
    // Inserted THIRD but given the LEXICOGRAPHICALLY SMALLER id — a plain
    // `ORDER BY id ASC` would sort this ahead of 'active' despite being
    // written after it, which is semantically impossible (a job cannot
    // fail before it went active).
    await insertRaw('00000000-0000-7000-8000-000000000001', 'failed', 'forced tie-break probe');

    const events = await jobUpdatedEventsFor(jobId);
    expect(events.map((e) => e.payload.status)).toEqual(['queued', 'active', 'failed']);
  });
});
