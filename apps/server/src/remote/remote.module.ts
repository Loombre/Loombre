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
import { Module } from "@nestjs/common";
import { RemoteStateController } from "./remote-state.controller.js";
import { RemoteWireguardController } from "./remote-wireguard.controller.js";
import { RemoteTunnelController } from "./remote-tunnel.controller.js";
import { RemoteDirectController } from "./remote-direct.controller.js";
import { RemoteDiagnosisController } from "./remote-diagnosis.controller.js";
import { RemoteProbesController } from "./remote-probes.controller.js";
import { ProbePageController } from "./probe-page.controller.js";
import { RemotePostureController } from "./remote-posture.controller.js";
import { CommonModule } from "../common/common.module.js";
import { CommonSettingsModule } from "../common/common-settings.module.js";
import { RemotePostureService } from "./posture/remote-posture.service.js";
import { RemotePostureRegressionSchedulerService } from "./posture/remote-posture-regression.scheduler.js";
import { ConnectorHealthReaderService } from "./posture/connector-health.reader.js";
import { WireguardStatusReaderService } from "./posture/wireguard-status.reader.js";
import { RemoteActivePathReaderService } from "./posture/active-path.reader.js";

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
    RemotePostureService,
    RemotePostureRegressionSchedulerService,
    ConnectorHealthReaderService,
    WireguardStatusReaderService,
    RemoteActivePathReaderService,
  ],
})
export class RemoteModule {}
