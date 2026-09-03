// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/support/scripted-watcher-thread.mjs
//
// Test-only worker_threads entry for watcher.spec.ts (SPF-14) that speaks
// the real wire protocol (see src/scan/watcher.ts WatcherThreadMessage)
// with a fixed script instead of chokidar, so the main-thread half can be
// driven deterministically without a filesystem or a debounce window:
//   1. posts 'watching' for the whole plan;
//   2. posts 'ready' for the FIRST library only — a second library never
//      becomes ready (pins that `handle.ready` aggregates across libraries
//      instead of settling on the first);
//   3. posts three 'change' events for the first library (pins that a
//      throwing or rejecting onChange is contained and later events still
//      arrive — an exception inside a Worker 'message' listener would
//      otherwise be an uncaught exception on the main thread);
//   4. heartbeats at the parent's cadence and exits on 'stop'.
import { parentPort, workerData } from "node:worker_threads";

const first = workerData.plan[0].libraryId;
parentPort.postMessage({ type: "watching", libraryIds: workerData.plan.map((entry) => entry.libraryId) });
parentPort.postMessage({ type: "ready", libraryId: first });
for (let i = 0; i < 3; i += 1) parentPort.postMessage({ type: "change", libraryId: first });
setInterval(() => parentPort.postMessage({ type: "heartbeat" }), workerData.heartbeatMs).unref();
parentPort.on("message", (command) => {
  if (command.type === "stop") process.exit(0);
});
