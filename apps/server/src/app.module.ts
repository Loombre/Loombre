// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";
import { GatewayModule } from "./gateway/gateway.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { PlaybackModule } from "./playback/playback.module.js";
import { SessionModule } from "./session/session.module.js";
import { SetupModule } from "./setup/setup.module.js";
import { InvitesModule } from "./invites/invites.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { AdminSettingsControllersModule } from "./settings/admin-settings.module.js";
import { AdminPluginsControllersModule } from "./plugins/admin-plugins.module.js";
import { MailModule } from "./mail/mail.module.js";

/**
 * Root module. Catalog / Playback / Session are enforced boundaries
 * (docs/PLAN.md §3, CLAUDE.md invariant... D2): they share only IDs and must
 * never import one another directly — dependency-cruiser fails the build if
 * they do. Gateway wires them together plus cross-cutting concerns (auth,
 * rate limits, websockets — Phase 1+).
 *
 * Import order matters here: GatewayModule owns NotFoundController's
 * `*splat` catch-all (not-found.controller.ts), which must be the LAST
 * route Express matches or it would shadow every real controller mounted
 * after it. Listing GatewayModule last (it also imports SessionModule
 * itself, so this is belt-and-suspenders, not the only thing making it
 * work) keeps that invariant obvious from this file alone rather than
 * relying on Nest's module-scan order.
 *
 * SetupModule (STATE.md P4.6/P4.10, lane C): GET /setup/state and POST
 * /setup/first-admin, both public (see gateway/auth.guard.ts's
 * PUBLIC_ROUTES). Listed before GatewayModule for the same catch-all-must-
 * be-last reason as everything else here.
 *
 * InvitesModule ("Optional mail transport + invitation & reset flows", E2,
 * Lane A): POST/GET /invites, DELETE /invites/{id} (admin) plus the public
 * GET/POST /invites/claim/{token} pair (F1 fix wave: moved off bare
 * /claim/{token}, which collides with the Next.js web page route — see
 * invites/invites.controller.ts's header) — see gateway/auth.guard.ts's
 * PUBLIC_ROUTE_PATTERNS for the claim routes' public-but-dynamic-path
 * matching. Listed before GatewayModule for the same catch-all-must-be-
 * last reason as everything else here.
 *
 * SettingsModule / AdminSettingsControllersModule (STATE.md Addendum A,
 * decision A6, lane S2): admin-configurable server settings. SettingsModule
 * (lane S1's services — SettingsService's OnApplicationBootstrap hook does
 * the boot-time server_settings load + effective-value resolution)
 * previously existed unwired; this is that wiring. AdminSettingsController-
 * sModule holds the actual GET/PUT/DELETE controllers this lane adds. Both
 * listed before GatewayModule for the same catch-all-must-be-last reason.
 *
 * AdminPluginsControllersModule (LPP v1, Lane W5): the admin Plugins
 * surface — packages/plugin-protocol/spec/lpp-v1.md is the frozen wire
 * contract; Lane W2's apps/server/src/plugins/plugins.module.ts (services
 * only) was landed deliberately UNWIRED from this file (see that module's
 * own header — "W5 owns the admin API and imports this module wherever it
 * wires its own controller module"). This is that wiring, mirroring
 * AdminSettingsControllersModule's own shape exactly. Listed before
 * GatewayModule for the same catch-all-must-be-last reason as everything
 * else here.
 *
 * MailModule (optional mail transport run, M7): MailConfigService/
 * MailDispatchService (FROZEN cross-lane seams — invitations/recovery
 * inject them directly) + the admin mail credentials/test-send controller.
 * Listed before GatewayModule for the same catch-all-must-be-last reason
 * as everything else here — route order matters.
 */
@Module({
  imports: [
    SessionModule,
    CatalogModule,
    PlaybackModule,
    SetupModule,
    InvitesModule,
    SettingsModule,
    AdminSettingsControllersModule,
    AdminPluginsControllersModule,
    MailModule,
    GatewayModule,
  ],
})
export class AppModule {}
