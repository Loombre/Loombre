// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/dominant-color-worker-entry.ts
//
// The worker_thread bootstrap module for the one-time dominant_color
// backfill (P2.11). Mirrors variant-worker-entry.ts's contract exactly
// (reads workerData, never throws across the thread boundary uncaught) but
// runs only computeDominantColor — the backfill re-decodes an existing
// original image file to fill in a column that predates it; it must NOT
// re-run the full variant job (that would re-write already-correct
// variants/blurhash/files for no reason and cost far more CPU than this
// one-time sweep needs).

import { parentPort, workerData } from 'node:worker_threads';
import { computeDominantColor } from './variant-job.js';

export interface DominantColorWorkerInput {
  sourcePath: string;
}

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('dominant-color-worker-entry: must be run as a worker_thread');
  }

  try {
    const { sourcePath } = workerData as DominantColorWorkerInput;
    const color = await computeDominantColor(sourcePath);
    parentPort.postMessage({ ok: true, color });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

void main();
