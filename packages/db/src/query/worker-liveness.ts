// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/worker-liveness.ts
//
// "Is the worker actually running?", answered from PostgreSQL's own view
// of who is connected — pg_stat_activity — rather than inferred.
//
// WHY THIS EXISTS. apps/server/src/ipc/worker-liveness.ts used to answer
// that question from the `jobs` ledger: if a row had been touched in the
// last two minutes the worker was "running", otherwise "stopped". That is
// activity, not liveness, and the two are only correlated when there is
// work to do. A healthy idle worker on a fresh install reports "stopped"
// forever — confirmed live on a real macOS install, where IPC returned
// worker {state:"stopped", pid:null} while the process ran as pid 64084.
// That false negative is what sent an owner debugging session down the
// wrong path entirely.
//
// WHY pg_stat_activity RATHER THAN A HEARTBEAT FILE. The server and the
// worker are not guaranteed to share a filesystem: docker-compose.prod.yml
// runs them as separate containers. They ARE guaranteed to share a
// database — it is the only thing every deployment shape has in common.
// No migration is needed either; PostgreSQL already tracks this.
//
// WHY THE POOL BEHIND IT IS pg-boss's, NOT the worker's plain query pool.
// node-postgres closes idle clients (idleTimeoutMillis, 10s by default),
// so an idle worker's ordinary pool holds NO connection and would look
// exactly as dead as the ledger made it look. pg-boss, by contrast, polls
// for jobs on a continuous interval, so its connection is both durable and
// meaningful: it is present precisely when the worker has queue consumers
// actually registered and running.
//
// That last property is the point. v0.9.0-rc.2 shipped a worker that lost
// a startup race with first-boot PostgreSQL provisioning, failed all ten
// consumer registrations, and then printed "worker up". It was a live
// process consuming nothing. A pid check would have called it healthy;
// this signal would have called it what it was.

import { sql, type Kysely } from 'kysely';
import type { DB } from '../types.js';

/** Prefix the worker sets as its PostgreSQL `application_name`, followed
 *  by `:<osPid>:<startedAtMs>`. Parsed back apart by this module so the
 *  IPC status can report a REAL process id and start time instead of the
 *  nulls the ledger heuristic was forced to return.
 *
 *  PostgreSQL truncates application_name at 63 bytes (NAMEDATALEN-1); the
 *  full string is ~34 characters, so there is ample headroom. */
export const WORKER_APPLICATION_NAME_PREFIX = 'loombre-worker';

export interface WorkerLiveness {
  /** The worker's real OS process id, as it reported at connect time. */
  pid: number | null;
  /** When the worker process started, milliseconds since epoch. */
  startedAtMs: number | null;
  /** When PostgreSQL saw this connection open. Distinct from
   *  startedAtMs: a worker that reconnects keeps its original start time
   *  but gets a fresh backend_start. */
  connectedAtMs: number | null;
}

/**
 * Returns liveness for the worker if one is currently connected to this
 * database with queue consumers running, or null if none is.
 *
 * Reads only PostgreSQL's own session catalog — no Loombre table is
 * touched and nothing is written, so this is safe to call on a status
 * poll. Not ViewerContext-guarded, for the same reason
 * src/query/hwcaps.ts is not: it reports an instance-level operational
 * fact, never viewer-scoped catalog data.
 */
export async function getWorkerLiveness(db: Kysely<DB>): Promise<WorkerLiveness | null> {
  // `datname = current_database()` scopes this to OUR database: one
  // PostgreSQL cluster can host several Loombre instances (and the
  // embedded cluster is shared by design), and a worker attached to a
  // different database is not this instance's worker.
  //
  // Newest backend_start first: a worker that reconnected leaves the old
  // row to age out of pg_stat_activity, and the freshest connection is the
  // one that reflects the process actually running now.
  const result = await sql<{
    application_name: string;
    backend_start_ms: string | number | null;
  }>`
    select application_name,
           (extract(epoch from backend_start) * 1000)::bigint as backend_start_ms
      from pg_stat_activity
     where datname = current_database()
       and application_name like ${`${WORKER_APPLICATION_NAME_PREFIX}:%`}
     order by backend_start desc
     limit 1
  `.execute(db);

  const row = result.rows[0];
  if (!row) return null;

  // `<prefix>:<pid>:<startedAtMs>`. Parsed defensively: a truncated or
  // older-format application_name still proves a worker is CONNECTED,
  // which is the question being asked — the pid/start time are a bonus,
  // and a partial parse degrades to null rather than to "stopped".
  const parts = row.application_name.split(':');
  const pid = Number.parseInt(parts[1] ?? '', 10);
  const startedAtMs = Number.parseInt(parts[2] ?? '', 10);
  const connectedAtMs = row.backend_start_ms === null ? null : Number(row.backend_start_ms);

  return {
    pid: Number.isFinite(pid) ? pid : null,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    connectedAtMs: Number.isFinite(connectedAtMs) ? connectedAtMs : null,
  };
}

/** Builds the `application_name` the worker connects with. Lives here, next
 *  to the parser, so the two halves of this contract cannot drift apart —
 *  the worker imports it rather than formatting the string itself. */
export function workerApplicationName(pid: number, startedAtMs: number): string {
  return `${WORKER_APPLICATION_NAME_PREFIX}:${pid}:${startedAtMs}`;
}
