// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/settings.module.ts
//
// STATE.md Addendum A, lane S1's deliverable: SettingsService +
// ProviderKeysService, DI-ready for lane S2's admin settings controller(s).
// Imports CommonModule for DbProvider (same pattern SessionModule/
// CatalogModule/PlaybackModule already use — see session.module.ts's
// header) rather than constructing a second connection pool.
//
// Deliberately NOT imported by app.module.ts yet — see settings.service.ts's
// header for why wiring the live boot-time DB load into the whole app's
// test surface is left to whichever lane actually adds the controllers
// (lane S2 imports this module wherever GET/PUT /v1/admin/settings and
// /v1/admin/provider-keys end up living, then adds THIS module to
// app.module.ts's imports alongside its own controller module).

import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module.js";
import { SettingsService } from "./settings.service.js";
import { ProviderKeysService } from "./provider-keys.service.js";

@Module({
  imports: [CommonModule],
  providers: [SettingsService, ProviderKeysService],
  exports: [SettingsService, ProviderKeysService],
})
export class SettingsModule {}
