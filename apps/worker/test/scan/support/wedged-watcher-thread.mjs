// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/support/wedged-watcher-thread.mjs
//
// Test-only worker_threads entry for watcher.spec.ts (SPF-14). Spawned
// through startWatcher's `resolveThreadSpawn` seam in place of the real
// src/scan/watcher-thread.ts, it blocks its thread SYNCHRONOUSLY and forever
// before posting a single message — the shape of chokidar's fs.watch open()
// parked on a macOS TCC consent prompt nobody answers (the SPF-11 residual
// this run closes). A blocked thread never acknowledges its plan, never
// reports ready, and never answers 'stop'; the spec proves the main thread
// stays live throughout and every wait on the thread is bounded.
//
// Atomics.wait is the one portable way to block a JS thread inside a real
// syscall-like wait (a FIFO open would need a filesystem fixture). Unlike a
// blocked open(2) it IS interruptible by worker.terminate(), which is what
// lets the vitest process exit cleanly afterwards — the production hard-
// exit fallback for the non-interruptible case lives in apps/worker/src/
// index.ts's shutdown(), outside this unit's reach.
//
// Plain .mjs (not .ts): loaded directly as the worker script via the seam,
// so it needs none of watcher.ts's own tsx/dist resolution dance.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
