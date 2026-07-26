// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/variant-worker-entry.ts
//
// The worker_thread bootstrap module (P1.8, CLAUDE.md invariant 9): this
// file is what actually runs inside the spawned thread. It reads
// `workerData` (a VariantJobInput), calls runVariantJob (all the sharp +
// blurhash CPU work), and posts back either {ok:true, result} or
// {ok:false, error} — never throws across the thread boundary uncaught,
// so a malformed image fails the job cleanly instead of crashing the
// worker process (worker-runner.ts turns {ok:false} into a rejected
// promise the job queue's existing try/catch already handles).

import { parentPort, workerData } from 'node:worker_threads';
import { runVariantJob, type VariantJobInput } from './variant-job.js';

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('variant-worker-entry: must be run as a worker_thread');
  }

  try {
    const result = await runVariantJob(workerData as VariantJobInput);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

void main();
