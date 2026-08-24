// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/progress-write-queue.ts
//
// gap-F7 (QA 2026-08-20/21, P2): at a natural EOF the media element fires
// `pause` first, then `ended` (WHATWG media event order), and each handler
// flushed its own fire-and-forget PUT /progress — two CONCURRENT HTTP
// requests with no ordering guarantee between them. The stale
// 'in-progress' flush could therefore persist AFTER the 'played' flush,
// leaving the row's final state {state: 'in-progress',
// positionMs == durationMs, playCount unbumped} (observed live in QA run 1
// of the direct-play EOF repro). The same window exists between a ~10s
// interval heartbeat still in flight and any flush behind it. HTTP gives
// two overlapping requests no ordering; the only ordering that exists is
// the one the CLIENT enforces by not overlapping them.
//
// This module is that ordering: a minimal FIFO write lane. Each enqueued
// write starts only after every previously enqueued write has SETTLED
// (resolved or rejected), so the last-issued write is always the last one
// the server processes. A failed write never blocks the lane — a dropped
// heartbeat must not swallow the EOF 'played' write queued behind it.
// Pure and DOM-free; the write payload is captured by the caller at
// enqueue time (flush-time snapshot semantics are unchanged).

export interface ProgressWriteQueue {
  /** Runs `write` once every previously enqueued write has settled.
   *  Returns a promise that resolves when THIS write has settled; it
   *  never rejects (progress writes are best-effort — errors are
   *  swallowed exactly as the pre-queue `void apiPut(...).catch()` did). */
  enqueue(write: () => Promise<unknown>): Promise<void>;
}

export function createProgressWriteQueue(): ProgressWriteQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(write: () => Promise<unknown>): Promise<void> {
      const run = (): Promise<void> => {
        // A synchronous throw from `write` must settle this slot like a
        // rejection would — never poison the lane's tail.
        try {
          return Promise.resolve(write()).then(
            () => undefined,
            () => undefined,
          );
        } catch {
          return Promise.resolve();
        }
      };
      const next = tail.then(run);
      tail = next;
      return next;
    },
  };
}
