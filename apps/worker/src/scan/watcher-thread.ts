// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/scan/watcher-thread.ts
//
// The worker_thread half of ./watcher.ts (SPF-14): chokidar lives HERE and
// nowhere else in the worker. This file is what actually runs inside the
// spawned thread — it reads the watch plan from `workerData`, constructs
// one chokidar instance per library, debounces that library's events into
// a single 'change' message, and exits on 'stop'.
//
// Why the split: on macOS `fs.watch` opens the watched directory
// synchronously inside libuv (`uv_fs_event_start` → `open()`), and that
// open blocks — indefinitely — on a TCC consent prompt nobody answers, or
// on an FSEvents quirk of a sandboxed filesystem. Whatever thread makes the
// call is wedged. Here that thread is this one, so the worker's main thread
// (pg-boss pollers, every job consumer, the shutdown handler) keeps
// running; the only casualty is this thread's watch events. The main-thread
// side never awaits anything from here that a blocked open could hold up:
// the 'watching' acknowledgement below is posted BEFORE any chokidar
// instance has touched the filesystem (chokidar's add() defers to an async
// stat first), and chokidar's own 'ready' is reported but never waited on.
//
// Wire protocol: ./watcher.ts's WatcherThreadData in, WatcherThreadMessage
// out, WatcherThreadCommand back in — imported as types only, so this module
// never loads the main-thread half at runtime. Log lines travel as
// messages rather than console writes so the parent's injectable `log`
// (tests assert on it) sees every one of them.

import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { parentPort, workerData } from "node:worker_threads";
import type { WatcherThreadCommand, WatcherThreadData, WatcherThreadMessage } from "./watcher.js";

if (!parentPort) {
  throw new Error("watcher-thread: must be run as a worker_thread");
}
const port = parentPort;
const data = workerData as WatcherThreadData;

function post(message: WatcherThreadMessage): void {
  port.postMessage(message);
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
      post({ type: "change", libraryId });
    }, data.debounceMs)
  );
}

for (const entry of data.plan) {
  const watcher = chokidarWatch([...entry.paths], {
    usePolling: entry.usePolling,
    interval: data.pollIntervalMs,
    binaryInterval: data.pollIntervalMs,
    ignoreInitial: true,
    persistent: true,
  });
  watcher.on("all", () => scheduleChange(entry.libraryId));
  watcher.on("ready", () => post({ type: "ready", libraryId: entry.libraryId }));
  // An EventEmitter "error" with no listener THROWS inside chokidar's async
  // handlers — an unhandled rejection, which would end this thread. A watch
  // failure is not fatal to a watcher, let alone to the worker.
  watcher.on("error", (err: unknown) => {
    post({
      type: "log",
      message: `worker: library watcher error for library ${entry.libraryId}: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
  watchers.push(watcher);
}

post({ type: "watching", libraryIds: data.plan.map((entry) => entry.libraryId) });

// Sign of life. unref'd so the heartbeat alone never keeps this thread
// alive once its watchers are closed; while they are open the loop runs
// anyway. A thread wedged inside a blocking native call cannot tick — the
// parent reads that silence as "do not try to join me at exit".
setInterval(() => post({ type: "heartbeat" }), data.heartbeatMs).unref();

port.on("message", (command: WatcherThreadCommand) => {
  if (command.type !== "stop") return;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  // In a worker_thread process.exit() ends THIS thread only (Node docs),
  // which is exactly the intent: the parent observes 'exit'.
  void Promise.allSettled(watchers.map((watcher) => watcher.close())).then(() => process.exit(0));
});
