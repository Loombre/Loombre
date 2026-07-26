// SPDX-License-Identifier: AGPL-3.0-only
/**
 * worker_threads pool for content-hashing (docs/PLAN.md §9.2, CLAUDE.md
 * invariant 9). Round-robins hashFile() requests across a fixed set of
 * long-lived worker threads (./hash-worker.ts), each request tagged with a
 * monotonic id so out-of-order replies (a large file's hash taking longer
 * than a small one queued after it) resolve the correct caller.
 *
 * Pool size comes from the caller (the scan job handler, apps/worker/src/
 * index.ts, re-resolves scanner.concurrency — Addendum A registry,
 * packages/shared/src/settings-registry.ts — fresh at the start of every
 * scan job via apps/worker/src/settings/effective-settings.ts's
 * resolveScanConcurrencyFromEffective(), default max(2, cpus/2) absent any
 * env pin/DB override, per the task's concurrency-cap mandate); this
 * module has no opinion on sizing itself.
 */
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface HashPool {
  hashFile(filePath: string, sizeBytes: number): Promise<string>;
  terminate(): Promise<void>;
}

interface PendingEntry {
  resolve: (hash: string) => void;
  reject: (err: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
}

const JS_WORKER_URL = new URL("./hash-worker.js", import.meta.url);
const TS_WORKER_URL = new URL("./hash-worker.ts", import.meta.url);

/**
 * Resolves how to spawn the hash-worker thread across three runtimes this
 * repo actually runs in:
 *   - production (`tsc build` + `node dist/...`): dist/scan/identity/
 *     hash-worker.js exists (tsc mirrors the whole src/ tree per-file), so
 *     the plain compiled-JS path is used directly — cheapest, no extra
 *     loader.
 *   - `tsx watch`/`tsx` dev: only hash-worker.ts exists on disk. tsx's own
 *     process-wide loader hook makes `new Worker(new URL('./x.js', ...))`
 *     transparently resolve to `x.ts` (verified empirically while building
 *     this module), so the .js URL would actually still work here — BUT
 *     that resolution is a property of the PARENT process's loader
 *     registration, not something this module can assume in general (see
 *     vitest below), so it is not relied on.
 *   - `vitest run` (this package's own test suite): test files run through
 *     vite-node's module transform, which does NOT propagate any loader
 *     hook to a plain `node:worker_threads` Worker — spawning the .js URL
 *     here 404s (no build has run) and the worker fails to start. Passing
 *     `execArgv: ['--import', 'tsx']` makes the freshly spawned OS thread
 *     register tsx's loader for itself, independent of whatever the
 *     parent process is doing, so it can load hash-worker.ts directly.
 * `existsSync` is a one-time, synchronous, tiny disk check — negligible
 * next to spawning a worker thread at all.
 */
function resolveWorkerSpawn(): { url: URL; execArgv: string[] } {
  if (existsSync(fileURLToPath(JS_WORKER_URL))) {
    return { url: JS_WORKER_URL, execArgv: [] };
  }
  return { url: TS_WORKER_URL, execArgv: ["--import", "tsx"] };
}

export function createHashPool(size: number): HashPool {
  const poolSize = Math.max(1, Math.floor(size));
  const slots: WorkerSlot[] = [];
  const pending = new Map<number, PendingEntry>();
  let nextId = 0;
  let nextWorkerIndex = 0;
  let terminated = false;

  function makeWorkerSlot(): WorkerSlot {
    const spawn = resolveWorkerSpawn();
    const worker = new Worker(spawn.url, spawn.execArgv.length > 0 ? { execArgv: spawn.execArgv } : {});
    worker.on("message", (msg: { id: number; contentHash: string } | { id: number; error: string }) => {
      const entry = pending.get(msg.id);
      if (!entry) return; // already settled/terminated
      pending.delete(msg.id);
      if ("error" in msg) {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg.contentHash);
      }
    });
    worker.on("error", (err) => {
      // A worker-level (not task-level) failure: fail every task currently
      // pending against this worker rather than hanging their callers
      // forever. hash-worker.ts's own message handler already turns
      // per-file errors into a normal {id, error} reply, so this path is
      // reserved for the worker thread itself crashing.
      for (const [id, entry] of pending.entries()) {
        pending.delete(id);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return { worker };
  }

  for (let i = 0; i < poolSize; i++) {
    slots.push(makeWorkerSlot());
  }

  return {
    hashFile(filePath: string, sizeBytes: number): Promise<string> {
      if (terminated) {
        return Promise.reject(new Error("createHashPool: pool already terminated"));
      }
      const id = nextId++;
      const slot = slots[nextWorkerIndex % slots.length]!;
      nextWorkerIndex++;
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        slot.worker.postMessage({ id, filePath, sizeBytes });
      });
    },

    async terminate(): Promise<void> {
      terminated = true;
      for (const [id, entry] of pending.entries()) {
        pending.delete(id);
        entry.reject(new Error("createHashPool: terminated while a hash was in flight"));
      }
      await Promise.all(slots.map((s) => s.worker.terminate()));
      slots.length = 0;
    },
  };
}

// Re-exported so callers that only need the byte-range/hash rule (e.g. a
// single-file resume check) don't have to spin up a pool for one file.
export { hashFile } from "./hash.js";
