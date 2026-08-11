// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The worker process's registry of LIVE ffmpeg runs (an upstream media server-study
 * implementation run, item C1).
 *
 * WHY THIS EXISTS. process.ts spawns every ffmpeg with `detached: true` on
 * POSIX — deliberately, so suspend/resume/terminate can signal the whole
 * process group (some hwaccel backends spawn helpers). The cost of that
 * choice is that the child sits in its OWN process group and therefore does
 * NOT die when the worker does: before this module, apps/worker/src/
 * index.ts's shutdown() stopped the queue, the hash pool, the watchers, the
 * plugin-delivery loop and the database handle, and left every in-flight
 * encoder running at full rate with no supervisor left alive to throttle,
 * seek, or reap it. An ordinary restart or deploy was enough to produce
 * one; on Tier-0 hardware (N100/4GB, docs/PLAN.md §9) two of them is the
 * whole machine.
 *
 * SHAPE. Module-level state, on purpose: there is exactly one worker
 * process and exactly one shutdown path, and the alternative (threading a
 * registry handle from index.ts through consumer.ts into runner.ts) would
 * add a parameter to the seam contract documented in ./index.ts for no
 * behavioral gain. runner.ts registers each run as it spawns it and
 * unregisters it the moment that process exits (or is replaced by a
 * seek-restart); index.ts's shutdown() calls terminateAllTranscodeRuns().
 *
 * The registered value is deliberately the narrow `TerminableRun` and not
 * `FfmpegRunHandle`: everything this module needs is the idempotent
 * `terminate()` (SIGCONT -> SIGTERM -> SIGKILL after a short graceful
 * window, process.ts) — and SIGCONT-before-SIGTERM is exactly why a
 * throttle-SUSPENDED run still dies promptly here rather than sitting on a
 * pending SIGTERM for the whole graceful window.
 */

export interface TerminableRun {
  /** Idempotent; resolves once the process has actually exited
   *  (process.ts's FfmpegRunHandle.terminate). */
  terminate(): Promise<void>;
}

const liveRuns = new Set<TerminableRun>();

/**
 * Registers a live run. Returns its unregister function, which is
 * idempotent — runner.ts calls it both from the run's own exit handler and
 * from teardown, and either order must be safe.
 */
export function registerTranscodeRun(run: TerminableRun): () => void {
  liveRuns.add(run);
  return () => {
    liveRuns.delete(run);
  };
}

/** How many ffmpeg runs this worker process currently supervises. */
export function activeTranscodeRunCount(): number {
  return liveRuns.size;
}

/**
 * Terminates every in-flight run and empties the registry. Returns how
 * many runs were terminated.
 *
 * Resolves only once every child has actually exited, so a caller that
 * awaits it before exiting the process has a real no-orphan guarantee
 * rather than a best-effort signal. A run whose terminate() rejects (a
 * pid that vanished mid-kill, EPERM) never prevents the others from being
 * terminated — allSettled, not all: a shutdown that gives up halfway is
 * exactly the orphan-producing behavior this module exists to remove.
 */
export async function terminateAllTranscodeRuns(): Promise<number> {
  const runs = [...liveRuns];
  liveRuns.clear();
  await Promise.allSettled(runs.map((run) => run.terminate()));
  return runs.length;
}
