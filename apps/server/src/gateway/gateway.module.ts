// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { HealthController } from "./health.controller.js";
import { NotFoundController } from "./not-found.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { ProblemJsonExceptionFilter } from "./problem-json.filter.js";
import { WsBroadcasterService } from "./ws-broadcaster.service.js";
import { SessionModule } from "../session/session.module.js";

/**
 * API Gateway module: auth, rate limits, query-guard injection, websockets
 * (docs/PLAN.md §3). Wave-2 (STATE.md D21) added the global unauthenticated
 * wall; P1.14 upgraded AuthGuard to real JWT verification, which needs
 * SessionModule's TokenService — imported here for DI only (this does NOT
 * violate the catalog/playback/session cross-import ban: that rule scopes
 * to session importing catalog/playback, not gateway importing session).
 *
 * HealthController is listed before NotFoundController so the literal
 * /healthz route matches first. NotFoundController's `*splat` catch-all
 * must be the LAST route Nest mounts, or it would shadow every real
 * controller registered after it (Express matches routes in registration
 * order) — see app.module.ts for why GatewayModule is imported last.
 */
@Module({
  imports: [SessionModule],
  controllers: [HealthController, NotFoundController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemJsonExceptionFilter },
    WsBroadcasterService,
  ],
})
export class GatewayModule {}
