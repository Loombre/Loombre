// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-plugins.module.ts
//
// Lane W5's wiring, mirroring apps/server/src/settings/admin-settings.module.ts
// exactly: mounts AdminPluginsController against Lane W2's PluginsModule
// (services only, deliberately NOT imported by app.module.ts — see
// plugins.module.ts's own header, which explicitly hands this exact wiring
// decision to "whichever lane actually adds the controllers", i.e. this
// one), plus this lane's own two small services (AdminPluginPreviewService,
// AdminPluginGrantsService) and CommonModule directly (this controller's
// read paths — list/get — call @loombre/db's public barrel through
// DbProvider, exactly like PluginsModule's own services do).
//
// app.module.ts imports this module (not PluginsModule directly) — Nest
// dedupes PluginsModule's own providers to a single instance regardless of
// how many times it's imported along different paths, same
// belt-and-suspenders posture admin-settings.module.ts's header documents.
//
// Lane W5b adds AdminPluginPseudonymizationService (pseudonymization
// toggle) and the provider-chain admin surface (AdminLibraryProviderChainController
// + AdminLibraryProviderChainService, GET/PUT /admin/libraries/{id}/
// provider-chain) — see the latter's own header for why it's mounted here
// rather than alongside LibrariesController's other /libraries/{id}/*
// routes in apps/server/src/catalog/.
//
// Stash SQLite metadata sync, Lane C (S8/K14) adds
// AdminStashSyncReportController + AdminStashSyncReportService (GET
// /admin/libraries/{id}/stash-sync-report) — same
// under-/libraries/{id}/-but-plugins-area-owned rationale as the
// provider-chain surface immediately above.

import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module.js";
import { PluginsModule } from "./plugins.module.js";
import { AdminPluginsController } from "./admin-plugins.controller.js";
import { AdminPluginGrantsService } from "./admin-plugin-grants.service.js";
import { AdminPluginPreviewService } from "./admin-plugin-preview.service.js";
import { AdminPluginPseudonymizationService } from "./admin-plugin-pseudonymization.service.js";
import { AdminLibraryProviderChainController } from "./admin-library-provider-chain.controller.js";
import { AdminLibraryProviderChainService } from "./admin-library-provider-chain.service.js";
import { AdminStashSyncReportController } from "./admin-stash-sync-report.controller.js";
import { AdminStashSyncReportService } from "./admin-stash-sync-report.service.js";

@Module({
  imports: [CommonModule, PluginsModule],
  controllers: [AdminPluginsController, AdminLibraryProviderChainController, AdminStashSyncReportController],
  providers: [
    AdminPluginPreviewService,
    AdminPluginGrantsService,
    AdminPluginPseudonymizationService,
    AdminLibraryProviderChainService,
    AdminStashSyncReportService,
  ],
})
export class AdminPluginsControllersModule {}
