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
// a new pattern for no benefit; T2 EXTENDS this class in place (below)
// rather than having RemoteModule provide a different class for this same
// token — both were "free" per the header above, extending in place keeps
// this file's own doc comments (used throughout diagnose-reachability.ts)
// accurate without a second file to keep in sync.
//
// T2 (lane T2, batch 2, RG7): reads through T1's `ConnectorManager` token
// (tunnel/connector-manager.ts) instead of hardcoding "unknown" — the
// seam-unification integration note this file's header used to describe
// as future work. `ConnectorManager.health().state` is T1's OWN 5-value
// vocabulary (stopped|starting|healthy|unhealthy|backoff); this class's
// public API (the 4-value ConnectorHealth below, the `read()` signature,
// the class name/constructor-token identity) is UNCHANGED so every
// existing consumer (diagnose-reachability.ts, remote-probes.controller.ts,
// remote-diagnosis.controller.ts) and every existing test that spies on
// `.read()` directly (remote-probes.e2e.spec.ts) keeps working untouched.
//
// Mapping (this lane's own adjudication — diagnose-reachability.ts's short-
// circuit only inspects "down"/"degraded", so ONLY those two values change
// behavior; "healthy"/"unknown" both still fall through to WAN
// classification exactly as before):
//   healthy    -> healthy   (readiness confirmed, process alive)
//   starting   -> unknown   (mid-boot; not yet proven either way — same
//                            "don't jump to conclusions, fall through"
//                            posture "unknown" always had here)
//   unhealthy  -> degraded  (process alive but reporting trouble —
//                            diagnosisGuidance's own "connectorUnhealthy"
//                            text: "running but reporting a degraded or
//                            error state")
//   backoff    -> down      (the child has actually exited and nothing is
//                            currently serving traffic — diagnosisGuidance's
//                            "tunnelDown" text: "process is not running" is
//                            literally true during backoff, unlike the
//                            posture card's OWN backoff->degraded choice,
//                            see posture/connector-health.reader.ts's
//                            header for why that reader maps backoff
//                            differently — two different consumers, two
//                            legitimately different honest framings of the
//                            same underlying state)
//   stopped    -> down      (never started, or a deliberate stop() — no
//                            traffic possible)

import { Injectable } from "@nestjs/common";
import { ConnectorManager, type ConnectorState } from "./tunnel/connector-manager.js";

export type ConnectorHealth = "healthy" | "degraded" | "down" | "unknown";

/** Exported for direct unit coverage of every ConnectorState -> ConnectorHealth
 *  mapping without needing a full ConnectorManager. */
export function mapConnectorStateToDiagnosisHealth(state: ConnectorState): ConnectorHealth {
  switch (state) {
    case "healthy":
      return "healthy";
    case "starting":
      return "unknown";
    case "unhealthy":
      return "degraded";
    case "backoff":
      return "down";
    case "stopped":
      return "down";
  }
}

@Injectable()
export class ConnectorHealthReaderService {
  constructor(private readonly connectorManager: ConnectorManager) {}

  async read(): Promise<ConnectorHealth> {
    return mapConnectorStateToDiagnosisHealth(this.connectorManager.health().state);
  }
}
