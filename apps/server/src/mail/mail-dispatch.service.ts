// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/mail/mail-dispatch.service.ts
//
// Optional mail transport run, M7: FROZEN cross-lane seam #1 —
// `MailDispatchService.trySend()`. Lanes A/B (invitations, password
// recovery) call this instead of enqueueing a `mail-send` job themselves —
// the frozen signature is the WHOLE contract between this lane and theirs,
// so they can stub it out and build against it before this lane lands
// (STATE.md M7: "A/B never enqueue directly").
//
// E6, the one law this method exists to enforce: mail can never block a
// flow. trySend() NEVER throws — an invite creation, a reset issuance, or
// any other caller's request thread must complete exactly as it would if
// mail didn't exist at all. Two distinct "didn't send" cases collapse to
// the SAME {dispatched:false, jobId:null} shape on purpose (a caller has
// no legitimate reason to branch differently on "mail isn't configured"
// vs. "the queue rejected the enqueue" — both mean "no mail went out,
// carry on"):
//   1. MailConfigService.isConfigured() is false (M8) — never even
//      attempts to enqueue.
//   2. queue.enqueue() itself throws (a down job queue, a malformed
//      payload, anything) — caught here, logged, swallowed.
//
// Deliberately NOT used by the admin test-send action (POST
// /admin/mail/test-send, apps/server/src/mail/admin-mail.controller.ts):
// that surface is an explicit admin action against a real problem+json
// error contract (409 when unconfigured) and a caller-chosen retryLimit
// override (0, no retries) — both incompatible with trySend()'s frozen
// "never throws, always the queue's own default retry posture" shape. See
// that controller's own header.

import { Injectable, Logger } from "@nestjs/common";
import { JobQueueProvider } from "../common/job-queue.provider.js";
import { MailConfigService } from "./mail-config.service.js";

export interface MailSendInput {
  templateId: "invite" | "password-reset" | "security-notice" | "test";
  to: string;
  params: Record<string, string>;
}

export interface MailSendResult {
  dispatched: boolean;
  jobId: string | null;
}

@Injectable()
export class MailDispatchService {
  private readonly logger = new Logger(MailDispatchService.name);

  constructor(
    private readonly mailConfigService: MailConfigService,
    private readonly jobQueueProvider: JobQueueProvider,
  ) {}

  async trySend(input: MailSendInput): Promise<MailSendResult> {
    if (!this.mailConfigService.isConfigured()) {
      return { dispatched: false, jobId: null };
    }

    try {
      const jobId = await this.jobQueueProvider.queue.enqueue("mail-send", {
        templateId: input.templateId,
        to: input.to,
        params: input.params,
      });
      return { dispatched: true, jobId };
    } catch (err) {
      this.logger.warn(
        `mail-send enqueue failed for template "${input.templateId}" — degrading to not-dispatched (E6: mail never blocks a flow): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { dispatched: false, jobId: null };
    }
  }
}
