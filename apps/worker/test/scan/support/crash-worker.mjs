// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/support/crash-worker.mjs
//
// Test-only worker_threads entry point for identity-pool.spec.ts
// (AUD-A2d-002). Speaks the SAME wire protocol as the real
// src/scan/identity/hash-worker.ts ({id, filePath, sizeBytes} in ->
// {id, contentHash} out), but, unlike hash-worker.ts, deliberately throws
// a SYNCHRONOUS, uncaught exception when it receives the sentinel
// filePath "__CRASH__".
//
// hash-worker.ts's real hashFile() pipeline can only ever fail inside a
// Promise (its own header: every per-file error is caught and turned into
// a normal {id, error} reply), so it can never exercise the pool's
// worker-thread-CRASH recovery path — only a module-load failure or an
// OOM would, neither of which is reproducible on demand. This fixture
// crashes the OS thread for real and on command: Node's worker_threads
// surfaces an uncaught exception as an 'error' event on the parent's
// Worker object, immediately followed by 'exit' — exactly what
// pool.ts's healSlot() must detect and recover from. Deterministic and
// portable (no OS-lock/timing dependency), the same injection-seam
// philosophy as apps/worker/test/stash/support/busy-direct-open.ts.
//
// Plain .mjs (not .ts): loaded directly as the worker script via the
// pool's `resolveWorkerSpawn` test seam, so it needs none of pool.ts's
// own tsx/dist resolution dance.
import { parentPort } from "node:worker_threads";

parentPort.on("message", (msg) => {
  if (msg.filePath === "__CRASH__") {
    throw new Error("crash-worker.mjs: injected crash");
  }
  parentPort.postMessage({ id: msg.id, contentHash: `echo:${msg.filePath}` });
});
