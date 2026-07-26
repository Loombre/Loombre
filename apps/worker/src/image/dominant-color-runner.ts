// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/dominant-color-runner.ts
//
// runDominantColorInWorkerThread() — the T0-mandated entry point (CLAUDE.md
// invariant 9) for the one-time dominant_color backfill (P2.11): always
// spawns a real `node:worker_threads` Worker running
// dominant-color-worker-entry.ts, never calls computeDominantColor directly
// on the main thread. Deliberately separate from worker-runner.ts's
// runInWorkerThread (which runs the FULL variant job) — the backfill only
// needs to re-decode existing originals for the one missing column, not
// regenerate variants/blurhash/files that already exist on disk.
//
// Dev/test vs. production module resolution: identical .js-preferred /
// .ts-with-tsx-fallback logic to worker-runner.ts — see that file's header
// for the full rationale (duplicated here rather than factored out, matching
// this subsystem's existing one-file-per-worker-entry convention: compare
// variant-worker-entry.ts + worker-runner.ts as the established pair).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DominantColorWorkerInput } from './dominant-color-worker-entry.js';

function resolveWorkerEntry(): { url: URL; execArgv: string[] } {
  const jsUrl = new URL('./dominant-color-worker-entry.js', import.meta.url);
  if (existsSync(fileURLToPath(jsUrl))) {
    return { url: jsUrl, execArgv: [] };
  }
  const tsUrl = new URL('./dominant-color-worker-entry.ts', import.meta.url);
  return { url: tsUrl, execArgv: ['--import', 'tsx'] };
}

type WorkerMessage = { ok: true; color: string } | { ok: false; error: string };

export function runDominantColorInWorkerThread(sourcePath: string): Promise<string> {
  const { url, execArgv } = resolveWorkerEntry();
  const input: DominantColorWorkerInput = { sourcePath };

  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: input, execArgv });

    let settled = false;

    worker.once('message', (message: WorkerMessage) => {
      settled = true;
      if (message.ok) {
        resolve(message.color);
      } else {
        reject(new Error(`dominant-color worker failed: ${message.error}`));
      }
      void worker.terminate();
    });

    worker.once('error', (err: Error) => {
      settled = true;
      reject(err);
    });

    worker.once('exit', (code: number) => {
      if (!settled && code !== 0) {
        reject(new Error(`dominant-color worker exited with code ${code} before reporting a result`));
      }
    });
  });
}
