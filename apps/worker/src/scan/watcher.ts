// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Filesystem watcher (docs/PLAN.md §8.1, P1.3): chokidar per library path,
 * with a polling fallback auto-enabled for network mounts (SMB/NFS are
 * first-class per docs/PLAN.md §8.1's own callout) and for macOS
 * privacy-protected folders. Debounces bursts of filesystem events into a
 * single incremental-scan trigger per library.
 *
 * THIS MODULE IS THE MAIN-THREAD HALF. It decides WHAT to watch (the boot
 * probe, SPF-11) and HOW (native vs polling), then hands that plan to a
 * worker_thread (./watcher-thread.ts), which is the only place chokidar —
 * and therefore Node's `fs.watch` — ever runs (SPF-14).
 *
 * Why a thread: on macOS `fs.watch` opens the watched directory
 * SYNCHRONOUSLY inside libuv (`uv_fs_event_start` → `open()`), and that
 * open can block indefinitely — the TCC consent prompt for a privacy-
 * protected folder with nobody at the keyboard, or an FSEvents quirk of a
 * sandboxed filesystem (both observed live, 2026-09-03). Whatever thread
 * makes that call is wedged until the OS lets go. With chokidar on the main
 * thread that was the whole worker: every pg-boss poller went silent and no
 * scan/probe/transcode job ever ran. In its own thread the same block costs
 * that thread's watch events and nothing the main thread does: job
 * consumption, shutdown and crash handling all keep running. A metadata
 * probe (`access()`) cannot predict what an FSEvents open will do, which is
 * why the SPF-11 probe below is necessary but not sufficient, and why it is
 * kept verbatim in behaviour.
 *
 * What the thread does NOT isolate — stated plainly so nobody relies on it:
 * libuv has ONE threadpool per process, shared by the main thread and every
 * worker_thread. Async fs work the watcher issues (chokidar's initial
 * listing of a PRESENT folder, polling's stat calls) runs in that pool, and
 * a consent prompt that holds such a call parks one pool slot (of
 * UV_THREADPOOL_SIZE, default 4) until the prompt is answered — slots the
 * worker's jobs share for their own fs/dns/crypto work. The SPF-11 probe
 * has the same property (a timed-out access() leaves its slot parked). One
 * such library costs one slot; the wedge this module fixes cost the whole
 * process. True isolation (a child process with its own loop AND pool) is
 * recorded as an open item, not done here.
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
 *      the heuristics entirely — the documented "env override").
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
 *
 * macOS privacy-protected roots (SPF-14): a path at or under a personal
 * home's Desktop, Documents or Downloads, iCloud Drive (~/Library/Mobile
 * Documents) or a Photos library package (*.photoslibrary) defaults to
 * polling on darwin. Polling watches with `fs.watchFile` (stat) and never
 * performs the FSEvents open at all, so the one call the OS is known to
 * hold on the consent prompt is simply not made — for the configured path
 * and for the nearest EXISTING ancestor chokidar watches when the path is
 * missing (that ancestor lies inside the same protected root by
 * construction). The decision is taken on the RESOLVED REAL path (`..`
 * segments, relative paths and symlinks into a protected root all count),
 * bounded by the same timeout as the probe. `LOOMBRE_SCAN_POLL=0` still
 * forces native watching everywhere — the escape hatch for a Mac where
 * Full Disk Access is granted to the runtime binary (the only grant macOS
 * honours for a daemon on those folders; see docs/install/macos.md).
 */
import { existsSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const POLL_ENV_VAR = "LOOMBRE_SCAN_POLL";
const DEBOUNCE_MS = 2000;

/** Stat-polling cadence for polled watchers. chokidar's defaults (100 ms
 *  per file, 300 ms for binary files) suit an editor's project tree; a
 *  media library is thousands of large binary files behind a 2 s debounce,
 *  so 1 s costs at most one extra second of latency and ten times fewer
 *  stats — on an SMB share or a consent-gated folder that is the difference
 *  between a watch and a load. */
export const POLL_INTERVAL_MS = 1_000;

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

/** macOS folder names TCC (Transparency, Consent, and Control) locks down
 *  beyond Unix permissions — the same three apps/server's directory picker
 *  refuses. Case-insensitive: the default macOS volume is. */
const TCC_PROTECTED_HOME_SUBFOLDERS = new Set(["desktop", "documents", "downloads"]);

/** Pure — true when `path` (an absolute, normalized path; callers resolve
 *  first) is, or is inside, a macOS privacy-protected location under a
 *  PERSONAL home (`/Users/<name>`, name not "Shared" — /Users/Shared is
 *  world-readable by design): Desktop, Documents, Downloads, iCloud Drive
 *  (~/Library/Mobile Documents) or a Photos library package
 *  (*.photoslibrary). Never true off darwin. */
export function looksLikeTccProtectedPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments[0] === undefined || segments[0].toLowerCase() !== "users") return false;
  const home = segments[1];
  if (home === undefined || home.toLowerCase() === "shared") return false;
  const subfolder = segments[2]?.toLowerCase();
  if (subfolder === undefined) return false;
  if (TCC_PROTECTED_HOME_SUBFOLDERS.has(subfolder)) return true;
  if (subfolder === "library" && segments[3]?.toLowerCase() === "mobile documents") return true;
  return segments.slice(2).some((s) => s.toLowerCase().endsWith(".photoslibrary"));
}

export function resolveUsePolling(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  const override = env[POLL_ENV_VAR];
  if (override === "1") return true;
  if (override === "0") return false;
  return looksLikeNetworkMount(path, platform) || looksLikeTccProtectedPath(path, platform);
}

// --- Main thread ⇄ watcher thread protocol ---------------------------------
// Plain data only (structured-clone crosses the boundary): the plan goes in
// as workerData, events come back as messages. ./watcher-thread.ts imports
// these as types only.

export interface WatchPlanEntry {
  readonly libraryId: string;
  /** Paths that passed the boot probe — the only paths chokidar ever sees.
   *  The CONFIGURED strings, not their resolved forms: what the operator
   *  typed is what the logs and the Stash sidecar names refer to. */
  readonly paths: readonly string[];
  readonly usePolling: boolean;
}

export interface WatcherThreadData {
  readonly plan: readonly WatchPlanEntry[];
  readonly debounceMs: number;
  readonly pollIntervalMs: number;
  readonly heartbeatMs: number;
}

export type WatcherThreadMessage =
  /** Every chokidar instance has been constructed. Sent before any of them
   *  has touched the filesystem (chokidar defers to an async stat first),
   *  so this arrives even when a native watch open is about to block. */
  | { readonly type: "watching"; readonly libraryIds: readonly string[] }
  /** chokidar's own 'ready' for one library — its initial scan finished. */
  | { readonly type: "ready"; readonly libraryId: string }
  /** A debounced burst of activity settled under this library's paths. */
  | { readonly type: "change"; readonly libraryId: string }
  | { readonly type: "log"; readonly message: string }
  /** Periodic sign of life (every `heartbeatMs`). A thread whose event loop
   *  is wedged inside a blocking native call cannot send one — that
   *  silence is how the process learns it must not try to join the thread
   *  at exit (hasUnresponsiveWatcherThread). */
  | { readonly type: "heartbeat" };

export type WatcherThreadCommand = { readonly type: "stop" };

// --- Handle ------------------------------------------------------------------

/** What `WatcherHandle.ready` settles to: "ready" — every watched library's
 *  initial scan finished; "gone" — the thread exited (crash, or stopped)
 *  before that, so nothing further will ever be watched. */
export type WatcherReadiness = "ready" | "gone";

