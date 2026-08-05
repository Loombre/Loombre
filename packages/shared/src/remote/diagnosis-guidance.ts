// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/remote/diagnosis-guidance.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5/R6/RG11, Lane P1's mission item
// 5: "per-path diagnosis mapping (which the wizard renders): a pure
// mapping module + tests covering every DiagnosisCode × path
// combination").
//
// PURE, framework-free, no I/O — same posture as diagnosis.ts right next
// to it (that module's own header: "no I/O, no network calls, no DNS
// resolution of its own"). This module takes a PathId + the DiagnosisCode
// classifyReachability already produced and returns the human-facing
// guidance text apps/server/src/remote/diagnose-reachability.ts embeds in
// RemoteDiagnosisResult.detail (both diagnoseRemote's live call and
// getRemoteProbe's own auto-diagnosis-on-expiry use the SAME function, so
// the two surfaces can never drift apart).
//
// Reuses wizard-state.ts's PathId ("remote" | "tunnel" | "direct" — NOT
// the contract's wider RemotePathId, which additionally carries 'none' for
// the DERIVED "nothing enabled yet" state; a diagnosis is always FOR one
// specific path's setup flow, exactly wizard-state.ts's own PathId doc
// comment reasoning) rather than inventing a second three-value union.
//
// Exhaustively typed as Record<PathId, Record<DiagnosisCode, string>> so
// TypeScript itself enforces total coverage of the full matrix — a missing
// combination is a compile error, not a runtime gap discovered by a test.

import type { PathId } from './wizard-state.js';
import type { DiagnosisCode } from './diagnosis.js';

const GUIDANCE: Record<PathId, Record<DiagnosisCode, string>> = {
  direct: {
    portBlocked:
      'Your public IP address is correct, but nothing answered. Check your router’s port-forwarding rule for the port Loombre listens on, and make sure any host firewall allows inbound traffic.',
    cgnat:
      'Your router’s WAN address is inside carrier-grade NAT (100.64.0.0/10) — your ISP is not giving you a real public IP, so port-forwarding can never work here. Switch to the Tunnel path instead.',
    doubleNat:
      'Your router’s own WAN address is a private address, meaning it sits behind ANOTHER router or ISP gateway performing NAT. Configure port-forwarding on that outer device too, or switch to the Tunnel path.',
    dnsMismatch:
      'The hostname you configured doesn’t resolve to the address your router reports as its WAN address. Update your DNS record (or dynamic-DNS client) to point at your current public IP, or switch to the Tunnel path if your address changes often.',
    tunnelDown:
      'The Direct path doesn’t use a tunnel connector, so a "tunnel down" diagnosis should not occur here. If you see it, re-run the reachability proof.',
    connectorUnhealthy:
      'The Direct path doesn’t use a tunnel connector, so a connector-health diagnosis should not occur here. If you see it, re-run the reachability proof.',
    unknown:
      'Reachability couldn’t be classified yet. Enter your router’s WAN address from its status page and try again.',
  },
  tunnel: {
    tunnelDown:
      'The cloudflared connector process is not running. Check the connector’s logs in the admin panel and restart it.',
    connectorUnhealthy:
      'The cloudflared connector is running but reporting a degraded or error state. Check the connector logs for the specific failure (token, DNS route, or network issue).',
    portBlocked:
      'The Tunnel path shouldn’t depend on any inbound port. If you see this, verify the connector is actually running rather than treating it as a firewall issue.',
    cgnat:
      'Carrier-grade NAT doesn’t affect the Tunnel path (it only makes outbound connections). If this classification is unexpected, confirm the connector reports healthy and re-run the proof.',
    doubleNat:
      'A double-NAT WAN topology doesn’t affect the Tunnel path (it only makes outbound connections). If this classification is unexpected, confirm the connector reports healthy and re-run the proof.',
    dnsMismatch:
      'The tunnel’s public hostname doesn’t resolve as expected. Check the DNS route created for this tunnel in your Cloudflare account.',
    unknown:
      'Reachability couldn’t be classified yet. Confirm the connector is enabled and try the reachability proof again.',
  },
  remote: {
    portBlocked:
      'Your public IP address is correct, but nothing answered the WireGuard port. Check your router’s port-forwarding rule for the configured WireGuard UDP port.',
    cgnat:
      'Your router’s WAN address is inside carrier-grade NAT (100.64.0.0/10) — your ISP is not giving you a real public IP, so the WireGuard port can never be forwarded. Switch to the Tunnel path instead.',
    doubleNat:
      'Your router’s own WAN address is a private address, meaning it sits behind ANOTHER router or ISP gateway performing NAT. Configure port-forwarding on that outer device too, or switch to the Tunnel path.',
    dnsMismatch:
      'The hostname configured for Remote access doesn’t resolve to your router’s current WAN address. Update your DNS record (or dynamic-DNS client), or switch to the Tunnel path if your address changes often.',
    tunnelDown:
      'The Remote (WireGuard) path doesn’t use a tunnel connector, so a "tunnel down" diagnosis should not occur here. If you see it, re-run the reachability proof.',
    connectorUnhealthy:
      'The Remote (WireGuard) path doesn’t use a tunnel connector, so a connector-health diagnosis should not occur here. If you see it, re-run the reachability proof.',
    unknown:
      'Reachability couldn’t be classified yet. Enter your router’s WAN address from its status page and try again.',
  },
};

/**
 * `path` is typed as the closed PathId union at every real call site
 * (apps/server/src/remote/diagnose-reachability.ts); this module stays
 * total over the wider string type only so a defensively-parsed value
 * (e.g. a future caller reading `path` back off a DB row) can never throw
 * — an unrecognized path/code pair falls back to a generic, still-honest
 * message rather than crashing a diagnosis response.
 */
export function diagnosisGuidance(path: PathId, code: DiagnosisCode): string {
  return GUIDANCE[path]?.[code] ?? 'Reachability could not be classified. Try the reachability proof again.';
}
