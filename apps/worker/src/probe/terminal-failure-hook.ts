// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/probe/terminal-failure-hook.ts
//
// Owner ledger L1, adjudication A-3: the probe job's onTerminalFailure
// hook (packages/jobs/src/queue.ts's queue.work() seam), registered by
// apps/worker/src/index.ts alongside the 'probe' job handler. This is the
// architecture-honest response to the brief's false premise that
// "ingestion already requires a successful ffprobe" — the scanner never
// runs ffprobe (apps/worker/src/scan/scanner.ts only enqueues a 'probe'
// job); a probe job that then exhausts its retries used to write NO probe
// columns at all (the catalog item stays visible, permanently "not
// ready") and surfaced only as a failed 'probe' row in the generic jobs
// ledger, with the path buried in last_error free text — no scan-report or
// library surface ever heard about it. This hook closes that gap: it
// writes an admin-only `probe.failed` outbox event (packages/contract/
// event-schemas/probe.failed.schema.json) so the same admin Libraries
// panel that already discloses skipped-unsupported-extension files (STATE
// .md H3) can disclose "files that were admitted but turned out unreadable"
// too — a DIFFERENT event, by design (see this file's own module docs and
// the freeze report: scan.completed's schema is untouched).
//
// Looks up the media_files row named by the failed job's payload — the
// SAME lookup runProbe() (./consumer.ts) itself does at the top of its own
// run — to resolve {path, libraryId} (via the owning catalog_items row).
// If either row is gone (deleted mid-flight, e.g. the scanner's
// hard-cascade sweep removed it between the job failing and this hook
// running — or, for the catalog item, only ever inside an in-flight
// transaction, since media_files.item_id is NOT NULL REFERENCES
// catalog_items(id) ON DELETE CASCADE), this is a no-op (logged locally,
// never an event) — no orphan event ever points at an id that no longer
// exists.
import {
  getMediaFileById,
  getCatalogItemById,
  writeEvent,
  withTransaction,
  type DbOrTx,
} from "@loombre/db/internal";
import type { ProbeJobPayload } from "@loombre/jobs";
import { ProbeError, type ProbeErrorCode } from "./errors.js";

/** ProbeError's six closed codes, plus "unknown" for a thrown value that
 *  isn't a ProbeError at all — defensive only: runProbe's one documented
 *  failure mode IS always a ProbeError (see consumer.ts's own header), but
 *  this hook must never itself throw/misbehave no matter what the queue
 *  hands it. Mirrors packages/contract/event-schemas/probe.failed.
 *  schema.json's `code` enum exactly. */
export type ProbeFailedEventCode = ProbeErrorCode | "unknown";

function resolveCode(error: unknown): ProbeFailedEventCode {
  return error instanceof ProbeError ? error.code : "unknown";
}

/**
 * Builds the queue's onTerminalFailure hook for the 'probe' job type,
 * bound to `db` (the worker's shared connection — see apps/worker/src/
 * index.ts's registration site). Returned function matches packages/jobs/
 * src/queue.ts's WorkOptions['onTerminalFailure'] shape exactly.
 */
export function createProbeTerminalFailureHook(
  db: DbOrTx,
): (payload: ProbeJobPayload, error: unknown) => Promise<void> {
  return async (payload, error) => {
    const file = await getMediaFileById(db, payload.mediaFileId);
    if (!file) {
      console.warn(
        `[worker] probe.failed hook: media_files ${payload.mediaFileId} no longer exists — skipping event (no orphan)`,
      );
      return;
    }

    const item = await getCatalogItemById(db, file.item_id);
    if (!item) {
      // Unreachable via a real deletion today (media_files.item_id is NOT
      // NULL REFERENCES catalog_items(id) ON DELETE CASCADE — deleting the
      // item takes the file with it, which the guard above already
      // catches), kept for defense in depth rather than assuming the FK
      // can never change shape.
      console.warn(
        `[worker] probe.failed hook: catalog_items ${file.item_id} no longer exists — skipping event (no orphan)`,
      );
      return;
    }

    const code = resolveCode(error);
    const tsMs = Date.now();

    await withTransaction(db, async (trx) => {
      await writeEvent(trx, {
        type: "probe.failed",
        tsMs,
        actorUserId: null,
        payload: {
          mediaFileId: file.id,
          libraryId: item.library_id,
          path: file.path,
          code,
        },
      });
    });
  };
}
