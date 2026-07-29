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

import { PgBoss } from 'pg-boss';
import { uuidv7 } from './ids.js';
import { createLedger, type Ledger } from './ledger.js';
import { JOB_QUEUE_OPTIONS, JOB_TYPES, type JobPayloads, type JobType } from './types.js';

export interface EnqueueOptions {
  priority?: number;
  subjectItemId?: string | null;
}

export interface WorkOptions<T extends JobType = JobType> {
  /** Number of jobs this node processes concurrently for this queue.
   *  @default 1 */
  concurrency?: number;
  /**
   * Owner ledger L1, adjudication A-3: an optional terminal-failure hook.
   * Invoked ONLY when the job has exhausted its retries (`willRetry ===
   * false` below) — never for a still-retryable failure — and only AFTER
   * the ledger's recordFailed write has been attempted, so the jobs-ledger
   * row remains the authoritative record of what happened regardless of
   * what this hook does. Best-effort: wrapped in its own try/catch inside
   * work()'s batch handler below, so a throwing/rejecting hook is logged
   * locally and never propagates — a broken hook can never break the
   * ledger transition it is observing, nor the batch result reported back
   * to pg-boss.
   *
   * Exists so a consumer (apps/worker/src/probe/terminal-failure-hook.ts
   * is the first) can turn a terminal job failure into something visible
   * beyond the generic jobs ledger's free-text last_error, without this
   * package taking on any opinion about WHAT that visibility looks like.
   */
  onTerminalFailure?: (payload: JobPayloads[T], error: unknown) => void | Promise<void>;
}

export type JobHandler<T extends JobType> = (
  payload: JobPayloads[T],
  meta: { jobId: string }
) => Promise<void>;

