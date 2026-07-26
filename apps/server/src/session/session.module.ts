// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { SystemController } from "./system.controller.js";
import { UsersMeController } from "./users-me.controller.js";
import { RestrictedController } from "./restricted.controller.js";
import { CommonModule } from "../common/common.module.js";
import { CommonSettingsModule } from "../common/common-settings.module.js";
import { TokenService } from "./token.service.js";
import { RefreshTokenService } from "./refresh-token.service.js";
import { AuthRateLimiterService } from "./auth-rate-limiter.service.js";
import { AnomalyLogService } from "./anomaly-log.service.js";

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
 * login/refresh, per-user for restricted-unlock) and AnomalyLogService
 * (fail2ban-compatible local log line) are session-scoped providers, not
 * moved to common/ — nothing outside the auth surface needs them.
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
 */
@Module({
  imports: [CommonModule, CommonSettingsModule],
  controllers: [AuthController, SystemController, UsersMeController, RestrictedController],
  providers: [TokenService, RefreshTokenService, AuthRateLimiterService, AnomalyLogService],
  exports: [CommonModule, CommonSettingsModule, TokenService],
})
export class SessionModule {}
