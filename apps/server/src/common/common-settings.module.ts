// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/common-settings.module.ts
//
// Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): the
// common/ providers that need SettingsService injected — ViewerContextProvider
// (restricted.enabled/majorityAgeYears), UpdateCheckService (updateCheck.mode),
// SurfaceRateLimiterService (rateLimit.capabilities/mediaToken/export/setup),
// and SurfaceRateLimitGuard (constructor-depends on SurfaceRateLimiterService)
// — live in a SEPARATE module from CommonModule rather than importing
// SettingsModule directly into common.module.ts. Reason, structural not
// stylistic: apps/server/src/settings/settings.module.ts (lane S1, frozen
// for this lane) imports CommonModule for DbProvider; if CommonModule then
// imported SettingsModule back, that is a literal file-level import cycle
// (common.module.ts -> settings.module.ts -> common.module.ts) —
// dependency-cruiser's 'no-circular' rule (severity: error) fails the
// build on exactly this shape regardless of NestJS's own forwardRef()
// escape hatch, which only defers the JS reference, not the static import
// statement dependency-cruiser's graph walk sees. Splitting the
// SettingsService-needing providers into their own downstream module
// (importing BOTH CommonModule and SettingsModule, neither of which import
// IT back) breaks the cycle by construction.
//
// Every module that used to get these providers via CommonModule alone
// (catalog.module.ts, playback.module.ts, session.module.ts) now imports
// this module ALONGSIDE CommonModule — see each of those files' own
// updated header comments. Also re-exports SettingsModule itself so a
// consuming module's OWN local providers (e.g. playback's
// PlaybackSessionSweeperService, session's AuthRateLimiterService) can
// inject SettingsService directly without a separate explicit
// SettingsModule import.
//
// G3/G4 (STATE.md "Current-password re-auth on self-changes"):
// AnomalyLogService and CurrentPasswordRateLimiterService joined this
// module rather than session/'s own AuthRateLimiterService/
// anomaly-log.service.ts precedent — BOTH are now reachable from
// catalog/users.controller.ts (updateMe) AND session/users-me.controller.ts
// (putRestricted), and D2 forbids catalog importing anything under
// session/. Same "escape valve" reasoning as the four pre-existing
// providers above.

import { Module } from "@nestjs/common";
import { CommonModule } from "./common.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ViewerContextProvider } from "./viewer-context.provider.js";
import { UpdateCheckService } from "./update-check/update-check.service.js";
import { SurfaceRateLimiterService } from "./surface-rate-limiter.service.js";
import { SurfaceRateLimitGuard } from "./rate-limit.guard.js";
import { AnomalyLogService } from "./anomaly-log.service.js";
import { CurrentPasswordRateLimiterService } from "./current-password-rate-limiter.service.js";

@Module({
  imports: [CommonModule, SettingsModule],
  providers: [
    ViewerContextProvider,
    UpdateCheckService,
    SurfaceRateLimiterService,
    SurfaceRateLimitGuard,
    AnomalyLogService,
    CurrentPasswordRateLimiterService,
  ],
  exports: [
    ViewerContextProvider,
    UpdateCheckService,
    SurfaceRateLimiterService,
    SurfaceRateLimitGuard,
    AnomalyLogService,
    CurrentPasswordRateLimiterService,
    SettingsModule,
  ],
})
export class CommonSettingsModule {}
