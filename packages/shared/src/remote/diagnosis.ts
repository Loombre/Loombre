// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/diagnosis.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5/R6/RG11, Wave 0 freeze).
//
// RG11: no third-party echo service and no router APIs exist anywhere in
// this codebase (the "detect, instruct, verify — never auto-configure the
// network" hard line, STATE.md Run posture), so the WAN address a
// diagnosis is classified against is always ADMIN-SUPPLIED via a guided
// router-status-page instruction card (POST /admin/remote/diagnosis's
// `wanAddress`). This module is the PURE decision function — no I/O, no
// network calls, no DNS resolution of its own (the resolved public address
// is likewise supplied, already resolved by the caller).

/**
 * DiagnosisCode — the closed classification union (mirrors DiagnosisCode
 * in openapi.yaml exactly). `tunnelDown`/`connectorUnhealthy` are NOT
 * produced by classifyReachability below (they come from the Tunnel path's
 * own connector-health signal, a later lane's server-side responsibility) —
 * they exist in this union because RemoteDiagnosisResult carries whichever
 * code applies for the active path, and the Tunnel path's diagnosis can
 * short-circuit straight to one of these two without ever consulting WAN
 * classification at all.
 */
export type DiagnosisCode =
  | "portBlocked"
  | "cgnat"
  | "doubleNat"
  | "dnsMismatch"
  | "tunnelDown"
  | "connectorUnhealthy"
  | "unknown";

export interface ReachabilityInput {
  /** Admin-supplied WAN address (RG11) — null when the admin hasn't
   *  completed the router-status-page step yet. Never guessed. */
  wanAddress: string | null;
  /** The public endpoint DNS actually resolves to for this instance's
   *  configured hostname — already resolved by the caller. */
  resolvedPublicAddress: string;
  /** Whether GET /admin/remote/probes/{id} reported `status: "arrived"`
   *  for the reachability proof this diagnosis is being run for. */
  probeArrived: boolean;
}

/** RFC 6598 shared address space (100.64.0.0/10) — the block ISPs use for
 *  their own NAT layer between the subscriber and the public internet
 *  (CGNAT). A WAN address inside it is DEFINITE proof of CGNAT: no
 *  ordinary customer premises equipment is ever assigned an address from
 *  this range as its own public IP. */
function isCgnatAddress(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 100 && b! >= 64 && b! <= 127;
}

/** RFC 1918 private address space. A WAN address inside it (as reported by
 *  the ROUTER's own status page, which is what `wanAddress` means here)
 *  means the router itself sits behind ANOTHER layer of NAT — a
 *  double-NAT topology the admin's own router cannot see past. */
function isPrivateAddress(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/**
 * The pure WAN-classification decision function (RG11), table-driven and
 * exhaustively spec'd (test/remote/diagnosis.test.ts). Priority order,
 * each rule short-circuits the ones below it:
 *
 *   1. No usable WAN address (missing or unparseable) -> unknown. Never
 *      guessed — a malformed admin-supplied value must not silently
 *      resolve to a specific, actionable-sounding diagnosis.
 *   2. WAN in 100.64.0.0/10 -> cgnat (definite; RFC 6598 is reserved
 *      exactly for this).
 *   3. WAN in an RFC1918 private range -> doubleNat (the router's own WAN
 *      side is itself behind another NAT layer).
 *   4. WAN equals the resolved public endpoint:
 *        - probe arrived -> unknown (nothing to diagnose; a caller should
 *          not invoke this for a success in the first place, but the
 *          function stays total rather than throwing).
 *        - probe did not arrive -> portBlocked (the public address is
 *          correct; something between the internet and the listening
 *          port — firewall, missing port-forward — is dropping it).
 *   5. WAN differs from the resolved public endpoint (both public
 *      addresses) -> dnsMismatch (a dynamic-IP/DNS staleness mismatch;
 *      the wizard routes to Tunnel, R5).
 */
export function classifyReachability(input: ReachabilityInput): DiagnosisCode {
  if (input.wanAddress === null) return "unknown";
  if (!parseIpv4(input.wanAddress)) return "unknown";

  if (isCgnatAddress(input.wanAddress)) return "cgnat";
  if (isPrivateAddress(input.wanAddress)) return "doubleNat";

  if (input.wanAddress === input.resolvedPublicAddress) {
    return input.probeArrived ? "unknown" : "portBlocked";
  }

  return "dnsMismatch";
}
