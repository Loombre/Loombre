// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/support/crashing-watcher-thread.mjs
//
// Test-only worker_threads entry for watcher.spec.ts (SPF-14): throws at
// module load, so the parent's Worker sees 'error' then 'exit' before any
// acknowledgement — the "thread died" branch of startWatcher (resolve
// promptly, log it, settle `ready`, make stop() a no-op).
throw new Error("crashing-watcher-thread.mjs: injected module-load crash");
