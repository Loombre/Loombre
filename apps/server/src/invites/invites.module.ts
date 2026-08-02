// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/invites/invites.module.ts
//
// Fifth-plus sibling directory to catalog/playback/session/common/setup
// (see common/common.module.ts's header for why "sibling, not nested"
// matters — the D2 boundary only forbids the three PAIRWISE catalog<->
// playback<->session cross-imports, so a new top-level module is free to
// import session/ directly here, exactly like setup.module.ts does, for
// TokenService/RefreshTokenService — claim auto-login mints a real
// TokenPair the same way createFirstAdmin does).
//
// RefreshTokenService is listed in THIS module's own `providers` rather
// than pulled from SessionModule's exports, mirroring setup.module.ts's
// own documented reasoning exactly (SessionModule only exports
// [CommonModule, TokenService]; RefreshTokenService is a stateless class,
// so a second Nest-scoped instance behaves identically to reusing
// SessionModule's).
import { Module } from "@nestjs/common";
import { InvitesController } from "./invites.controller.js";
import { CommonModule } from "../common/common.module.js";
import { CommonSettingsModule } from "../common/common-settings.module.js";
import { SessionModule } from "../session/session.module.js";
import { RefreshTokenService } from "../session/refresh-token.service.js";
import { MailModule } from "../mail/mail.module.js";

// MailConfigService/MailDispatchService come from MailModule's exports —
// NOT re-listed in this module's own `providers`. Re-providing them here
// would mint second Nest-scoped instances, and unlike RefreshTokenService
// (stateless, duplicate-safe, see above) the mail pair is a cross-lane
// seam whose tests spy on the app-root instance (integration finding:
// a re-provided duplicate made the controller's calls invisible to
// `app.get(MailConfigService)` spies).
@Module({
  imports: [CommonModule, CommonSettingsModule, SessionModule, MailModule],
  controllers: [InvitesController],
  providers: [RefreshTokenService],
})
export class InvitesModule {}
