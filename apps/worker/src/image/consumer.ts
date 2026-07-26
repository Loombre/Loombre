// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/consumer.ts
//
// The 'image' job consumer (P1.8). `imageConsumerHandler(deps)` is a
// FACTORY, matching metadata/consumer.ts's convention — it closes over
// injected deps and returns the JobHandler<'image'> a
// `queue.work('image', ...)` call expects; wiring is a later wave's job.
//
// Content-class safety: the job carries only entityType/entityId — no
// content_class of its own (images have no isolation column; enforcement
// is a READ-time concern of the serving endpoint per docs/PLAN.md §6.4,
// out of this worker-side wave's scope). What THIS module guarantees is
// narrower and absolute: before writing anything (files or DB rows), the
// owning entity must exist. A race-deleted item (or a job carrying a
// bogus id) writes nothing — no orphaned images-table rows, no files on
// disk for content that no longer has a home.
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): images.
// avifEnabled/webpQuality/avifQuality are re-resolved at JOB START — once
// per 'image' job, via the worker-side effective-settings reader
// (apps/worker/src/settings/effective-settings.ts) — never once at
// process boot. This is the natural boundary for a queue consumer: each
// job is an independent unit of work with no mid-job state a settings
// change could destabilize, so "job start" gives the freshest possible
// value without any polling loop.

import type { JobHandler } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import { upsertImage, type UpsertImageInput } from '@loombre/db/internal';
import { isRemoteSource } from './download.js';
import { runImagePipeline, type RunImagePipelineInput } from './pipeline.js';
import { getWorkerSettingValue, loadWorkerEffectiveSettings } from '../settings/effective-settings.js';

export interface ImageConsumerDeps {
  db: DbOrTx;
  dataDir?: string;
  fetchImpl?: RunImagePipelineInput['fetchImpl'];
  execute?: RunImagePipelineInput['execute'];
  clock?: () => number;
}

/** Only 'catalog_item' is implemented (matches metadata/consumer.ts's
 *  enqueue convention — the only entity type anything in this wave
 *  produces image jobs for). Any other/unknown entityType is treated as
 *  non-existent, not an error: a conservative default that never writes
 *  for an entity kind this module doesn't yet know how to verify. */
async function entityExists(db: DbOrTx, entityType: string, entityId: string): Promise<boolean> {
  if (entityType !== 'catalog_item') return false;
  const row = await db.selectFrom('catalog_items').select('id').where('id', '=', entityId).executeTakeFirst();
  return row !== undefined;
}

function sourceFor(sourcePath: string): UpsertImageInput['source'] {
  return isRemoteSource(sourcePath) ? 'provider' : 'local';
}

export function imageConsumerHandler(deps: ImageConsumerDeps): JobHandler<'image'> {
  const clock = deps.clock ?? (() => Date.now());

  return async (payload) => {
    const exists = await entityExists(deps.db, payload.entityType, payload.entityId);
    if (!exists) return;

    const settingsResult = await loadWorkerEffectiveSettings(deps.db);
    const avifEnabled = getWorkerSettingValue(settingsResult, 'images.avifEnabled', true);
    const webpQuality = getWorkerSettingValue(settingsResult, 'images.webpQuality', 80);
    const avifQuality = getWorkerSettingValue(settingsResult, 'images.avifQuality', 50);

    const result = await runImagePipeline({
      entityType: payload.entityType,
      entityId: payload.entityId,
      kind: payload.kind,
      sourcePath: payload.sourcePath,
      avifEnabled,
      webpQuality,
      avifQuality,
      ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.execute !== undefined ? { execute: deps.execute } : {}),
    });

    const now = clock();
    const source = sourceFor(payload.sourcePath);
    // The images.kind column is a closed PG enum; the job payload's `kind`
    // is `string` (packages/jobs' closed job-type registry doesn't narrow
    // per-field enums). An invalid value fails the INSERT loudly rather
    // than being silently coerced — consistent with "malformed input
    // fails the job cleanly, never crashes the process".
    const kind = payload.kind as UpsertImageInput['kind'];

    await upsertImage(deps.db, {
      entityType: payload.entityType,
      entityId: payload.entityId,
      kind,
      source,
      width: null,
      height: result.original.height,
      blurhash: result.blurhash,
      dominantColor: result.dominantColor,
      filePath: result.original.filePath,
      createdAtMs: now,
    });

    for (const variant of result.variants) {
      await upsertImage(deps.db, {
        entityType: payload.entityType,
        entityId: payload.entityId,
        kind,
        source,
        width: variant.width,
        height: variant.height,
        blurhash: result.blurhash,
        // Same colour as the original — no need to re-decode per width
        // (mirrors blurhash being shared across every row of the set).
        dominantColor: result.dominantColor,
        filePath: variant.filePath,
        createdAtMs: now,
      });
    }
  };
}
