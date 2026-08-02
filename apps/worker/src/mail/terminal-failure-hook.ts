// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/mail/terminal-failure-hook.ts
//
// Optional mail transport run (E6/M6): the 'mail-send' job's
// onTerminalFailure hook (packages/jobs/src/queue.ts's queue.work() seam),
// registered by apps/worker/src/index.ts alongside the 'mail-send' job
// handler — mirrors apps/worker/src/probe/terminal-failure-hook.ts's shape
// (a factory closing over `db`, returning the hook function).
//
// DELIBERATE DEVIATION from probe.failed's closed-code/no-free-text
// posture (already adjudicated, M6): the mail.failed event's `smtpError`
// carries the REAL error message verbatim — E6 requires the admin see the
// actual SMTP conversation failure (auth rejected, relay refused,
// timeout, a template render bug, ...) to fix their own mail
// configuration, which a closed enum cannot capture with the fidelity an
// admin needs. This is the reason packages/jobs's onTerminalFailure hook
// signature grew a third `jobId` parameter (queue.ts's own doc comment) —
// mail.failed's payload is contractually required to carry it
// (packages/contract/event-schemas/mail.failed.schema.json), unlike
// probe.failed which resolves its own subject row from `payload` alone.

import { withTransaction, writeEvent, type DbOrTx } from '@loombre/db/internal';
import type { MailSendJobPayload } from '@loombre/jobs';

export function createMailTerminalFailureHook(db: DbOrTx): (payload: MailSendJobPayload, error: unknown, jobId: string) => Promise<void> {
  return async (payload, error, jobId) => {
    const smtpError = error instanceof Error ? error.message : String(error);
    const tsMs = Date.now();

    await withTransaction(db, async (trx) => {
      await writeEvent(trx, {
        type: 'mail.failed',
        tsMs,
        actorUserId: null,
        payload: {
          templateId: payload.templateId,
          to: payload.to,
          smtpError,
          jobId,
        },
      });
    });
  };
}
