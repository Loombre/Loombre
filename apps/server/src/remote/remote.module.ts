// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote.module.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, Wave 0 — lane/remote-base).
// Sixth-plus sibling directory to catalog/playback/session/common/setup/
// invites/notices, same "a new top-level module is free to be its own
// directory" precedent those modules' own headers document.
//
// Seven controllers (RG15's fan-out split — each sub-area gets its own
// file so the 12 downstream lanes that replace these 501 shells touch
// disjoint files, not one 20-operation monolith):
//   - RemoteStateController      GET  /admin/remote/state (1 op)
//   - RemoteWireguardController  /admin/remote/wireguard/* (6 ops, R1-R3)
//   - RemoteTunnelController     /admin/remote/tunnel/* (6 ops, R4)
//   - RemoteDirectController     /admin/remote/direct/* (3 ops, R5)
//   - RemoteDiagnosisController  POST /admin/remote/diagnosis (1 op, RG11)
//   - RemoteProbesController     /admin/remote/probes* (2 ops, R6)
//   - ProbePageController        GET  /probe/{token} — the ONE public op
//     (R6/R9), separate file for its distinct auth posture (no requireAdmin
//     at all) and its own rate-limit guard usage.
//
// RemotePostureController (DRIFT DECISION #1, S1 lane, added after Wave 0):
// GET /admin/remote/posture — an EIGHTH controller, not one of the
// frozen seven (the op didn't exist at Wave-0 freeze). Real implementation
// from day one, no 501 interim. Backed by three providers under ./posture/
// — RemotePostureService (the pure-grading-plus-impure-gather composition),
// RemotePostureRegressionSchedulerService (RG4's periodic diff -> outbox-
// event background sweep, plugin-health-scheduler.service.ts's own timer
// shape), and three narrow cross-lane seam readers (ConnectorHealthReader/
// WireguardStatusReader/RemoteActivePathReader — see each file's own
// header for why they're defined locally rather than reused from T1/WG1,
// which haven't landed on this branch).
//
// DI hazard (standing lesson, STATE.md): CommonModule already PROVIDES
// DbProvider and CommonSettingsModule already provides SurfaceRateLimiterService/
// SurfaceRateLimitGuard — this module imports BOTH (invites.module.ts's own
// precedent for needing both) and re-provides NEITHER, or Nest mints a
// second module-scoped instance that silently diverges from the one every
// other controller/test spies on.
//
// RemoteDirectController ALSO injects SettingsService (RG12, lane D1) —
// reachable with NO further wiring here: CommonSettingsModule's own
// `exports` array re-exports SettingsModule itself (see that file's
// header), so any module that imports CommonSettingsModule (this one
// already does, for the rate-limit providers above) gets SettingsService
// for free. Confirmed empirically, not just by reading the export chain —
// apps/server/test/remote-direct.e2e.spec.ts boots the real AppModule and
// exercises this exact injection.
//
// Tunnel path providers (R4/R9/RG7, lane T1): TunnelProvider/
// ConnectorManager/RemoteActivePathReader are all ABSTRACT-CLASS DI tokens
// (see active-path-reader.ts's header for why) bound here to their default
// implementations — CloudflareTunnelProvider (R4's "thin-but-real" ONE
// implementation), NoopConnectorManager (T2, a LATER Batch-2 lane, replaces
// this binding with the real supervised-cloudflared-child implementation —
// STATE.md's own cross-lane seam note), RemoteActivePathResolverService
// (WG2, RG15 integration unification: the REAL cross-subsystem resolver —
// replaces WG1/T1's own NoopRemoteActivePathReader placeholder now that
// remote_wireguard_state/remote_tunnel_state/Direct's internal state all
// exist on the assembled tree, see remote-active-path.service.ts and
// packages/db/src/query/remote-active-path.ts). Swapping any of the three
// later is a ONE-LINE change here — no call site anywhere else names a
// concrete class.
//
// Lane P1 additions: ConnectorHealthReaderService (the freeze's own
// cross-lane-seams note — T2 wires the real cloudflared-connector read at
// integration; at that point it should read through lane T1's
// ConnectorManager token above rather than stay a parallel seam —
// integration unification note, STATE.md) and RemoteDnsResolverService
// (node:dns wiring for diagnoseRemote/getRemoteProbe's auto-diagnosis) are
// provided HERE, module-scoped, so RemoteDiagnosisController and
// RemoteProbesController share the SAME instances — required for
// apps/server/test/remote-probes.e2e.spec.ts's `vi.spyOn(app.get(...), ...)`
// seam-testing pattern (MailConfigService precedent) to actually intercept
// what the controllers call.
//
// Lane WG1 addition: RemoteWireguardService (./wireguard/) is a provider
// here (not its own nested module) — it needs the SAME DbProvider/
// SettingsService instances RemoteWireguardController's requireAdmin call
// and every other CommonModule/CommonSettingsModule consumer already
// share; a nested module would either re-provide them (the exact DI trap
// this file's own header warns about) or require yet another import
// chain for zero benefit, since nothing outside this module needs to
// resolve RemoteWireguardService directly today. HttpAdapterHost is
// injected straight from @nestjs/core — Nest provides it globally to
// every application, no module registration needed.
import { Module } from "@nestjs/common";
import { RemoteStateController } from "./remote-state.controller.js";
import { RemoteWireguardController } from "./remote-wireguard.controller.js";
import { RemoteTunnelController } from "./remote-tunnel.controller.js";
import { RemoteDirectController } from "./remote-direct.controller.js";
import { RemoteDiagnosisController } from "./remote-diagnosis.controller.js";
import { RemoteProbesController } from "./remote-probes.controller.js";
import { ProbePageController } from "./probe-page.controller.js";
import { ConnectorHealthReaderService } from "./connector-health.service.js";
import { RemoteDnsResolverService } from "./remote-dns-resolver.service.js";
import { CommonModule } from "../common/common.module.js";
import { CommonSettingsModule } from "../common/common-settings.module.js";
import { RemoteActivePathReader } from "./active-path-reader.js";
import { TunnelProvider } from "./tunnel/tunnel-provider.js";
import { CloudflareTunnelProvider } from "./tunnel/cloudflare-tunnel-provider.js";
import { ConnectorManager, NoopConnectorManager } from "./tunnel/connector-manager.js";
import { TunnelTokenService } from "./tunnel/tunnel-token.service.js";
import { RemoteTunnelService } from "./tunnel/remote-tunnel.service.js";
import { RemotePostureController } from "./remote-posture.controller.js";
import { RemotePostureService } from "./posture/remote-posture.service.js";
import { RemotePostureRegressionSchedulerService } from "./posture/remote-posture-regression.scheduler.js";
// S1's posture-side connector-health reader shares P1's class NAME but is a
// distinct class in a distinct file — aliased here so both can be provided.
// Integration unification (STATE.md ledger): when T2 lands the real
// connector, BOTH readers should route through the ConnectorManager token
// above instead of remaining parallel seams.
import { ConnectorHealthReaderService as PostureConnectorHealthReaderService } from "./posture/connector-health.reader.js";
import { WireguardStatusReaderService } from "./posture/wireguard-status.reader.js";
import { RemoteActivePathReaderService } from "./posture/active-path.reader.js";
import { RemoteWireguardService } from "./wireguard/remote-wireguard.service.js";
import { RemoteActivePathResolverService } from "./remote-active-path.service.js";

