// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/worker-runner.ts
//
// runInWorkerThread() is the T0-mandated entry point (CLAUDE.md invariant
// 9, docs/PLAN.md §9.2: "Node worker_threads for hashing/blurhash" — this
// project's mandate goes further and runs the FULL variant job, sharp
// encode included, in the pool, not just the blurhash step): it always
// spawns a real `node:worker_threads` Worker running
// variant-worker-entry.ts, never calls runVariantJob directly on the main
// thread.
//
// Dev/test vs. production module resolution: `new Worker(url)` loads a
// literal file from disk — it does NOT go through TypeScript/Node's
// NodeNext import-specifier resolution the rest of this codebase relies
// on (that only applies to `import` statements). After `tsc` builds this
// package, `variant-worker-entry.js` sits compiled next to this file in
// dist/ and is used directly. Under `tsx watch` (dev) or vitest (test),
// only the `.ts` source exists next to this file, so this resolves that
// sibling instead and passes `execArgv: ['--import', 'tsx']` so the new
// thread's own module loader can understand TypeScript — verified to work
// under both plain `node` and vitest. tsx is a devDependency; the `.js`
// path is preferred whenever it exists specifically so a real production
// build (no devDependencies installed) never needs it.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { VariantJobInput, VariantJobResult } from './variant-job.js';

function resolveWorkerEntry(): { url: URL; execArgv: string[] } {
  const jsUrl = new URL('./variant-worker-entry.js', import.meta.url);
  if (existsSync(fileURLToPath(jsUrl))) {
    return { url: jsUrl, execArgv: [] };
  }
  const tsUrl = new URL('./variant-worker-entry.ts', import.meta.url);
  return { url: tsUrl, execArgv: ['--import', 'tsx'] };
}

type WorkerMessage = { ok: true; result: VariantJobResult } | { ok: false; error: string };

export function runInWorkerThread(input: VariantJobInput): Promise<VariantJobResult> {
  const { url, execArgv } = resolveWorkerEntry();

  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: input, execArgv });

    let settled = false;

    worker.once('message', (message: WorkerMessage) => {
      settled = true;
      if (message.ok) {
        resolve(message.result);
      } else {
        reject(new Error(`variant worker failed: ${message.error}`));
      }
      void worker.terminate();
    });

    worker.once('error', (err: Error) => {
      settled = true;
      reject(err);
    });

    worker.once('exit', (code: number) => {
      if (!settled && code !== 0) {
        reject(new Error(`variant worker exited with code ${code} before reporting a result`));
      }
    });
  });
}
