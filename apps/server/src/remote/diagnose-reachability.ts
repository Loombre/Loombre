// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/diagnose-reachability.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5/R6/RG11, Lane P1 mission item 5).
// The I/O-aware orchestration layer BOTH diagnoseRemote
// (remote-diagnosis.controller.ts) and getRemoteProbe's own
// auto-diagnosis-on-expiry (remote-probes.controller.ts) call — so the two
// surfaces can never drift apart on how a failed probe gets classified.
//
// Sequence:
//   1. Tunnel-path short-circuit FIRST (the freeze's own diagnosis note:
//      "consult connector health BEFORE WAN classification") — ONLY when
//      `path === "tunnel"`; "healthy"/"unknown" both fall through to
//      ordinary WAN classification (connector-health.service.ts's header
//      explains why "unknown", today's only real value, is a no-op).
//   2. Resolve `expectedEndpoint`'s hostname via node:dns
//      (remote-dns-resolver.service.ts). ANY resolution failure (NXDOMAIN
//      included) is its own signal — see that file's header — rather than
//      silently falling through with an empty/garbage address.
//   3. Call the FROZEN classifyReachability (packages/shared/src/remote/
//      diagnosis.ts) — never reimplemented here. `probeArrived` is always
//      `false`: this function is only ever invoked in the FAILURE-diagnosis
//      flow (a probe that already arrived has nothing to diagnose, and
//      diagnosis.ts's own doc comment says as much: "a caller should not
//      invoke this for a success in the first place").
//   4. Render the per-path guidance (packages/shared/src/remote/
//      diagnosis-guidance.ts) into `detail`.

import { classifyReachability, diagnosisGuidance, type DiagnosisCode, type PathId } from "@loombre/shared";
import type { ConnectorHealthReaderService } from "./connector-health.service.js";
import type { RemoteDnsResolverService } from "./remote-dns-resolver.service.js";

export interface RemoteDiagnosisResult {
  code: DiagnosisCode;
  detail: string;
}

export interface DiagnoseReachabilityInput {
  path: PathId;
  /** Bare host[:port], no scheme — see extractHostname below for the
   *  defensive normalization applied regardless. */
  expectedEndpoint: string;
  wanAddress: string | null;
}

export interface DiagnoseReachabilityDeps {
  connectorHealthReader: ConnectorHealthReaderService;
  dnsResolver: RemoteDnsResolverService;
}

/**
 * Defensive normalization: `expectedEndpoint` is documented (openapi.yaml)
 * as a bare host, but strips a scheme/path/query/port anyway rather than
 * handing node:dns a value it would reject outright — an admin pasting
 * `https://loombre.example.com:8443/` into a field documented as "bare
 * host" is a predictable mistake, not a 422-worthy one at THIS layer (the
 * controller's own validation only checks non-empty).
 */
export function extractHostname(expectedEndpoint: string): string {
  let host = expectedEndpoint.trim();
  host = host.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  host = (host.split("/")[0] ?? host).split("?")[0] ?? host;
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx > 0 && /^\d+$/.test(host.slice(colonIdx + 1))) {
    host = host.slice(0, colonIdx);
  }
  return host;
}

export async function diagnoseReachability(
  input: DiagnoseReachabilityInput,
  deps: DiagnoseReachabilityDeps,
): Promise<RemoteDiagnosisResult> {
  if (input.path === "tunnel") {
    const health = await deps.connectorHealthReader.read();
    if (health === "down") {
      return { code: "tunnelDown", detail: diagnosisGuidance("tunnel", "tunnelDown") };
    }
    if (health === "degraded") {
      return { code: "connectorUnhealthy", detail: diagnosisGuidance("tunnel", "connectorUnhealthy") };
    }
    // "healthy" or "unknown" (today's only real value, connector-health.
    // service.ts's no-op default): fall through to WAN classification
    // exactly like the other two paths.
  }

  const hostname = extractHostname(input.expectedEndpoint);
  const resolvedPublicAddress = await deps.dnsResolver.resolvePublicAddress(hostname);
  if (resolvedPublicAddress === null) {
    // NXDOMAIN/lookup failure is its own signal (mission item 5) — the
    // closed DiagnosisCode union has no dedicated "does not resolve at
    // all" member, so this collapses onto dnsMismatch (the closest true
    // member: the endpoint's DNS is not configured the way the proof
    // needs it to be), distinguished from a real address MISMATCH only in
    // `detail`.
    return {
      code: "dnsMismatch",
      detail: `${diagnosisGuidance(input.path, "dnsMismatch")} (The hostname "${hostname}" does not resolve at all — no DNS record was found.)`,
    };
  }

  const code = classifyReachability({
    wanAddress: input.wanAddress,
    resolvedPublicAddress,
    probeArrived: false,
  });

  return { code, detail: diagnosisGuidance(input.path, code) };
}