export interface JobQueue {
  enqueue<T extends JobType>(type: T, payload: JobPayloads[T], opts?: EnqueueOptions): Promise<string>;
  work<T extends JobType>(type: T, handler: JobHandler<T>, opts?: WorkOptions<T>): void;
  /**
   * Resolves once every work() registration made so far has actually
   * landed; rejects with the first failure otherwise.
   *
   * work() is deliberately fire-and-forget (it is called ten times at
   * module scope in apps/worker), which meant a caller had NO WAY to learn
   * that registration failed. v0.9.0-rc.2 on a real Windows install:
   * every consumer registration failed with ECONNREFUSED because the
   * worker raced the server's first-boot PostgreSQL provisioning by ~8
   * seconds, each failure was logged and swallowed, and the worker then
   * printed "worker up — pg-boss consumers registered: scan, probe, …"
   * and sat there as a live process with ZERO consumers. Nothing was
   * queued or run again until someone restarted it by hand.
   *
   * Callers should await this before claiming to be up.
   */
  ready(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateJobQueueOptions {
  /**
   * How long ensureStarted() keeps retrying pg-boss's start before giving
   * up. The embedded-PostgreSQL installers start the worker and the server
   * concurrently, and the server has to run initdb + start the cluster
   * before anything can connect, so "the database is not up YET" is the
   * expected state on a first boot rather than an error.
   * @default 90_000
   */
  startRetryWindowMs?: number;
  /** @default 2_000 */
  startRetryIntervalMs?: number;
  /**
   * PostgreSQL `application_name` for this queue's connections.
   *
   * apps/worker sets it to `loombre-worker:<pid>:<startedAtMs>` so the
   * server can answer "is the worker running?" from pg_stat_activity
   * (packages/db/src/query/worker-liveness.ts) rather than inferring it
   * from job-ledger activity, which reports a healthy IDLE worker as
   * stopped. This pool is the right place to carry that label because
   * pg-boss polls continuously — the connection persists while an idle
   * ordinary pool would have closed its clients.
   */
  applicationName?: string;
}

export function createJobQueue(connectionString: string, options: CreateJobQueueOptions = {}): JobQueue {
  // application_name goes through PgBoss's OBJECT config rather than being
  // spliced into the URL as a query parameter: the connection string may
  // already carry parameters (sslmode et al.), and hand-editing a URL that
  // also contains a generated password is a needless place to introduce an
  // escaping bug. pg-boss forwards unknown options to node-postgres, which
  // treats application_name as a first-class connection parameter.
  const boss = options.applicationName
    ? new PgBoss({ connectionString, application_name: options.applicationName })
    : new PgBoss(connectionString);
  const ledger: Ledger = createLedger(connectionString);
  const startRetryWindowMs = options.startRetryWindowMs ?? 90_000;
  const startRetryIntervalMs = options.startRetryIntervalMs ?? 2_000;

  boss.on('error', (err: unknown) => {
    console.error('[@loombre/jobs] pg-boss error:', err);
  });

  /** Every work() registration, so ready() can report whether they landed.
   *  Typed as unknown because boss.work() resolves with its own work id,
   *  which nothing here needs — only whether it settled. */
  const registrations: Promise<unknown>[] = [];

  let startPromise: Promise<void> | null = null;
  function ensureStarted(): Promise<void> {
    startPromise ??= (async () => {
      // RETRY, rather than fail on the first refused connection. Every
      // installer starts the worker alongside the server, and on a first
      // boot the server still has to run initdb and bring the cluster up —
      // so ECONNREFUSED here is "not yet", not "broken". Waiting is what
      // lets the very first install register its consumers successfully
      // instead of depending on a crash-and-restart to paper over the race.
      const deadline = Date.now() + startRetryWindowMs;
      for (;;) {
        try {
          await boss.start();
          break;
        } catch (err) {
          if (Date.now() + startRetryIntervalMs >= deadline) throw err;
          await new Promise((resolve) => setTimeout(resolve, startRetryIntervalMs));
        }
      }
      for (const type of JOB_TYPES) {
        const options = JOB_QUEUE_OPTIONS[type];
        // createQueue's INSERT is ON CONFLICT DO NOTHING, so on any install
        // whose `pgboss.queue` rows already exist it silently keeps whatever
        // options they were first provisioned with. updateQueue is what makes
        // JOB_QUEUE_OPTIONS actually authoritative after a version bump.
        await boss.createQueue(type, options);
        await boss.updateQueue(type, options);
      }
    })().catch((err: unknown) => {
      // DO NOT keep a rejected promise cached. `startPromise ??= …` alone
      // meant the FIRST failure was memoized forever: on the rc.2 Windows
      // install every later enqueue re-awaited a rejection produced seconds
      // earlier and reported ECONNREFUSED long after PostgreSQL was
      // accepting connections (the giveaway was a PgBoss.start stack on a
      // call that never tried to connect). Clearing it lets a subsequent
      // call genuinely retry.
      //
      // Contrast packages/secrets/src/native-keyring.ts, which deliberately
      // DOES cache its rejection: a missing system DLL cannot appear later
      // in a process's lifetime, whereas a database that is still starting
      // very much can.
      startPromise = null;
      throw err;
    });
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
      const jobId = uuidv7();
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
      const registration = ensureStarted()
        .then(() =>
          boss.work(
            type,
            // includeMetadata: the ledger has to mirror pg-boss's OWN retry
            // state (retryCount/retryLimit) rather than calling every throw
            // terminal — see the catch block below.
            { localConcurrency: opts.concurrency ?? 1, perJobResults: true, includeMetadata: true },
            async (jobs) => {
              const results: { id: string; status: 'completed' | 'failed'; output?: unknown }[] = [];
              for (const job of jobs) {
                // pg-boss increments retry_count as it fetches, so retryCount
                // is 0 on the first attempt: attempts is 1-based.
                const attempts = job.retryCount + 1;
                // recordActive is INSIDE the try: a missing ledger row (e.g.
                // a crash between boss.send and recordQueued left a job with
                // no ledger row) must not throw out of the batch handler —
                // that would abort every remaining job in this fetched batch
                // and leave them dequeued-but-never-run. Ledger bookkeeping
                // failures degrade to a failed-status result for that one
                // job, never a lost batch.
                try {
                  await ledger.recordActive(job.id, attempts);
                  await handler(job.data as JobPayloads[typeof type], { jobId: job.id });
                  await ledger.recordCompleted(job.id);
                  results.push({ id: job.id, status: 'completed' });
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  // Returning 'failed' here is pg-boss's RETRY path, not a
                  // terminal one — it re-inserts the job in state 'retry'
                  // whenever retry_count < retry_limit. Writing a terminal
                  // ledger row on the first throw would therefore publish a
                  // failure the queue has not actually reached: the setup
                  // wizard's restore step stops polling on any terminal
                  // status and would show a permanent failure banner for a
                  // job that goes on to succeed.
                  const willRetry = job.retryCount < job.retryLimit;
                  const recorded = willRetry
                    ? ledger.recordRetrying(job.id, message, attempts)
                    : ledger.recordFailed(job.id, message);
                  await recorded.catch((ledgerErr: unknown) => {
                    console.error(`[@loombre/jobs] ledger transition failed for job ${job.id}:`, ledgerErr);
                  });
                  // A-3: fires ONLY once retries are exhausted, and only
                  // AFTER the ledger write above — see WorkOptions.
                  // onTerminalFailure's doc comment for the full rationale.
                  if (!willRetry && opts.onTerminalFailure) {
                    try {
                      await opts.onTerminalFailure(job.data as JobPayloads[typeof type], err);
                    } catch (hookErr) {
                      console.error(`[@loombre/jobs] onTerminalFailure hook threw for job ${job.id} (${type}):`, hookErr);
                    }
                  }
                  results.push({ id: job.id, status: 'failed', output: { message } });
                }
              }
              return results;
            }
          )
        )
        .catch((err: unknown) => {
          console.error(`[@loombre/jobs] failed to register work handler for "${type}":`, err);
          // Rethrow into the tracked promise below so ready() can surface
          // it. The console.error stays because it names the specific queue
          // that failed, which the aggregate ready() rejection cannot.
          throw err;
        });
      // work() still returns void (ten call sites at module scope depend on
      // that), but the failure is no longer unobservable.
      registrations.push(registration);
      // A caller that never calls ready() must not get an unhandled
      // rejection — the .catch above RETHROWS, so `registration` is a
      // rejected promise with no consumer until ready() awaits it. This
      // separate no-op branch marks it handled without swallowing the
      // rejection that ready() still sees.
      void registration.catch(() => undefined);
    },

    async ready() {
      await ensureStarted();
      await Promise.all(registrations);
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
