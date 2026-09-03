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
import { access } from "node:fs/promises";
import { dirname } from "node:path";

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
  /** Libraries for which at least one path passed the boot probe and is
   *  actually being watched — diagnostics for logs and tests. */
  readonly watchedLibraryIds: readonly string[];
}

/** How long a single library path may take to answer the boot-time
 *  access probe before it is skipped. Generous for a slow network mount,
 *  far below what a frozen boot costs. */
export const PATH_PROBE_TIMEOUT_MS = 2_000;

export interface StartWatcherOptions {
  /** Called (debounced) after a burst of filesystem activity settles under
   *  `libraryId`'s paths. Typically enqueues an incremental 'scan' job. */
  onChange: (libraryId: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  debounceMs?: number;
  /** Boot-time reachability probe for a library path — resolves when the
   *  path is accessible, rejects when it is missing or denied. Injectable
   *  for tests; defaults to fs.promises.access, which runs in the libuv
   *  threadpool and therefore cannot freeze the event loop even when the
   *  operating system blocks the call on a consent prompt. */
  probePath?: (path: string) => Promise<void>;
  probeTimeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Starts one chokidar watcher per library, each covering all of that
 * library's `paths`. Filesystem events are debounced per-library
 * (`debounceMs`, default 2s) so a burst of writes (a multi-file copy)
 * triggers exactly one `onChange` call once things settle, not one per
 * file event.
 *
 * BOOT GUARD — a watcher must never freeze the worker. On macOS the
 * native `fs.watch` backend opens the watched directory synchronously
 * inside libuv (`uv_fs_event_start` -> `open()`), and opening a
 * privacy-protected folder (Desktop/Documents/Downloads) without consent
 * blocks the MAIN THREAD on the TCC prompt — indefinitely with nobody at
 * the keyboard. chokidar watches the nearest EXISTING ancestor of a
 * missing path, so a library whose folder has vanished from under such a
 * parent hits the same wall. Observed live (2026-09-03): every pg-boss
 * poller went silent after its first fetch and no probe/transcode job
 * ever ran. So every path is probed asynchronously with a bounded timeout
 * first (`probePath`, threadpool-backed); a path that is missing, denied
 * or silent is logged and skipped, and chokidar only ever sees paths that
 * answered. chokidar's runtime 'error' events are observed too, so an
 * unlistened emit can never become a process-fatal unhandled rejection.
 */
export async function startWatcher(
  libraries: readonly { id: string; paths: readonly string[] }[],
  options: StartWatcherOptions
): Promise<WatcherHandle> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const probePath = options.probePath ?? ((path: string) => access(path));
  const probeTimeoutMs = options.probeTimeoutMs ?? PATH_PROBE_TIMEOUT_MS;
  const log = options.log ?? ((message: string) => console.error(message));
  const watchedLibraryIds: string[] = [];

  /** A path is watchable when it answers, OR when it is merely missing but
   *  its parent answers — chokidar then watches the parent for the path's
   *  creation, which is how a Stash `-wal` file that does not exist yet
   *  (and a library folder mounted later) still gets picked up. Only a
   *  blocked/denied/silent probe is skipped. */
  async function watchable(path: string): Promise<{ ok: true } | { ok: false; why: string }> {
    const direct = await reachable(path);
    if (direct.ok || !/ENOENT/.test(direct.why)) return direct;
    const parent = await reachable(dirname(path));
    return parent.ok ? { ok: true } : { ok: false, why: `${direct.why}; parent ${dirname(path)}: ${parent.why}` };
  }

  async function reachable(path: string): Promise<{ ok: true } | { ok: false; why: string }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ ok: false; why: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, why: `no answer within ${probeTimeoutMs} ms (blocked on a permission prompt?)` }), probeTimeoutMs);
    });
    try {
      return await Promise.race([
        probePath(path).then(
          () => ({ ok: true }) as const,
          (err: unknown) => ({ ok: false, why: err instanceof Error ? err.message : String(err) }) as const,
        ),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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

    const watchablePaths: string[] = [];
    for (const path of library.paths) {
      const result = await watchable(path);
      if (result.ok) {
        watchablePaths.push(path);
      } else {
        log(`worker: not watching library ${library.id} path ${path} — ${result.why}; scans still run, the watch resumes on the next worker start once the path is reachable`);
      }
    }
    if (watchablePaths.length === 0) continue;

    // usePolling is a single boolean per chokidar instance, but the
    // heuristic is per-path — a library could mix a local path and a
    // network path. If ANY of the library's paths look like a network
    // mount, the whole watcher instance polls (the safe direction to
    // round to: a spurious poll on a local path costs a little CPU, a
    // missed native event on a network path silently breaks the watch).
    const usePolling = watchablePaths.some((p) => resolveUsePolling(p, env, platform));

    const watcher = chokidarWatch(watchablePaths, {
      usePolling,
      ignoreInitial: true,
      persistent: true,
    });
    watcher.on("all", () => scheduleChange(library.id));
    // An EventEmitter "error" with no listener THROWS inside chokidar's
    // async handlers — i.e. an unhandled rejection, which the worker's
    // crash handler treats as fatal. A watch failure is not fatal to a
    // worker; the scanner never depended on the watcher in the first place.
    watcher.on("error", (err: unknown) => {
      log(`worker: library watcher error for library ${library.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
    watchers.push(watcher);
    watchedLibraryIds.push(library.id);
  }

  return {
    watchedLibraryIds,
    async stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all(watchers.map((w) => w.close()));
    },
  };
}
