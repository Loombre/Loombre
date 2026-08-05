// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/connector-health.service.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" — the freeze's own cross-lane-seams
// note (Orchestrator freeze ground-truth + Batch-1 dispatch): "T2 (batch
// 2) provides the real implementation — integration wires it." This is
// P1's own narrow "port" (Lane P1 mission item 5: "define your own narrow
// ConnectorHealthReader port with a default returning 'unknown'").
//
// A plain @Injectable() class, NOT an interface + DI-token pair — mirrors
// this codebase's ONLY precedent for a cross-lane "stub now, real
// implementation lands later" seam, apps/server/src/mail/
// mail-config.service.ts (that file's own header: "Lane C wires the real
// registry-backed logic" — the SAME class gained real methods later rather
// than being swapped for a different provider). This repo has no existing
// custom-DI-token pattern anywhere (grepped apps/server/src for @Inject(
// — zero hits), so introducing one here for a single-method seam would be
// a new pattern for no benefit; T2 either extends this class in place
// (adds a real cloudflared-connector-status read) or has RemoteModule
// provide a different class for this same token — Nest's class-as-token
// DI makes either option free.
//
// "unknown" is a deliberate NO-OP default: apps/server/src/remote/
// diagnose-reachability.ts's Tunnel-path short-circuit only fires on
// "down"/"degraded" — "unknown" (and "healthy") always fall through to
// ordinary WAN classification, so today's diagnosis output for the Tunnel
// path is UNCHANGED by this seam existing at all, until T2 wires a real
// connector-status read in.

import { Injectable } from "@nestjs/common";

export type ConnectorHealth = "healthy" | "degraded" | "down" | "unknown";

@Injectable()
export class ConnectorHealthReaderService {
  async read(): Promise<ConnectorHealth> {
    return "unknown";
  }
}
