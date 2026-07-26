// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Filesystem watcher (docs/PLAN.md §8.1, P1.3): chokidar per library path,
 * with a polling fallback auto-enabled for network mounts (SMB/NFS are
 * first-class per docs/PLAN.md §8.1's own callout). Debounces bursts of
 * filesystem events into a single incremental-scan trigger per library.
 *
 * Network-mount heuristic (flagged decision — docs/PLAN.md only says
 * "polling fallback for network mounts", it does not prescribe how to
 * detect one): chokidar's native `fs.watch`/FSEvents backend does not
 * reliably deliver events over SMB/NFS mounts (a well-known chokidar/
 * Node limitation — network filesystems often don't support inotify/
 * FSEvents at all), so `usePolling` must be forced on for those paths.
 * This module detects a "likely network mount" with a narrow, portable
 * heuristic plus an explicit escape hatch:
 *   1. `LOOMBRE_SCAN_POLL=1` forces polling for every watched path;
 *      `LOOMBRE_SCAN_POLL=0` forces it OFF for every path (both override
 *      the heuristic entirely — the documented "env override").
 *   2. Otherwise, a path is treated as a network mount when it lives under
 *      `/Volumes/<name>` on macOS where `<name>` is NOT the boot volume
 *      (macOS mounts every non-root disk — network shares AND external
 *      USB drives alike — under /Volumes; there is no cheap, dependency-
 *      free way from Node alone to distinguish "SMB share" from "USB
 *      stick" beyond this, so both get the safer polling behavior, which
 *      is the documented "macOS /Volumes non-root disk heuristic").
 *   3. Every other path (Linux/Windows, or macOS's own boot volume)
 *      defaults to native watching (no heuristic attempts to detect
 *      Linux NFS/CIFS mount points from userland without shelling out to
 *      `mount`/`/proc/mounts`, which this module deliberately avoids —
 *      out of scope for v1; LOOMBRE_SCAN_POLL=1 is the documented escape
 *      hatch for a Linux NFS/CIFS library).
 */
import { watch as chokidarWatch, type FSWatcher } from "chokidar";

const POLL_ENV_VAR = "LOOMBRE_SCAN_POLL";
const DEBOUNCE_MS = 2000;

/** Pure — no filesystem access, just string inspection (unit-tested
 * directly in test/scan/watcher.spec.ts without needing a real mount). */
export function looksLikeNetworkMount(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  const match = /^\/Volumes\/([^/]+)/.exec(path);
  if (!match) return false;
  const volumeName = match[1]!;
  // "Macintosh HD" is the overwhelmingly common boot-volume name, but any
  // volume also reachable at "/" is the actual boot volume regardless of
  // name — that check needs a syscall (stat + compare device ids), which
  // is intentionally NOT done here (pure function, no I/O); "Macintosh HD"
  // is treated as a conservative default exclusion so a completely stock
  // Mac doesn't get spuriously polled, while every OTHER /Volumes entry
  // (network share or external disk alike) opts into polling.
  return volumeName !== "Macintosh HD";
}

export function resolveUsePolling(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  const override = env[POLL_ENV_VAR];
  if (override === "1") return true;
  if (override === "0") return false;
  return looksLikeNetworkMount(path, platform);
}

export interface WatcherHandle {
  stop(): Promise<void>;
}

export interface StartWatcherOptions {
  /** Called (debounced) after a burst of filesystem activity settles under
   *  `libraryId`'s paths. Typically enqueues an incremental 'scan' job. */
  onChange: (libraryId: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  debounceMs?: number;
}

/**
 * Starts one chokidar watcher per library, each covering all of that
 * library's `paths`. Filesystem events are debounced per-library
 * (`debounceMs`, default 2s) so a burst of writes (a multi-file copy)
 * triggers exactly one `onChange` call once things settle, not one per
 * file event.
 */
export function startWatcher(
  libraries: readonly { id: string; paths: readonly string[] }[],
  options: StartWatcherOptions
): WatcherHandle {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  const watchers: FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();

  function scheduleChange(libraryId: string): void {
    const existing = timers.get(libraryId);
    if (existing) clearTimeout(existing);
    timers.set(
      libraryId,
      setTimeout(() => {
        timers.delete(libraryId);
        void options.onChange(libraryId);
      }, debounceMs)
    );
  }

  for (const library of libraries) {
    if (library.paths.length === 0) continue;

    // usePolling is a single boolean per chokidar instance, but the
    // heuristic is per-path — a library could mix a local path and a
    // network path. If ANY of the library's paths look like a network
    // mount, the whole watcher instance polls (the safe direction to
    // round to: a spurious poll on a local path costs a little CPU, a
    // missed native event on a network path silently breaks the watch).
    const usePolling = library.paths.some((p) => resolveUsePolling(p, env, platform));

    const watcher = chokidarWatch([...library.paths], {
      usePolling,
      ignoreInitial: true,
      persistent: true,
    });
    watcher.on("all", () => scheduleChange(library.id));
    watchers.push(watcher);
  }

  return {
    async stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all(watchers.map((w) => w.close()));
    },
  };
}
