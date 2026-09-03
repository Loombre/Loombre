// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/boot-order.ts
//
// The worker's boot-ordering law (SPF-14): job consumers are registered and
// CONFIRMED (queue.ready()) before any filesystem watcher starts, and the
// watchers are never awaited on the boot path. A watcher that never settles
// — a native fs.watch open blocked inside the OS, a probe that hangs, a
// thread that never acknowledges — therefore cannot delay or prevent job
// consumption by even one tick. This module exists so that ordering is a
// tested function rather than a convention in index.ts's main().
//
// The consumer half keeps its rc.2 posture: a failed registration REJECTS
// and the caller's main() exits non-zero — every installer supervises the
// process and restarts it once the database is genuinely reachable; a
// silent no-op worker is far worse than a loud restart. The watcher half is
// best-effort: a rejection or a synchronous throw is logged, never
// propagated.

export interface ConsumersFirstBootDeps {
  /** queue.ready() — resolves once every consumer registration landed,
   *  rejects with the first failure otherwise. */
  ready: () => Promise<void>;
  /** Starts the filesystem watchers (library + Stash). Called strictly
   *  after ready() resolved; its promise is observed but never awaited by
   *  the boot path. */
  startWatchers: () => Promise<void>;
  log?: (message: string) => void;
}

export interface ConsumersFirstBootResult {
  /** Settles when startWatchers settled — resolved either way (a failure is
   *  logged). Never awaited on the boot path; exposed for tests and for a
   *  caller that wants to report on it with its own bound. */
  watchers: Promise<void>;
}

export async function bootConsumersBeforeWatchers(deps: ConsumersFirstBootDeps): Promise<ConsumersFirstBootResult> {
  const log = deps.log ?? ((message: string) => console.error(message));
  await deps.ready();

  let watchers: Promise<void>;
  try {
    watchers = Promise.resolve(deps.startWatchers());
  } catch (err) {
    watchers = Promise.reject(err);
  }
  return {
    watchers: watchers.catch((err: unknown) => {
      log(`worker: filesystem watchers failed to start — scans still run, watch-triggered rescans are off until the next worker start: ${err instanceof Error ? err.message : String(err)}`);
    }),
  };
}
