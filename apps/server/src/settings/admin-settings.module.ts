// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/admin-settings.module.ts
//
// STATE.md Addendum A, lane S2's wiring: mounts AdminSettingsController +
// AdminProviderKeysController against lane S1's SettingsModule (services
// only, FROZEN — see settings.module.ts's own header, which explicitly
// hands this exact wiring decision to "whichever lane actually adds the
// controllers"). Kept as its own module rather than adding a `controllers:`
// array directly to settings.module.ts, so that file stays byte-for-byte
// what S1 landed. app.module.ts imports both this module AND SettingsModule
// directly (settings.module.ts header's own phrasing: "adds THIS module to
// app.module.ts's imports alongside its own controller module") — harmless
// belt-and-suspenders, Nest dedupes a module imported more than once via
// different paths to a single instance.

import { Module } from "@nestjs/common";
import { SettingsModule } from "./settings.module.js";
import { AdminSettingsController } from "./admin-settings.controller.js";
import { AdminProviderKeysController } from "./admin-provider-keys.controller.js";

@Module({
  imports: [SettingsModule],
  controllers: [AdminSettingsController, AdminProviderKeysController],
})
export class AdminSettingsControllersModule {}
