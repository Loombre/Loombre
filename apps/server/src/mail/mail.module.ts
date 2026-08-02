// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/mail/mail.module.ts
//
// Optional mail transport run (M7): wires MailConfigService +
// MailDispatchService (both FROZEN names/paths — STATE.md M7/M8, lanes
// A/B inject them directly) alongside AdminMailController (PUT/DELETE
// /admin/mail/credentials, POST /admin/mail/test-send). Imports
// SettingsModule (for SettingsService — MailConfigService's dependency —
// and MailCredentialsService, settings/mail-credentials.service.ts's A9
// sibling of provider-keys.service.ts) and CommonModule (for
// JobQueueProvider/DbProvider). app.module.ts imports this module BEFORE
// GatewayModule, same "catch-all must be last" reasoning every other
// feature module here follows.

import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { MailConfigService } from "./mail-config.service.js";
import { MailDispatchService } from "./mail-dispatch.service.js";
import { AdminMailController } from "./admin-mail.controller.js";

@Module({
  imports: [CommonModule, SettingsModule],
  controllers: [AdminMailController],
  providers: [MailConfigService, MailDispatchService],
  exports: [MailConfigService, MailDispatchService],
})
export class MailModule {}