export interface WatcherHandle {
  /** Asks the watcher thread to close its watchers and exit; bounded by
   *  `stopTimeoutMs` — a thread blocked inside the OS is abandoned (see
   *  `abandoned`), never waited on. Idempotent: every call shares one
   *  stop. */
  stop(): Promise<void>;
  /** Libraries for which at least one path passed the boot probe and was
   *  handed to the watcher thread — diagnostics for logs and tests. */
  readonly watchedLibraryIds: readonly string[];
  /** Settles once every watched library's initial scan finished ("ready"),
   *  or once the thread is gone ("gone"). Never settles while a native
   *  watch open is blocked inside the OS — callers that report on it must
   *  bound their own wait. */
  readonly ready: Promise<WatcherReadiness>;
  /** True after stop() gave up on a thread that would not exit. Such a
   *  thread cannot be joined, and Node's process.exit() joins every live
   *  worker_thread — the process owner must end the process another way
   *  (see hasUnresponsiveWatcherThread). */
  readonly abandoned: boolean;
}

/** How long a single library path may take to answer the boot-time
 *  access probe before it is skipped. Generous for a slow network mount,
 *  far below what a frozen boot costs. */
export const PATH_PROBE_TIMEOUT_MS = 2_000;

/** How long startWatcher waits for the thread to acknowledge its plan
 *  before resolving without it. Thread startup only (tsx in dev, plain JS
 *  in a build) — chokidar's initial scan is deliberately NOT awaited. */
export const THREAD_ACK_TIMEOUT_MS = 15_000;

/** How long stop() waits for the thread to exit before abandoning it. Well
 *  inside the worker's 10 s graceful-shutdown budget. */
export const STOP_TIMEOUT_MS = 2_000;

/** Heartbeat cadence of the thread, and how long without any message the
 *  main thread waits before calling it unresponsive. A healthy thread is
 *  never more than one heartbeat stale; a thread wedged in a blocking
 *  native call goes silent for good. The grace covers a slow start (tsx
 *  loading the thread's modules) — spawn counts as the first sign of life. */
export const THREAD_HEARTBEAT_MS = 1_000;
export const THREAD_UNRESPONSIVE_MS = 3_000;

interface ThreadLiveness {
  lastSeenMs: number;
  abandoned: boolean;
}

/** Every watcher thread this process has spawned and not yet seen exit. */
const liveThreads = new Map<Worker, ThreadLiveness>();

/**
 * True when some spawned watcher thread is still alive and either was
 * abandoned by stop() or has sent nothing for THREAD_UNRESPONSIVE_MS. Node's
 * process.exit() joins every live worker_thread, and a thread blocked in an
 * uninterruptible native call (an fs.watch open the OS holds on a consent
 * prompt) can never be joined — the exit would hang exactly where the old
 * main-thread freeze did. The process owner checks this from its 'exit'
 * hook, which runs before that join, and ends the process the hard way
 * when it is true. A healthy thread — alive, heartbeating — is joinable,
 * so an ordinary exit with the watcher still running stays ordinary.
 */
export function hasUnresponsiveWatcherThread(nowMs: number = Date.now()): boolean {
  for (const liveness of liveThreads.values()) {
    if (liveness.abandoned || nowMs - liveness.lastSeenMs > THREAD_UNRESPONSIVE_MS) return true;
  }
  return false;
}

/** Diagnostics/tests: how many watcher threads are currently alive. */
export function liveWatcherThreadCount(): number {
  return liveThreads.size;
}

export interface PlanWatchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Boot-time reachability probe for a library path — resolves when the
   *  path is accessible, rejects when it is missing or denied. Injectable
   *  for tests; defaults to fs.promises.access, which runs in the libuv
   *  threadpool and therefore cannot freeze the event loop even when the
   *  operating system blocks the call on a consent prompt (the timed-out
   *  call keeps its pool slot until the OS answers — see the header). */
  probePath?: (path: string) => Promise<void>;
  /** Canonicalizes an EXISTING path (symlinks resolved) for the polling
   *  decision only — chokidar still receives the configured string.
   *  Injectable for tests; defaults to fs.promises.realpath, bounded by the
   *  same timeout as the probe and falling back to the plain resolved path. */
  realpathPath?: (path: string) => Promise<string>;
  probeTimeoutMs?: number;
  /** Warnings — a skipped path, a thread that did not answer. */
  log?: (message: string) => void;
  /** Informational — one line per library actually handed to the thread,
   *  naming its backend (native events vs stat polling) so an operator can
   *  see which rule a path fell under without reading this file. */
  info?: (message: string) => void;
}

