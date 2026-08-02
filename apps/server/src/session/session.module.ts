// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { SystemController } from "./system.controller.js";
import { UsersMeController } from "./users-me.controller.js";
import { RestrictedController } from "./restricted.controller.js";
import { RestrictedZoneController } from "./restricted-zone.controller.js";
import { CommonModule } from "../common/common.module.js";
import { CommonSettingsModule } from "../common/common-settings.module.js";
import { MailModule } from "../mail/mail.module.js";
import { TokenService } from "./token.service.js";
import { RefreshTokenService } from "./refresh-token.service.js";
import { AuthRateLimiterService } from "./auth-rate-limiter.service.js";

/**
 * Session module: users, devices, auth, progress, events (docs/PLAN.md §3,
 * §5). Enforced boundary — must never import catalog/ or playback/;
 * dependency-cruiser fails the build if it does (D2). Communicates with the
 * other modules only via IDs over the DB and domain events.
 *
 * P1.14 (real auth): owns the auth/system/restricted-content controllers
 * plus the token/hash/refresh-token services.
 *
 * P2.1/P2.12: AuthRateLimiterService (in-memory token-bucket, per-IP for
 * login/refresh, per-user for restricted-unlock) is a session-scoped
 * provider, not moved to common/ — nothing outside the auth surface needs
 * IT (contrast AnomalyLogService below).
 *
 * G3 (STATE.md "Current-password re-auth on self-changes"): AnomalyLogService
 * RELOCATED out of this module to common/anomaly-log.service.ts, provided
 * by CommonSettingsModule instead of here — catalog/users.controller.ts now
 * logs CURRENT_PASSWORD_FAILURE too, and D2 forbids it importing anything
 * under session/. Still reachable here (UsersMeController/AuthController/
 * RestrictedController all use it) via the CommonSettingsModule import
 * below, unchanged from their point of view.
 *
 * P1.17: DbProvider/ViewerContextProvider moved OUT to
 * apps/server/src/common (a fourth, D2-neutral directory) so catalog/
 * playback controllers can use them without importing session/ directly —
 * see common/common.module.ts's header. SessionModule now imports
 * CommonModule and re-exports it, so existing importers of SessionModule
 * (GatewayModule) keep working unchanged.
 *
 * Addendum A, lane S3: also imports CommonSettingsModule (ViewerContextProvider
 * moved there — see that module's header — plus SystemController's
 * UpdateCheckService/SurfaceRateLimiterService reads, plus SettingsService
 * itself, re-exported by CommonSettingsModule, for AuthRateLimiterService/
 * AnomalyLogService's own A3 reads). Re-exported here (not just imported)
 * so GatewayModule/SetupModule — which only import SessionModule, never
 * CommonSettingsModule directly — keep getting ViewerContextProvider
 * (ws-broadcaster.service.ts) and SurfaceRateLimitGuard (setup.controller.ts)
 * exactly like they did when everything lived in plain CommonModule.
 *
 * STATE.md Stash run (S9): RestrictedZoneController (the dedicated zone's
 * home/browse/scene-detail/performers/studios/search reads) is a SEPARATE
 * controller class from RestrictedController, both mounted on the same
 * "restricted" prefix — parallel files rather than one growing file, same
 * organizational posture apps/server already uses elsewhere (e.g.
 * LibrariesController vs AdminLibraryProviderChainController both touching
 * "/libraries"). No new module import needed: it only uses DbProvider/
 * ViewerContextProvider, already available via CommonModule/
 * CommonSettingsModule above.
 *
 * STATE.md "Optional mail transport + invitation & reset flows" (Lane B):
 * imports MailModule (mail/mail.module.ts — a fourth D2-neutral directory,
 * same posture as CommonModule) for AuthController's forgot-password mail
 * dispatch and SystemController's `passwordResetAvailable` capability
 * read. Re-exported alongside CommonModule/CommonSettingsModule so
 * GatewayModule (which only imports SessionModule) is unaffected, and so
 * CatalogModule can import it directly for its own admin reset-password
 * action (users.controller.ts) without importing SessionModule (D2).
 */
@Module({
  imports: [CommonModule, CommonSettingsModule, MailModule],
  controllers: [AuthController, SystemController, UsersMeController, RestrictedController, RestrictedZoneController],
  providers: [TokenService, RefreshTokenService, AuthRateLimiterService],
  exports: [CommonModule, CommonSettingsModule, MailModule, TokenService],
})
export class SessionModule {}
