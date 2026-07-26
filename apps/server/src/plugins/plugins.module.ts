// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/plugins.module.ts
//
// LD2(b): "apps/server/src/plugins/ — services-only NestJS module (
// PluginsModule) wiring DB + keyring + plugin-host: registration/
// lifecycle/health services." Mounts NO controllers/routes — W5 owns the
// admin API and imports this module wherever it wires its own controller
// module, exactly like apps/server/src/settings/settings.module.ts's own
// header documents for the identical reason ("deliberately NOT imported by
// app.module.ts yet ... wiring the live boot-time DB load into the whole
// app's test surface is left to whichever lane actually adds the
// controllers"). See this lane's final report for the explicit statement
// that app.module.ts is untouched — apps/server/test/conformance.spec.ts's
// mounted-route walk stays green because nothing here ever gets imported
// into the app's bootstrap.

import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module.js";
import { PluginHealthService } from "./plugin-health.service.js";
import { PluginHealthSchedulerService } from "./plugin-health-scheduler.service.js";
import { PluginRegistrationService } from "./plugin-registration.service.js";
import { PluginLifecycleService } from "./plugin-lifecycle.service.js";

// M-8 fix wave: PluginHealthSchedulerService is a background-timer
// provider (OnApplicationBootstrap) — nothing else needs to inject it, but
// NestJS instantiates every registered provider and runs its lifecycle
// hooks regardless (same "provider needs no consumer to be live" posture
// apps/server/src/common/update-check/update-check.service.ts's own
// wiring already relies on).
@Module({
  imports: [CommonModule],
  providers: [PluginHealthService, PluginHealthSchedulerService, PluginRegistrationService, PluginLifecycleService],
  exports: [PluginHealthService, PluginRegistrationService, PluginLifecycleService],
})
export class PluginsModule {}
