// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/schedule-loop.ts
//
// Trigger (b): the periodic schedule (STATE.md S8/deliverable 7). No cron
// machinery exists anywhere in this repo (K-notes "ground truth worth
// repeating"); this lane's choice is a boot-timer + settings-registry key
// (packages/shared/src/settings-registry.ts's `stash.sync.scheduleIntervalMs`,
// default 0 = OFF) rather than extending pg-boss's `.schedule()` API through
// packages/jobs' shared JobQueue abstraction — that package is the
// foundation every OTHER job type (and every other lane) depends on, and
// adding `.schedule()` support to it for this ONE feature's periodic-sync
// need is a bigger blast radius than this lane's scope justifies. The
// precedent this mirrors instead already lives in this exact worker
// process: apps/worker/src/plugin-delivery/delivery-loop.ts's LPP v1
// outbox-fanout loop — "own interval, own handle, own clean shutdown", no
// pg-boss involvement at all, started once in apps/worker/src/index.ts's
// main() and stopped in its shutdown().
//
// Re-reads stash.sync.scheduleIntervalMs FRESH on every tick (via
// loadWorkerEffectiveSettings, the same per-tick-boundary re-resolution
// convention scan/probe/transcode all use — apps/worker/src/settings/
// effective-settings.ts's own header) so an admin raising/lowering/
// disabling the interval applies from the NEXT tick, no worker restart.
//
// Per-tick algorithm: 0 (or any invalid value) means OFF — the loop does
// nothing this tick. Otherwise, for every ENABLED library_stash_connection
// whose most recent stash_sync_reports row (if any) started more than
// intervalMs ago, enqueue ONE incremental stash-sync — deliberately just
// the FIRST due library found, not every due library at once: 'stash-sync'
// registers at queue concurrency:1 (deliverable 1), so stacking N
// simultaneous enqueues would only sit in pg-boss's queued state anyway;
// the next tick naturally picks up whichever library is still due once the
// current run finishes. hasQueuedOrActiveJobOfType is the same idempotent-
// enqueue guard apps/worker/src/index.ts's image-backfill/hwprobe boot
// checks already use (P2.11 precedent) — a schedule tick landing while a
// sync (of ANY origin: button, watcher, or a prior tick) is already
// running never stacks a second one.

import type { DbOrTx } from '@loombre/db/internal';
import { hasQueuedOrActiveJobOfType } from '@loombre/db/internal';
import { listLibraries } from '@loombre/db/internal';
import { getLibraryStashConnection, getLatestStashSyncReport } from '@loombre/db';
import { loadWorkerEffectiveSettings, getWorkerSettingValue } from '../settings/effective-settings.js';

export interface StashScheduleLoopDeps {
  db: DbOrTx;
  enqueueIncrementalSync: (libraryId: string) => Promise<unknown>;
  /** Real wall-clock tick cadence — how often the loop even CHECKS
   *  whether anything is due (independent of the configurable
   *  scheduleIntervalMs, which decides whether a check finds anything
   *  due). Defaults to 5 minutes; tests override this. */
  tickIntervalMs?: number;
  clock?: () => number;
}

export interface StashScheduleLoopHandle {
  stop(): Promise<void>;
}

const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;

/** One tick's worth of logic, exported separately so tests can call it
 *  directly without waiting on a real setInterval. */
export async function runStashScheduleTick(deps: StashScheduleLoopDeps): Promise<void> {
  const clock = deps.clock ?? Date.now;
  const settings = await loadWorkerEffectiveSettings(deps.db);
  const intervalMs = getWorkerSettingValue(settings, 'stash.sync.scheduleIntervalMs', 0);
  if (!(intervalMs > 0)) return; // OFF (default) — the documented posture, not a bug.

  if (await hasQueuedOrActiveJobOfType(deps.db, 'stash-sync')) return;

  const libraries = await listLibraries(deps.db);
  const now = clock();

  for (const library of libraries) {
    const connection = await getLibraryStashConnection(deps.db, library.id);
    if (!connection || !connection.enabled) continue;

    const latestReport = await getLatestStashSyncReport(deps.db, library.id);
    const due = !latestReport || now - latestReport.started_at_ms >= intervalMs;
    if (!due) continue;

    await deps.enqueueIncrementalSync(library.id);
    return; // one enqueue per tick — see this file's header.
  }
}

/** Starts the boot-timer loop — mirrors startPluginDeliveryLoop's own
 *  "own interval, own handle, own clean shutdown" shape exactly. Errors
 *  from a single tick are logged and swallowed (never crash the worker
 *  over a scheduling hiccup — the next tick simply tries again). */
export function startStashScheduleLoop(deps: StashScheduleLoopDeps): StashScheduleLoopHandle {
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    runStashScheduleTick(deps).catch((err: unknown) => {
      console.error('worker: stash schedule-loop tick failed:', err);
    });
  }, tickIntervalMs);
  // Never keeps the process alive on its own — apps/worker/src/index.ts's
  // main keepAlive interval already does that job; this timer should not
  // ALSO hold the event loop open past a clean shutdown.
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
