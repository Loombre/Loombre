// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/index.ts — public barrel for the image
// ingest pipeline (P1.8).
//
// `imageConsumerHandler` is a FACTORY (see consumer.ts's header): call it
// with real deps to get the JobHandler<'image'> a `queue.work('image',
// ...)` call expects. Wiring into apps/worker/src/index.ts happens in a
// later wave, by design (out of this module's scope).

export { VARIANT_WIDTHS, runVariantJob, avifSupported, hashString, type VariantJobInput, type VariantJobResult, type VariantFile } from './variant-job.js';

export { runInWorkerThread } from './worker-runner.js';

export { resolveSource, cleanupSource, isRemoteSource, ImageDownloadError, type ResolvedSource, type FetchLike } from './download.js';

export { runImagePipeline, resolveDataDir, outputDirFor, type RunImagePipelineInput } from './pipeline.js';

export { imageConsumerHandler, type ImageConsumerDeps } from './consumer.js';

export { runDominantColorInWorkerThread } from './dominant-color-runner.js';

export {
  imageBackfillConsumerHandler,
  DOMINANT_COLOR_UNAVAILABLE,
  IMAGE_BACKFILL_BATCH_SIZE,
  type ImageBackfillConsumerDeps,
} from './backfill-consumer.js';
