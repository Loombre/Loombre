// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/probe/opengop-backfill-consumer.ts
//
// The 'opengop-backfill' job consumer (migrations/0038_media_streams_open_
// gop.sql's "migrate" step for an expand-only ALTER TABLE — same
// expand -> migrate -> contract policy, and the same batched/cursor-resume
// structure, as apps/worker/src/image/backfill-consumer.ts's dominant_color
// backfill). One-time sweep: existing media_streams video rows predate
// open_gop and need it resolved — HEVC rows via the real bounded ffmpeg
// trace_headers scan (./opengop.ts), every other video row via a single
// bulk SQL update (no scan needed: @loombre/playback-engine never consults
// this field for a non-hevc codec).
//
// Batching + resumability: each job invocation is exactly ONE id-ordered
// batch of HEVC media_streams rows still open_gop IS NULL (~200 rows,
// mirrors IMAGE_BACKFILL_BATCH_SIZE). `payload.cursor` is the last-
// processed media_streams id from the previous batch (null = start a fresh
// sweep). After a batch, this handler re-enqueues itself with the advanced
// cursor via `deps.enqueueSelf` when the batch was full (more rows likely
// remain); a short batch means the sweep has reached the end and it stops.
// The non-HEVC bulk-false UPDATE runs exactly once per fresh sweep (cursor
// === null) — repeating an already-no-op indexed-free WHERE on every
// resumed batch would cost a full media_streams scan for nothing.
//
// Failure handling: a per-row scan failure/timeout resolves `null`
// (./opengop.ts's own contract) and this handler simply skips the write —
// the row stays open_gop IS NULL, so it is naturally picked back up by the
// NEXT fresh sweep (apps/worker/src/index.ts's boot-time
// enqueueOpenGopBackfillIfNeeded, which only fires when
// listHevcStreamsNeedingOpenGopProbe still finds rows). No sentinel value
// needed here, unlike the image backfill's '' — NULL already means
// "not yet resolved" for a boolean column, and "never guess true" is the
// column's own invariant (migrations/0038's comment), so leaving it NULL
// on failure IS the correct, spec-mandated behavior, not a workaround.
//
// Boot-time re-sweep residual (opus review finding 10): both
// hasVideoStreamsNeedingOpenGopBackfill and listHevcStreamsNeedingOpenGopProbe
// (packages/db/src/internal/files.ts) exclude rows whose FILE is currently
// missing (media_files.missing_since_ms IS NOT NULL) — without that, a
// deleted/unmounted file's row would stay NULL forever and re-trigger a
// full sweep on every single worker boot, permanently. That exclusion does
// NOT cover a file that is still PRESENT on disk but unscannable (a
// corrupt container, or any other scan failure/timeout distinct from
// "missing") — such a row also stays NULL forever (this handler above
// deliberately never writes a guessed value), so it WILL still cause a
// fresh sweep to be re-enqueued on every boot for as long as it exists.
// This residual is accepted rather than special-cased: a corrupt/
// unscannable file is expected to be rare, and re-running a bulk
// SELECT ... LIMIT 1 existence check plus (at most) one wasted batch of
// re-attempted scans per boot is bounded, cheap work, not a growing cost.
//
// Tier-0: each scan is a short-lived (~60-75ms), bounded ffmpeg child
// process — never inline on a request path (CLAUDE.md invariant 6).

import type { JobHandler } from "@loombre/jobs";
import type { DbOrTx, HevcStreamNeedingOpenGopProbeRow } from "@loombre/db/internal";
import { bulkSetNonHevcVideoOpenGopFalse, listHevcStreamsNeedingOpenGopProbe, setStreamOpenGop } from "@loombre/db/internal";
import { detectOpenGop } from "./opengop.js";
import type { OpenGopVerdict } from "./opengop.js";

