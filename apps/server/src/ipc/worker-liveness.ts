// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/worker-liveness.ts
//
// GET /ipc/v1/status's `worker: ProcessInfo` field — BEST-EFFORT, and this
// module is explicit about exactly how imprecise that best-effort is.
//
// CHOICE: jobs-ledger heuristic, not a pid file. Justification:
//   - A real pid file would need apps/worker/src/index.ts to WRITE one at
//     boot — apps/worker is outside this lane's OWNERSHIP this wave (not
//     listed; touching it risks colliding with whichever lane the
//     orchestrator assigns worker-side crash/signal-handler work to, most
//     likely alongside G1's P4.14 work, given STATE.md already assigns
//     that file's SIGTERM/SIGINT handling story to this wave's security
//     lane). Building a pid-file convention unilaterally here, without
//     that lane's coordination, risks exactly the kind of "guess baked
//     into a script conflicting with a different real decision" that
//     installers/macos/LAYOUT.md §4 explicitly warned against doing for
//     the token-permission question.
//   - packages/db/src/query/admin.ts's `listJobsAdmin` / `getJobAdmin`
//     already exist, are already exported from @loombre/db's PUBLIC barrel
//     (not @loombre/db/internal — apps/server is allowed to import this),
//     and are already used by apps/server/src/catalog/admin.controller.ts
//     for the admin jobs feed. Using them here needs ZERO changes to
//     packages/db or apps/worker — it stays entirely inside this lane's
//     ownership (apps/server/src/ipc/**) while still answering a real
//     question about the worker with real data.
//
// HONEST LIMITATION: the `jobs` table records JOB lifecycle transitions,
// not a periodic worker-process heartbeat — apps/worker/src/index.ts's
// boot-time one-shot enqueues (image-backfill / hwprobe checks) and each
// queue.work() consumer's own recordActive/recordCompleted/recordFailed
// calls are the only writes. An IDLE worker with an empty queue produces
// no ledger activity at all and is therefore indistinguishable here from a
// STOPPED worker — this function reports 'stopped' in both cases. This is
// documented, not hidden: a genuinely reliable answer needs apps/worker to
// expose a real heartbeat (a pid file or a periodic ledger touch), which is
// exactly the follow-up flagged in this lane's report. 'crashed'/'starting'/
// 'stopping' are never reported by this heuristic — those need positive
// signals (a lifecycle event or a pid file) this data source cannot
// provide; only 'running' (recent evidence of activity) or 'stopped'
// (no recent evidence) come out of it.

import type { ProcessInfo } from "@loombre/controller-ipc";

/** The subset of a JobRow this heuristic actually needs — decoupled from
 *  @loombre/db's JobRow/Kysely types so this function (and its tests) never
 *  need a database at all; ipc/index.ts adapts the real listJobsAdmin
 *  result into this shape at the one call site that has a DbProvider. */
export interface RecentJobSignal {
  status: string;
  updatedAtMs: number;
}

/** How recently a job must have been touched for the worker to be deemed
 *  'running' in the absence of a currently-'active' job. Generous on
 *  purpose — this is a coarse liveness signal for a status display, not a
 *  precision health check; a false 'running' for a couple of minutes after
 *  the worker actually stopped is a far better failure mode for a status
 *  UI than a false 'stopped' flicker between two real jobs a few seconds
 *  apart. */
export const WORKER_LIVENESS_FRESHNESS_MS = 2 * 60_000;

export function computeWorkerProcessInfo(
  recentJobs: RecentJobSignal[],
  version: string,
  nowMs: number = Date.now(),
): ProcessInfo {
  const hasActive = recentJobs.some((j) => j.status === "active");
  const mostRecentUpdatedAtMs = recentJobs.reduce((max, j) => Math.max(max, j.updatedAtMs), -Infinity);
  const recentlyTouched =
    recentJobs.length > 0 && nowMs - mostRecentUpdatedAtMs <= WORKER_LIVENESS_FRESHNESS_MS;

  const state = hasActive || recentlyTouched ? "running" : "stopped";

  return {
    state,
    // Different OS process; this listener has no way to learn its real
    // pid/start time from job-ledger rows alone (see module header).
    pid: null,
    startedAtMs: null,
    // Best-effort assumption: server and worker ship from the same build
    // and are started together by every installer lane (I1/I3/I4) — there
    // is no live "ask the worker its own version" IPC round-trip in v1.
    version,
  };
}