@Module({
  imports: [CommonModule, CommonSettingsModule],
  controllers: [
    RemoteStateController,
    RemoteWireguardController,
    RemoteTunnelController,
    RemoteDirectController,
    RemoteDiagnosisController,
    RemoteProbesController,
    ProbePageController,
    RemotePostureController,
  ],
  providers: [
    { provide: TunnelProvider, useClass: CloudflareTunnelProvider },
    { provide: ConnectorManager, useClass: NoopConnectorManager },
    // WG2 (STATE.md, RG15 integration unification): bound to the REAL
    // cross-subsystem resolver — replaces WG1/T1's NoopRemoteActivePathReader
    // default. NoopRemoteActivePathReader itself stays defined (active-path-
    // reader.ts) and importable for any future isolated unit test that wants
    // a controllable fake without hitting a real DB; nothing in this
    // assembled module binds it anymore.
    { provide: RemoteActivePathReader, useClass: RemoteActivePathResolverService },
    TunnelTokenService,
    RemoteTunnelService,
    ConnectorHealthReaderService,
    RemoteDnsResolverService,
    RemotePostureService,
    RemotePostureRegressionSchedulerService,
    PostureConnectorHealthReaderService,
    WireguardStatusReaderService,
    RemoteActivePathReaderService,
    RemoteWireguardService,
  ],
  // RemoteWireguardService exported (WG2): apps/server/src/catalog/
  // devices.controller.ts (a DIFFERENT top-level module, CatalogModule)
  // needs it for DELETE /devices/{id}'s RG3 gap-closure — the general
  // devices endpoint's WG teardown side effect for kind='remote' devices.
  // CatalogModule imports RemoteModule directly for this (same "import a
  // sibling feature module for one cross-cutting need" precedent as
  // CatalogModule already importing MailModule for UsersController's
  // reset-password mail action) — see catalog.module.ts's own header.
  exports: [ConnectorHealthReaderService, RemoteDnsResolverService, RemoteWireguardService],
  // NoopConnectorManager carries test-only introspection (getTestState())
  // e2e specs read via `app.get(ConnectorManager)` — no export needed for
  // that (same-module `app.get` works on any provider, exported or not).
})
export class RemoteModule {}
