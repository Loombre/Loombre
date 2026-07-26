// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `queue.work('transcode', ...)` entry point (packages/jobs). Deliberately
 * thin — everything is runner.ts's job; this file exists only to give
 * apps/worker/src/index.ts a single, DI-friendly call site matching every
 * other consumer wiring in this package (e.g. `runProbe({db}, payload)`).
 */
import type { DbOrTx } from "@loombre/db/internal";
import type { TranscodeJobPayload } from "@loombre/jobs";
import { runTranscodeSession } from "./runner.js";

export function createTranscodeConsumerHandler(db: DbOrTx): (payload: TranscodeJobPayload) => Promise<void> {
  return async (payload: TranscodeJobPayload): Promise<void> => {
    await runTranscodeSession({ db }, payload.sessionId);
  };
}
