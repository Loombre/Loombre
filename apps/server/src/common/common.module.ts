// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";
import { DbProvider } from "./db.provider.js";
import { JobQueueProvider } from "./job-queue.provider.js";
import { HashService } from "./hash.service.js";
import { DeviceProfileValidatorService } from "./device-profile-validator.js";

/**
 * Shared infrastructure module: DbProvider (the one @loombre/db handle),
 * JobQueueProvider (the @loombre/jobs queue handle, D5/P1.15/P1.17), and
 * DeviceProfileValidatorService (Ajv-compiled-at-boot DeviceProfile schema
 * check, STATE.md P2.3/P2.12, docs/PLAYBACK.md §2.2).
 *
 * Deliberately a FOURTH directory, sibling to catalog/playback/session, not
 * inside any of them: the dependency-cruiser rules in .dependency-cruiser.cjs
 * only forbid the three PAIRWISE cross-imports (catalog<->session,
 * catalog<->playback, playback<->session) — "share only IDs" (D2). Every
 * feature module needs a DB handle, but ViewerContextProvider's five-gate
 * logic previously lived inside session/ (P1.14), which would make every
 * OTHER module that needs it either duplicate the logic or violate D2 by
 * importing session directly — moving it here (Phase 4 wave P1.17) let
 * catalog/playback import common/ without ever reaching into session/.
 *
 * Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration): ViewerContextProvider,
 * UpdateCheckService, SurfaceRateLimiterService, and SurfaceRateLimitGuard
 * MOVED OUT of this module into ./common-settings.module.ts (CommonSettingsModule)
 * — all four now need apps/server/src/settings/settings.service.ts's
 * SettingsService injected, and SettingsModule itself imports THIS module
 * (for DbProvider), so this module importing SettingsModule back would be a
 * literal circular module dependency (dependency-cruiser's 'no-circular'
 * rule fails the build on that shape even with NestJS's forwardRef() — see
 * common-settings.module.ts's header for the full reasoning). Every module
 * that previously got those four providers via CommonModule alone now
 * imports CommonSettingsModule alongside this one.
 */
@Module({
  providers: [DbProvider, JobQueueProvider, HashService, DeviceProfileValidatorService],
  exports: [DbProvider, JobQueueProvider, HashService, DeviceProfileValidatorService],
})
export class CommonModule {}
