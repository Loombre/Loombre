// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/pipeline.ts
//
// Orchestrates one image ingest (P1.8): resolve the source (download if
// remote), run the variant job through a real worker_thread, clean up any
// temp download. No database access here — consumer.ts is the only piece
// of this subsystem that talks to @loombre/db (this module stays testable
// with nothing but a filesystem and, optionally, a fake fetch).

import { join } from 'node:path';
import { cleanupSource, resolveSource, type FetchLike } from './download.js';
import { runInWorkerThread } from './worker-runner.js';
import type { VariantJobInput, VariantJobResult } from './variant-job.js';

const DEFAULT_DATA_DIR = './data';

export function resolveDataDir(explicit?: string): string {
  return explicit ?? process.env.LOOMBRE_DATA_DIR ?? DEFAULT_DATA_DIR;
}

/** `<dataDir>/images/<entityType>/<entityId>` — files inside get named
 *  `<kind>-<width>.<ext>` by variant-job.ts (P1.8's exact layout). */
export function outputDirFor(dataDirPath: string, entityType: string, entityId: string): string {
  return join(dataDirPath, 'images', entityType, entityId);
}

export interface RunImagePipelineInput {
  entityType: string;
  entityId: string;
  /** Used as the variant-job base filename (e.g. 'poster', 'backdrop'). */
  kind: string;
  sourcePath: string;
  dataDir?: string;
  fetchImpl?: FetchLike;
  /** Injectable for tests — defaults to the real worker_thread runner.
   *  Production code never overrides this (the T0 mandate applies
   *  unconditionally); tests may pass runVariantJob directly for speed. */
  execute?: (input: VariantJobInput) => Promise<VariantJobResult>;
  /** Addendum A, lane S3: images.avifEnabled/webpQuality/avifQuality
   *  (packages/shared/src/settings-registry.ts), resolved by the caller
   *  (image/consumer.ts) fresh at JOB START from the worker-side effective-
   *  settings reader (apps/worker/src/settings/effective-settings.ts) —
   *  passed straight through into the workerData boundary (variant-job.ts's
   *  VariantJobInput; omitted here falls back to that module's own
   *  registry-matching defaults). */
  avifEnabled?: boolean;
  webpQuality?: number;
  avifQuality?: number;
}

export async function runImagePipeline(input: RunImagePipelineInput): Promise<VariantJobResult> {
  const resolved = await resolveSource(input.sourcePath, input.fetchImpl);
  try {
    const outputDir = outputDirFor(resolveDataDir(input.dataDir), input.entityType, input.entityId);
    const execute = input.execute ?? runInWorkerThread;
    return await execute({
      sourcePath: resolved.path,
      outputDir,
      baseName: input.kind,
      ...(input.avifEnabled !== undefined ? { avifEnabled: input.avifEnabled } : {}),
      ...(input.webpQuality !== undefined ? { webpQuality: input.webpQuality } : {}),
      ...(input.avifQuality !== undefined ? { avifQuality: input.avifQuality } : {}),
    });
  } finally {
    await cleanupSource(resolved);
  }
}