export interface StartWatcherOptions extends PlanWatchOptions {
  /** Called (debounced) after a burst of filesystem activity settles under
   *  `libraryId`'s paths. Typically enqueues an incremental 'scan' job. */
  onChange: (libraryId: string) => void | Promise<void>;
  debounceMs?: number;
  threadAckTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Test-only seam (same shape as the hash pool's resolveWorkerSpawn):
   *  which thread entry to spawn. Production always uses the sibling
   *  ./watcher-thread module. */
  resolveThreadSpawn?: () => { url: URL; execArgv: string[] };
}

type Probe = { ok: true; exists: boolean } | { ok: false; why: string };

/**
 * The boot probe (SPF-11) plus the per-library watch decision, as pure a
 * function as a filesystem probe allows: decides which of each library's
 * paths chokidar may see and whether that library polls, without touching
 * chokidar. Exported so the decision can be pinned in tests without a
 * thread.
 *
 * A path is watchable when it answers, OR when it is merely missing but
 * its parent answers — chokidar then watches the parent for the path's
 * creation, which is how a Stash `-wal` file that does not exist yet (and
 * a library folder mounted later) still gets picked up. Only a blocked/
 * denied/silent probe is skipped, with a log line.
 *
 * usePolling is a single boolean per chokidar instance, but the heuristic
 * is per-path — a library could mix a local path and a network path. If
 * ANY of the library's paths look like a network mount or a protected
 * root, the whole library polls (the safe direction to round to: a
 * spurious poll on a local path costs a little CPU, a missed native event
 * on a network path silently breaks the watch).
 */
export async function planWatch(
  libraries: readonly { id: string; paths: readonly string[] }[],
  options: PlanWatchOptions = {}
): Promise<WatchPlanEntry[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probePath = options.probePath ?? ((path: string) => access(path));
  const realpathPath = options.realpathPath ?? ((path: string) => realpath(path));
  const probeTimeoutMs = options.probeTimeoutMs ?? PATH_PROBE_TIMEOUT_MS;
  const log = options.log ?? ((message: string) => console.error(message));
  const info = options.info ?? ((message: string) => console.log(message));

  async function reachable(path: string): Promise<Probe> {
    const outcome = await settleWithin(probePath(path), probeTimeoutMs);
    if (outcome.ok) return { ok: true, exists: true };
    return { ok: false, why: outcome.why };
  }

  async function watchable(path: string): Promise<Probe> {
    const direct = await reachable(path);
    if (direct.ok || !/ENOENT/.test(direct.why)) return direct;
    const parent = await reachable(dirname(path));
    return parent.ok ? { ok: true, exists: false } : { ok: false, why: `${direct.why}; parent ${dirname(path)}: ${parent.why}` };
  }

  /** The path the polling decision is taken on: absolute, `..`-free, and
   *  with symlinks resolved where the filesystem answers in time. A missing
   *  path canonicalizes through its parent (realpath of a missing path
   *  rejects). Any failure or timeout falls back to the plain resolution. */
  async function canonical(path: string, exists: boolean): Promise<string> {
    const resolved = resolve(path);
    const target = exists ? resolved : dirname(resolved);
    const real = await settleWithin(realpathPath(target), probeTimeoutMs);
    if (!real.ok) return resolved;
    return exists ? real.value : join(real.value, basename(resolved));
  }

  const plan: WatchPlanEntry[] = [];
  for (const library of libraries) {
    if (library.paths.length === 0) continue;

    const watchablePaths: string[] = [];
    const decisionPaths: string[] = [];
    for (const path of library.paths) {
      const result = await watchable(path);
      if (result.ok) {
        watchablePaths.push(path);
        decisionPaths.push(await canonical(path, result.exists));
      } else {
        log(`worker: not watching library ${library.id} path ${path} — ${result.why}; scans still run, the watch resumes on the next worker start once the path is reachable`);
      }
    }
    if (watchablePaths.length === 0) continue;

    const usePolling = decisionPaths.some((p) => resolveUsePolling(p, env, platform));
    plan.push({ libraryId: library.id, paths: watchablePaths, usePolling });
    info(
      `worker: watching library ${library.id} — ${watchablePaths.length} ${watchablePaths.length === 1 ? "path" : "paths"}, ${usePolling ? "stat polling" : "native events"}`,
    );
  }
  return plan;
}

const JS_THREAD_URL = new URL("./watcher-thread.js", import.meta.url);
const TS_THREAD_URL = new URL("./watcher-thread.ts", import.meta.url);

/** Same three-runtime resolution as ./identity/pool.ts's resolveWorkerSpawn:
 *  compiled sibling when it exists (production `node dist`), otherwise the
 *  .ts sibling under tsx's loader (tsx dev / vitest). */
function resolveThreadSpawn(): { url: URL; execArgv: string[] } {
  if (existsSync(fileURLToPath(JS_THREAD_URL))) {
    return { url: JS_THREAD_URL, execArgv: [] };
  }
  return { url: TS_THREAD_URL, execArgv: ["--import", "tsx"] };
}

/**
 * Starts one chokidar watcher per library, each covering all of that
 * library's probe-passing `paths`, inside a dedicated worker_thread.
 * Filesystem events are debounced per-library in that thread (`debounceMs`,
 * default 2s) so a burst of writes (a multi-file copy) triggers exactly one
 * `onChange` call once things settle, not one per file event.
 *
 * Resolves once the thread has acknowledged the plan (every chokidar
 * instance constructed — before any of them touches the filesystem) or,
 * failing that, after `threadAckTimeoutMs`; the thread's own initial scan
 * is never awaited (see WatcherHandle.ready). A library whose every path
 * fails the probe is skipped with a log line; when nothing is watchable, no
 * thread is spawned at all. chokidar's runtime 'error' events are observed
 * inside the thread and surface as log lines here, so an unlistened emit
 * can never become a process-fatal unhandled rejection; a throwing or
 * rejecting `onChange` is logged for the same reason (an exception inside a
 * Worker 'message' listener is an uncaught exception on the main thread).
 */
export async function startWatcher(
  libraries: readonly { id: string; paths: readonly string[] }[],
  options: StartWatcherOptions
): Promise<WatcherHandle> {
  const log = options.log ?? ((message: string) => console.error(message));
  const plan = await planWatch(libraries, options);
  const watchedLibraryIds = plan.map((entry) => entry.libraryId);

  if (plan.length === 0) {
    return { watchedLibraryIds, ready: Promise.resolve("ready"), abandoned: false, stop: async () => undefined };
  }

  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const threadAckTimeoutMs = options.threadAckTimeoutMs ?? THREAD_ACK_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const spawn = (options.resolveThreadSpawn ?? resolveThreadSpawn)();
  const workerData: WatcherThreadData = { plan, debounceMs, pollIntervalMs: POLL_INTERVAL_MS, heartbeatMs: THREAD_HEARTBEAT_MS };
  const worker = new Worker(spawn.url, spawn.execArgv.length > 0 ? { workerData, execArgv: spawn.execArgv } : { workerData });
  // The thread must never be what keeps this process alive: the worker has
  // its own keep-alive, and a thread blocked inside the OS could otherwise
  // pin an exiting process open.
  worker.unref();
  const liveness: ThreadLiveness = { lastSeenMs: Date.now(), abandoned: false };
  liveThreads.set(worker, liveness);

  let exited = false;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const pendingReady = new Set(watchedLibraryIds);
  let resolveReady!: (outcome: WatcherReadiness) => void;
  const ready = new Promise<WatcherReadiness>((resolve) => {
    resolveReady = resolve;
  });
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let resolveAck!: (outcome: "ack" | "gone") => void;
  const ack = new Promise<"ack" | "gone">((resolve) => {
    resolveAck = resolve;
  });

  function deliverChange(libraryId: string): void {
    try {
      const result = options.onChange(libraryId);
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((err: unknown) => {
          log(`worker: watch onChange for library ${libraryId} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      log(`worker: watch onChange for library ${libraryId} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  worker.on("message", (message: WatcherThreadMessage) => {
    liveness.lastSeenMs = Date.now();
    switch (message.type) {
      case "watching":
        resolveAck("ack");
        return;
      case "ready":
        pendingReady.delete(message.libraryId);
        if (pendingReady.size === 0) resolveReady("ready");
        return;
      case "change":
        deliverChange(message.libraryId);
        return;
      case "log":
        log(message.message);
        return;
      case "heartbeat":
        return;
    }
  });
  worker.on("error", (err: unknown) => {
    log(`worker: library watcher thread failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  worker.on("exit", (code: number) => {
    exited = true;
    liveThreads.delete(worker);
    if (!stopping) {
      log(`worker: library watcher thread exited (code ${code}) — watch-triggered scans are off until the next worker start; scans still run`);
    }
    resolveAck("gone");
    resolveReady("gone");
    resolveExit();
  });

  const ackTimeout = afterTimeout(threadAckTimeoutMs, "timeout" as const);
  try {
    const outcome = await Promise.race([ack, ackTimeout.promise]);
    if (outcome === "timeout") {
      log(`worker: library watcher thread has not acknowledged its watch plan after ${threadAckTimeoutMs} ms — continuing without waiting (jobs are unaffected; a native watch blocked inside the OS is the likely cause)`);
    }
  } finally {
    ackTimeout.cancel();
  }

  async function performStop(): Promise<void> {
    stopping = true;
    if (exited) return;
    const command: WatcherThreadCommand = { type: "stop" };
    worker.postMessage(command);
    const stopTimeout = afterTimeout(stopTimeoutMs, "timeout" as const);
    try {
      const outcome = await Promise.race([exit.then(() => "exited" as const), stopTimeout.promise]);
      if (outcome === "timeout") {
        liveness.abandoned = true;
        log(`worker: library watcher thread did not stop within ${stopTimeoutMs} ms — abandoning it (a thread blocked inside a native watch open cannot be interrupted; only process exit reclaims it)`);
        // Best effort, never awaited: terminate() cannot complete while
        // the thread sits inside a blocking syscall.
        void worker.terminate().catch(() => undefined);
      }
    } finally {
      stopTimeout.cancel();
    }
  }

  return {
    watchedLibraryIds,
    ready,
    get abandoned() {
      return liveness.abandoned;
    },
    stop() {
      stopPromise ??= performStop();
      return stopPromise;
    },
  };
}

/** Awaits `work` for at most `ms`; a rejection or a timeout becomes an
 *  `{ ok: false }` with the reason, never a throw. The timer is always
 *  cleared so it never holds the event loop or fires into a settled race. */
async function settleWithin<T>(work: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  const timeout = afterTimeout(ms, { ok: false as const, why: `no answer within ${ms} ms (blocked on a permission prompt?)` });
  try {
    return await Promise.race([
      work.then(
        (value) => ({ ok: true, value }) as const,
        (err: unknown) => ({ ok: false, why: err instanceof Error ? err.message : String(err) }) as const,
      ),
      timeout.promise,
    ]);
  } finally {
    timeout.cancel();
  }
}

/** A cancellable timeout that resolves to `value` — cancelled timers never
 *  hold the event loop or fire into a settled race. */
function afterTimeout<T>(ms: number, value: T): { promise: Promise<T>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer);
    },
  };
}
