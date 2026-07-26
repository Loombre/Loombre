// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `queue.work('subtitle-extract', ...)` entry point (packages/jobs) —
 * mirrors ../transcode/consumer.ts exactly: deliberately thin, all the
 * real logic lives in runner.ts.
 */
import type { DbOrTx } from "@loombre/db/internal";
import type { SubtitleExtractJobPayload } from "@loombre/jobs";
import { runSubtitleExtraction } from "./runner.js";

export function createSubtitleExtractConsumerHandler(
  db: DbOrTx,
): (payload: SubtitleExtractJobPayload) => Promise<void> {
  return async (payload: SubtitleExtractJobPayload): Promise<void> => {
    await runSubtitleExtraction({ db }, payload.sessionId);
  };
}
