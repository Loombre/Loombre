// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/backfill-consumer.ts
//
// The 'image-backfill' job consumer (P2.11, docs/PLAN.md §4.2's "migrate"
// step for migrations/0005_images_dominant_color.sql's expand-only column
// add). One-time sweep: existing `images` rows predate dominant_color and
// need it computed from their already-cached original file on disk — never
// re-fetched, never re-scanned, no network/library I/O of any kind.
//
// Batching + resumability: each job invocation is exactly ONE id-ordered
// batch (~200 original rows). `payload.cursor` is the last-processed id
// from the previous batch (null = start from the beginning). After a batch,
// this handler re-enqueues itself with the advanced cursor via
// `deps.enqueueSelf` when the batch was full (more rows likely remain); a
// short batch means the sweep has reached the end and it stops. Because
// every batch is its own pg-boss job, packages/jobs' existing ledger
// (recordActive/recordCompleted per job, wired by createJobQueue's work()
// wrapper) already gives per-batch progress visibility in the admin UI —
// no bespoke counter column needed here.
//
// Missing/unreadable source file handling: the original row (and its
// sibling variant rows) get the '' sentinel (see
// packages/db/src/internal/images.ts / migrations/0005's comment) —
// distinct from NULL so this row is never re-selected by a future batch,
// i.e. "skip permanently" without ever touching the filesystem for it
// again.
//
// Tier-0: the actual sharp decode happens in a real worker_thread
// (dominant-color-runner.ts), never on this (or any request) main thread.

import type { JobHandler } from '@loombre/jobs';
import type { DbOrTx, ImageNeedingDominantColorRow } from '@loombre/db/internal';
import { listImagesNeedingDominantColor, setImageDominantColor, copyDominantColorToVariants } from '@loombre/db/internal';
import { runDominantColorInWorkerThread } from './dominant-color-runner.js';

/** '#rrggbb' | '' — see migrations/0005_images_dominant_color.sql's comment
 *  for the NULL ("not yet computed") vs '' ("computed, unavailable")
 *  distinction this backfill is the sole writer of the latter for. */
export const DOMINANT_COLOR_UNAVAILABLE = '';

/** Matches imageConsumerHandler's own queue.work(..., { concurrency: 2 })
 *  cap (apps/worker/src/index.ts) — this backfill runs the same CPU-bound
 *  worker_thread decode the ingest path does, so it is tier-capped
 *  identically rather than getting its own, separately-tuned budget. */
export const IMAGE_BACKFILL_BATCH_SIZE = 200;

export interface ImageBackfillConsumerDeps {
  db: DbOrTx;
  /** Injectable for tests — defaults to the real worker_thread runner.
   *  Production code never overrides this (same convention as
   *  pipeline.ts's `execute`). */
  execute?: (sourcePath: string) => Promise<string>;
  /** Defaults to IMAGE_BACKFILL_BATCH_SIZE — overridable for tests so a
   *  small fixture set can exercise the multi-batch/cursor-resume path
   *  without seeding 200+ rows. */
  batchSize?: number;
  /** Re-enqueues this same job type with an advanced cursor when more rows
   *  remain. Wired to `queue.enqueue('image-backfill', ...)` in
   *  apps/worker/src/index.ts; injectable so tests can assert on the
   *  next-cursor value without a real queue. */
  enqueueSelf: (cursor: string) => Promise<void>;
}

async function processRow(
  db: DbOrTx,
  row: ImageNeedingDominantColorRow,
  execute: (sourcePath: string) => Promise<string>
): Promise<void> {
  let color: string;
  try {
    color = await execute(row.file_path);
  } catch {
    // Missing or unreadable — permanently skipped, never retried (the ''
    // sentinel excludes this row from every future backfill batch).
    color = DOMINANT_COLOR_UNAVAILABLE;
  }

  await setImageDominantColor(db, row.id, color);
  await copyDominantColorToVariants(db, {
    entityType: row.entity_type,
    entityId: row.entity_id,
    kind: row.kind,
    dominantColor: color,
  });
}

export function imageBackfillConsumerHandler(deps: ImageBackfillConsumerDeps): JobHandler<'image-backfill'> {
  const execute = deps.execute ?? runDominantColorInWorkerThread;
  const batchSize = deps.batchSize ?? IMAGE_BACKFILL_BATCH_SIZE;

  return async (payload) => {
    const batch = await listImagesNeedingDominantColor(deps.db, {
      afterId: payload.cursor ?? null,
      limit: payload.batchSize ?? batchSize,
    });

    for (const row of batch) {
      await processRow(deps.db, row, execute);
    }

    if (batch.length === (payload.batchSize ?? batchSize)) {
      const nextCursor = batch[batch.length - 1]!.id;
      await deps.enqueueSelf(nextCursor);
    }
  };
}
