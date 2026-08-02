// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/mail/admin-mail.controller.ts
//
// Optional mail transport run: PUT/DELETE /admin/mail/credentials (A9
// write-only, delegates straight to settings/mail-credentials.service.ts —
// same "controller discards the DTO the service still returns" shape as
// admin-provider-keys.controller.ts, since GET never exists for a
// credential VALUE anywhere; status rides on GET /admin/settings's
// additive `mailCredentials` field only) and POST /admin/mail/test-send
// (M6/M11).
//
// test-send's ordering, each check independently load-bearing, same
// discipline as settings.service.ts's updateSetting():
//   1. A10 live-admin re-verify (403) — first, before revealing anything
//      about mail's configuration state.
//   2. Mail not configured (409, M8's isConfigured() definition) — a
//      precondition-of-server-state conflict, same class of check as the
//      settings env-pin 409 (problem.exception.ts's `conflict()` doc
//      comment), NOT a body-validation failure: the request body may be
//      perfectly well-formed and it still cannot be fulfilled.
//   3. `to` address shape (422) — after the configuration check, so a
//      bodyless/malformed request against an ALREADY-unconfigured server
//      still reports the more actionable "mail isn't set up" first.
//   4. Enqueue a real `mail-send` job (never inline — CLAUDE.md invariant
//      6), template "test", retryLimit override 0 (M7's per-send retryLimit
//      override — a test send is a one-shot probe, not something worth
//      pg-boss's default 4-attempt backoff for).
//
// Deliberately does NOT go through MailDispatchService.trySend(): that
// method's frozen contract never throws and always uses mail-send's
// default retry posture — neither fits an explicit admin action that must
// surface "mail isn't configured" as a real error and wants zero retries.

import { Body, Controller, Delete, HttpCode, HttpStatus, Post, Put, Req } from "@nestjs/common";
import { isValidEmailFormat, nowMs as clockNowMs } from "@loombre/shared";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { JobQueueProvider } from "../common/job-queue.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { conflict, unprocessableEntity } from "../gateway/problem.exception.js";
import { MailCredentialsService } from "../settings/mail-credentials.service.js";
import { MailConfigService } from "./mail-config.service.js";

interface TestSendMailResponseDto {
  jobId: string;
}

@Controller("admin/mail")
export class AdminMailController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly jobQueueProvider: JobQueueProvider,
    private readonly mailCredentialsService: MailCredentialsService,
    private readonly mailConfigService: MailConfigService,
  ) {}

  @Put("credentials")
  @HttpCode(HttpStatus.NO_CONTENT)
  async setCredentials(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest): Promise<void> {
    const body = rawBody ?? {};
    // Coerced (never thrown on a missing/non-string body field), same
    // reasoning as setAdminProviderKey — the service's own ordered checks
    // (requireLiveAdmin 403 -> env-pin 409 -> empty-field 422) must run in
    // full regardless of what the body looks like.
    const username = typeof body["username"] === "string" ? body["username"] : "";
    const password = typeof body["password"] === "string" ? body["password"] : "";
    await this.mailCredentialsService.setCredentials({
      username,
      password,
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }

  @Delete("credentials")
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearCredentials(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.mailCredentialsService.clearCredentials({
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }

  @Post("test-send")
  @HttpCode(HttpStatus.ACCEPTED)
  async testSend(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest): Promise<TestSendMailResponseDto> {
    const instancePath = req.originalUrl;
    await requireLiveAdmin(this.dbProvider.db, req.user!.userId, instancePath);

    if (!this.mailConfigService.isConfigured()) {
      throw conflict(
        "Mail is not configured yet — set a mail server address, from-address, and public web address first (Settings > Mail).",
        instancePath,
      );
    }

    const body = rawBody ?? {};
    const to = typeof body["to"] === "string" ? body["to"].trim() : "";
    // R-F4 (opus adversarial review, fix wave): shared with users.
    // controller.ts / invites.controller.ts — one canonical email-format
    // check, not a third hand-rolled regex.
    if (to.length === 0 || !isValidEmailFormat(to)) {
      throw unprocessableEntity('"to" must be a valid email address.', instancePath);
    }

    const jobId = await this.jobQueueProvider.queue.enqueue(
      "mail-send",
      { templateId: "test", to, params: {} },
      { retryLimit: 0 },
    );

    return { jobId };
  }
}
