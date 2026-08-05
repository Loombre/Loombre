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
import { Module } from "@nestjs/common";
import { RemoteStateController } from "./remote-state.controller.js";
import { RemoteWireguardController } from "./remote-wireguard.controller.js";
import { RemoteTunnelController } from "./remote-tunnel.controller.js";
import { RemoteDirectController } from "./remote-direct.controller.js";
import { RemoteDiagnosisController } from "./remote-diagnosis.controller.js";
import { RemoteProbesController } from "./remote-probes.controller.js";
import { ProbePageController } from "./probe-page.controller.js";
import { CommonModule } from "../common/common.module.js";
import { CommonSettingsModule } from "../common/common-settings.module.js";

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
  ],
})
export class RemoteModule {}
