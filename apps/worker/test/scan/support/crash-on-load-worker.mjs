// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/support/crash-on-load-worker.mjs
//
// Test-only worker_threads entry point for identity-pool.spec.ts's
// respawn-storm regression test (opus review of Wave 1, FW1-C). Unlike
// crash-worker.mjs (which crashes only on a specific in-band message,
// simulating a task-triggered failure INSIDE an otherwise-healthy
// worker), this fixture throws synchronously at MODULE LOAD — before
// parentPort is even wired up, before it can receive anything — which is
// exactly the pool.ts healSlot() comment's own named triggers: a
// module-load failure, or an OOM that kills the thread before it can do
// anything at all.
//
// Every respawn of this script crashes again, immediately and entirely
// on its own, with zero dependency on the test ever calling hashFile().
// That is precisely the shape the respawn-storm guard (MAX_CONSECUTIVE_
// HEALS / backoff / permanent-death, see pool.ts) exists to bound: left
// unchecked, the pool would spawn this thread over and over as fast as
// Node can create OS threads, forever.
throw new Error("crash-on-load-worker.mjs: injected module-load crash");
