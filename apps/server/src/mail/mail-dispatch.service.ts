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
import { resolveLinkSealingSecret, sealLinkToken } from "@loombre/secrets";
import { JobQueueProvider } from "../common/job-queue.provider.js";
import { resolveAppPaths } from "../cli/app-paths.js";
import { MailConfigService } from "./mail-config.service.js";

export interface MailSendInput {
  templateId: "invite" | "password-reset" | "security-notice" | "email-in-use-notice" | "test";
  to: string;
  params: Record<string, string>;
  /** A live claim/reset token. Sealed here before enqueue (MRV-R1) — the
   *  persisted job payload never carries the plaintext or a pre-built
   *  actionUrl; the worker unseals and builds the URL at send time from
   *  the then-effective network.publicUrl. `params` must therefore NOT
   *  include actionUrl when this is set. */
  link?: { kind: "claim" | "reset"; token: string };
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

  /** Read-or-create, cached for the process lifetime — the key itself is
   *  immutable once minted, and re-resolving per send would hit the
   *  keyring on every mail. A rejected resolution is NOT cached (a locked
   *  keyring at first send must not poison every later one). */
  private sealingSecretPromise: Promise<string> | undefined;

  private resolveSealingSecret(): Promise<string> {
    if (this.sealingSecretPromise === undefined) {
      const { dataDir } = resolveAppPaths(process.platform, process.env);
      const promise = resolveLinkSealingSecret({ key: `${dataDir}/secrets/mail-link-sealing-key` });
      this.sealingSecretPromise = promise;
      promise.catch(() => {
        if (this.sealingSecretPromise === promise) this.sealingSecretPromise = undefined;
      });
    }
    return this.sealingSecretPromise;
  }

  async trySend(input: MailSendInput): Promise<MailSendResult> {
    if (!this.mailConfigService.isConfigured()) {
      return { dispatched: false, jobId: null };
    }

    try {
      // Seal BEFORE enqueue (MRV-R1): the plaintext token never reaches
      // pg-boss's tables. The server side resolves (creating on first
      // use) the shared sealing key, so the worker's unseal always finds
      // it. A sealing failure takes the same never-throws degradation as
      // an enqueue failure — no mail went out, the flow carries on.
      const link =
        input.link !== undefined
          ? { kind: input.link.kind, sealedToken: sealLinkToken(await this.resolveSealingSecret(), input.link.token) }
          : undefined;

      const jobId = await this.jobQueueProvider.queue.enqueue("mail-send", {
        templateId: input.templateId,
        to: input.to,
        params: input.params,
        ...(link !== undefined ? { link } : {}),
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
