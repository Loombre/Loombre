// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/tunnel-provider.ts
//
// STATE.md R4 "thin-but-real": an interface + ONE implementation
// (cloudflare-tunnel-provider.ts) so other tunnel providers are additive
// later (R4's own wording) without touching remote-tunnel.service.ts at
// all — that service depends on this abstract class only, never the
// concrete Cloudflare implementation.
//
// Deliberately STATELESS: every method takes whatever identifiers it needs
// as explicit parameters (including the bearer token itself) rather than
// caching anything — token custody (the keyring) is tunnel-token.
// service.ts's job, and persisted provisioning identifiers (tunnelId/
// accountId/zoneId/dnsRecordId) are remote-tunnel.service.ts's job via
// packages/db/src/query/remote-tunnel.ts. This provider never touches the
// database or the keyring.
//
// An ABSTRACT CLASS, not a Symbol/@Inject token — see active-path-reader.ts's
// header for why (house-style constructor injection, no new DI machinery).

export interface TunnelTokenValidation {
  valid: boolean;
  /** Human-readable Cloudflare permission-group names this token proved it
   *  has (a probe call against that capability succeeded) — informational,
   *  never exhaustive beyond what THIS provider actually needs. */
  scopes: string[];
  /** Resolved from `GET /accounts` — null when the token itself is invalid
   *  or the probe never got far enough to resolve an account. */
  accountId: string | null;
  /** Human-readable permission-group names (matching the Cloudflare
   *  dashboard's own token-editor labels) whose probe call failed — the
   *  admin fixes their token by adding exactly these. Empty when valid. */
  missingScopes: string[];
  /** Human-readable summary suitable to surface directly as
   *  RemoteTunnelTokenValidation.detail (packages/contract/openapi.yaml) —
   *  NEVER echoes the token itself. Null only when valid with nothing
   *  further to say. */
  detail: string | null;
}

export interface ProvisionTunnelInput {
  token: string;
  accountId: string;
  hostname: string;
  /** The LOCAL Loombre listener the tunnel's ingress rule routes to, e.g.
   *  "http://127.0.0.1:3001" (RG2 — plain HTTP inside the tunnel is correct
   *  posture, WG/TLS-equivalent crypto is the tunnel itself). */
  localTargetUrl: string;
}

export interface ProvisionTunnelResult {
  tunnelId: string;
  /** The opaque per-tunnel connector run credential Cloudflare mints
   *  (`GET .../cfd_tunnel/{id}/token`) — handed to ConnectorManager.start()
   *  and stored in the keyring by remote-tunnel.service.ts, NEVER logged or
   *  echoed on any read DTO (R9). Named `connectorCredentials` per R4's own
   *  wording even though it is, today, a single opaque string rather than a
   *  structured credentials file — cloudflared's modern `tunnel run
   *  --token` flow needs nothing else. */
  connectorCredentials: string;
}

export interface DeprovisionTunnelInput {
  token: string;
  accountId: string;
  tunnelId: string;
}

export interface DnsRouteInput {
  token: string;
  accountId: string;
  tunnelId: string;
  hostname: string;
}

export interface DnsRouteResult {
  zoneId: string;
  dnsRecordId: string;
}

export interface RemoveDnsRouteInput {
  token: string;
  zoneId: string;
  dnsRecordId: string;
}

/** Thrown by every provisioning/teardown method (never by validateToken,
 *  which is contractually non-throwing — see its own doc comment) on any
 *  transport failure or a non-success Cloudflare API response. `detail` is
 *  safe to surface directly to an admin (never echoes the token; mirrors
 *  manifest-client.ts's M-3 fix-wave discipline of never echoing an
 *  upstream response body verbatim). */
export class TunnelProviderError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`TunnelProviderError: ${detail}`);
    this.name = "TunnelProviderError";
    this.detail = detail;
  }
}

export abstract class TunnelProvider {
  /**
   * Never throws (mirrors packages/plugin-host/src/manifest-client.ts's
   * "never throws" contract for the identical reason: every caller — here,
   * apps/server/src/remote/tunnel/tunnel-token.service.ts's setToken, which
   * must always produce a 200 RemoteTunnelTokenValidation body, contract
   * frozen at Wave-0 — needs a typed result, not a try/catch). A transport
   * failure (unreachable API, timeout) collapses to `valid:false` with an
   * explanatory `detail`, exactly like an actually-invalid token.
   */
  abstract validateToken(token: string): Promise<TunnelTokenValidation>;

  abstract provisionTunnel(input: ProvisionTunnelInput): Promise<ProvisionTunnelResult>;
  abstract deprovisionTunnel(input: DeprovisionTunnelInput): Promise<void>;
  abstract createDnsRoute(input: DnsRouteInput): Promise<DnsRouteResult>;
  abstract removeDnsRoute(input: RemoveDnsRouteInput): Promise<void>;
}