/** Matches IMAGE_BACKFILL_BATCH_SIZE (apps/worker/src/image/
 *  backfill-consumer.ts) — same "small enough that one job invocation
 *  never scans the whole library" rationale. */
export const OPENGOP_BACKFILL_BATCH_SIZE = 200;

export interface OpenGopBackfillConsumerDeps {
  db: DbOrTx;
  /** Injectable for tests — defaults to the real bounded ffmpeg scan
   *  (./opengop.ts's detectOpenGop). Production code never overrides
   *  this (same convention as image/backfill-consumer.ts's `execute`).
   *  Signature matches detectOpenGop's own (filePath, videoTypeIndex,
   *  codec, durationMs) -> OpenGopVerdict. */
  detect?: (filePath: string, videoTypeIndex: number, codec: string, durationMs: number | null) => Promise<OpenGopVerdict>;
  /** Defaults to OPENGOP_BACKFILL_BATCH_SIZE — overridable for tests so a
   *  small fixture set can exercise the multi-batch/cursor-resume path
   *  without seeding 200+ rows. */
  batchSize?: number;
  /** Re-enqueues this same job type with an advanced cursor when more rows
   *  remain. Wired to `queue.enqueue('opengop-backfill', ...)` in
   *  apps/worker/src/index.ts; injectable so tests can assert on the
   *  next-cursor value without a real queue. `batchSize` is threaded
   *  through verbatim from `payload.batchSize` (opus review finding 15b —
   *  previously dropped here, so an explicit non-default batch size
   *  silently reverted to OPENGOP_BACKFILL_BATCH_SIZE on the very next
   *  resumed batch instead of staying pinned for the whole sweep). */
  enqueueSelf: (cursor: string, batchSize?: number) => Promise<void>;
}

async function processRow(
  db: DbOrTx,
  row: HevcStreamNeedingOpenGopProbeRow,
  detect: (filePath: string, videoTypeIndex: number, codec: string, durationMs: number | null) => Promise<OpenGopVerdict>,
): Promise<void> {
  const verdict = await detect(row.file_path, row.video_type_index, row.codec, row.duration_ms);
  if (verdict === null) {
    // Unknown — leave NULL, retried by a future fresh sweep (see module
    // header). Never write a guessed value.
    return;
  }
  await setStreamOpenGop(db, row.id, verdict);
}

export function opengopBackfillConsumerHandler(deps: OpenGopBackfillConsumerDeps): JobHandler<"opengop-backfill"> {
  const detect = deps.detect ?? detectOpenGop;
  const defaultBatchSize = deps.batchSize ?? OPENGOP_BACKFILL_BATCH_SIZE;

  return async (payload) => {
    // Hoisted once (opus review finding 15b — was computed twice below,
    // once for the query limit and again for the full-batch check).
    const effectiveBatchSize = payload.batchSize ?? defaultBatchSize;

    if (payload.cursor === null) {
      const nonHevcUpdated = await bulkSetNonHevcVideoOpenGopFalse(deps.db);
      console.log(`worker: opengop-backfill bulk-set open_gop=false for ${nonHevcUpdated} non-hevc video stream row(s)`);
    }

    const batch = await listHevcStreamsNeedingOpenGopProbe(deps.db, {
      afterId: payload.cursor ?? null,
      limit: effectiveBatchSize,
    });

    for (const row of batch) {
      await processRow(deps.db, row, detect);
    }

    if (batch.length === effectiveBatchSize) {
      const nextCursor = batch[batch.length - 1]!.id;
      // Forwards payload.batchSize VERBATIM (not effectiveBatchSize) — an
      // undefined payload.batchSize (production's normal fresh-sweep case)
      // stays undefined on the resumed job too, letting a future deploy's
      // changed OPENGOP_BACKFILL_BATCH_SIZE default apply to in-flight
      // sweeps rather than pinning them to whatever default happened to be
      // active when the sweep started.
      await deps.enqueueSelf(nextCursor, payload.batchSize);
    }
  };
}
