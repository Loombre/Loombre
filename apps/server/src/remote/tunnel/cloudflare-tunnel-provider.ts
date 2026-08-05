// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/cloudflare-tunnel-provider.ts
//
// STATE.md R4 "ONE implementation" of TunnelProvider, against the real
// Cloudflare v4 API (https://api.cloudflare.com/client/v4). Ground-truthed
// against the plugins subsystem's own outbound-HTTP precedent (mission
// brief): packages/plugin-host's `hardenedFetch` is this repo's ONE hardened
// fetch primitive (ssrf.ts's own header: "the SOLE network-issuing
// primitive in this package" — reused here rather than a second one,
// same reasoning apps/server/src/common/update-check/perform-check.ts's
// injectable `fetchImpl: typeof fetch` gives for its OWN outbound calls: an
// admin-triggered network call needs a timeout + response-size cap + no
// silent redirect-follow regardless of whether the target host is
// attacker-controlled). api.cloudflare.com is a FIXED, hardcoded public
// host (never admin-supplied), so hardenedFetch's SSRF deny-list is not
// the load-bearing property here — the timeout/size-cap/no-redirect
// hygiene is, and reusing the existing primitive keeps this file's tests
// mockable the SAME way packages/plugin-host/test/manifest-client.spec.ts's
// own tests are (an injected `fetchImpl` returning real `Response` objects,
// `dnsLookup` faked to a public address so the pre-dial validation step
// passes without any real DNS).
//
// ALL of this provider's own tests run against a fake fetchImpl (recorded/
// local fixtures, R11) — never the live Cloudflare API. Real-account
// validation is the owner's home-lab item (R11), same posture as R6's
// reachability proof.
//
// Cloudflare API endpoints this file calls (v4, `Authorization: Bearer
// <token>` on every request) — see this class's own method doc comments
// for which permission group each backs:
//   GET    /user/tokens/verify
//   GET    /accounts
//   GET    /accounts/{account_id}/cfd_tunnel
//   POST   /accounts/{account_id}/cfd_tunnel
//   GET    /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token
//   PUT    /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations
//   DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}
//   GET    /zones?name={candidate}
//   POST   /zones/{zone_id}/dns_records
//   DELETE /zones/{zone_id}/dns_records/{dns_record_id}
//
// Cloudflare's universal API response envelope is `{success, errors,
// messages, result}` — cfRequest below decodes exactly that shape and
// never assumes anything else.

import { randomBytes } from "node:crypto";
import { Injectable, Optional } from "@nestjs/common";
import { defaultDnsLookup, hardenedFetch, HardenedFetchError, type DnsLookupFn } from "@loombre/plugin-host";
import {
  TunnelProvider,
  TunnelProviderError,
  type DeprovisionTunnelInput,
  type DnsRouteInput,
  type DnsRouteResult,
  type ProvisionTunnelInput,
  type ProvisionTunnelResult,
  type RemoveDnsRouteInput,
  type TunnelTokenValidation,
} from "./tunnel-provider.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const CF_HTTP_TIMEOUT_MS = 10_000;
/** Generous for JSON API responses; nowhere near the manifest-fetch cap
 *  (that one bounds an UNTRUSTED plugin server's body — this one just
 *  guards against a pathological Cloudflare response). */
const CF_HTTP_MAX_RESPONSE_BYTES = 2_000_000;

interface CloudflareApiError {
  code: number;
  message: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: CloudflareApiError[];
  messages: CloudflareApiError[];
  result: T | null;
}

export interface CloudflareTunnelProviderDeps {
  fetchImpl?: typeof fetch;
  dnsLookup?: DnsLookupFn;
}

@Injectable()
export class CloudflareTunnelProvider implements TunnelProvider {
  /** `deps` is a plain interface (erases to `Object` for Nest's reflected
   *  design:paramtypes), so `@Optional()` tells Nest to inject `undefined`
   *  rather than try (and fail) to resolve a DI token for it — the running
   *  app (remote.module.ts's `useClass: CloudflareTunnelProvider` binding)
   *  always gets `undefined` here, and this constructor's own default
   *  parameter value fills in `{}` (real fetch, real DNS). Tests construct
   *  this class directly with `new CloudflareTunnelProvider({fetchImpl:
   *  ...})`, bypassing Nest's DI entirely — no test ever goes through the
   *  module. */
  constructor(@Optional() private deps: CloudflareTunnelProviderDeps = {}) {}

  /** Test-only seam (mirrors NoopConnectorManager/NoopRemoteActivePathReader's
   *  own mutable test fields, and server-power.e2e.spec.ts's `power.arm()`
   *  convention): e2e specs that boot the REAL AppModule get a live
   *  CloudflareTunnelProvider from `app.get(TunnelProvider)` — this swaps
   *  its outbound-HTTP deps to a fake AFTER construction, the only seam
   *  available once Nest has already resolved the instance. Production
   *  code never calls this. */
  setTestDeps(deps: CloudflareTunnelProviderDeps): void {
    this.deps = deps;
  }

  private async cfRequest<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    let response;
    try {
      response = await hardenedFetch(
        `${CF_API_BASE}${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        {
          fetchImpl: this.deps.fetchImpl,
          dnsLookup: this.deps.dnsLookup ?? defaultDnsLookup,
          timeoutMs: CF_HTTP_TIMEOUT_MS,
          maxResponseBytes: CF_HTTP_MAX_RESPONSE_BYTES,
        },
      );
    } catch (err) {
      if (err instanceof HardenedFetchError) {
        throw new TunnelProviderError(`could not reach the Cloudflare API (${err.reason}): ${err.message}`);
      }
      throw new TunnelProviderError(`unexpected error calling the Cloudflare API: ${err instanceof Error ? err.message : String(err)}`);
    }

    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = JSON.parse(response.bodyText) as CloudflareEnvelope<T>;
    } catch {
      throw new TunnelProviderError(`the Cloudflare API returned a non-JSON response (HTTP ${response.status}).`);
    }

    if (!envelope.success || response.status < 200 || response.status >= 300) {
      const messages = envelope.errors.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
      throw new TunnelProviderError(`Cloudflare API error: ${messages}`);
    }
    if (envelope.result === null) {
      throw new TunnelProviderError("the Cloudflare API returned a successful response with no result.");
    }
    return envelope.result;
  }

  /** Same cfRequest, but returns `{ok:false, detail}` instead of throwing —
   *  used ONLY by validateToken's probes, whose failures are informational
   *  (a missing scope), never fatal to the overall call (see this class's
   *  own validateToken doc comment on TunnelProvider). */
  private async probe<T>(method: string, path: string, token: string): Promise<{ ok: true; result: T } | { ok: false; detail: string }> {
    try {
      const result = await this.cfRequest<T>(method, path, token);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, detail: err instanceof TunnelProviderError ? err.detail : String(err) };
    }
  }

  /**
   * Never throws — see TunnelProvider.validateToken's own doc comment.
   * Four sequential probes, each backing one Cloudflare permission group a
   * BYO token for Tunnel automation needs:
   *   1. GET /user/tokens/verify         — the token itself is valid/active.
   *   2. GET /accounts                   — "Account Settings: Read" (also
   *      resolves accountId, the first account the token can see).
   *   3. GET /accounts/{id}/cfd_tunnel   — "Cloudflare Tunnel: Edit" (a list
   *      call; Cloudflare's tunnel permission catalog has no separate
   *      lesser Read-only group — a token scoped for this automation was
   *      necessarily granted Edit).
   *   4. GET /zones                      — "Zone: DNS Edit" (a documented
   *      simplification: DNS:Edit's WRITE capability can only be proven for
   *      real at DNS-route creation time, since which zone will be used is
   *      unknown at set-token time — SetRemoteTunnelTokenRequest carries no
   *      hostname; this probe confirms zone-level read access as the best
   *      available signal at this stage, and createDnsRoute surfaces a
   *      clear TunnelProviderError if the real write later fails).
   */
  async validateToken(token: string): Promise<TunnelTokenValidation> {
    const verify = await this.probe<{ id: string; status: string }>("GET", "/user/tokens/verify", token);
    if (!verify.ok) {
      return { valid: false, scopes: [], accountId: null, missingScopes: [], detail: `This token could not be verified: ${verify.detail}` };
    }
    if (verify.result.status !== "active") {
      return { valid: false, scopes: [], accountId: null, missingScopes: [], detail: `This token's status is "${verify.result.status}", not active.` };
    }

    const scopes: string[] = [];
    const missingScopes: string[] = [];

    const accounts = await this.probe<Array<{ id: string }>>("GET", "/accounts", token);
    let accountId: string | null = null;
    if (accounts.ok && accounts.result.length > 0) {
      accountId = accounts.result[0]!.id;
      scopes.push("Account Settings: Read");
    } else {
      missingScopes.push("Account Settings: Read");
    }

    if (accountId) {
      const tunnels = await this.probe("GET", `/accounts/${accountId}/cfd_tunnel`, token);
      if (tunnels.ok) {
        scopes.push("Cloudflare Tunnel: Edit");
      } else {
        missingScopes.push("Cloudflare Tunnel: Edit");
      }
    } else {
      // Can't probe an account-scoped permission without a resolved
      // account — reported as missing rather than silently skipped, so the
      // admin sees the full list of what to fix in one pass.
      missingScopes.push("Cloudflare Tunnel: Edit");
    }

    const zones = await this.probe("GET", "/zones", token);
    if (zones.ok) {
      scopes.push("Zone: DNS Edit");
    } else {
      missingScopes.push("Zone: DNS Edit");
    }

    if (missingScopes.length > 0) {
      return {
        valid: false,
        scopes,
        accountId,
        missingScopes,
        detail: `This token is missing required permissions: ${missingScopes.join(", ")}. Add these permission groups to the token in the Cloudflare dashboard and try again.`,
      };
    }

    return { valid: true, scopes, accountId, missingScopes: [], detail: null };
  }

  /** name/tunnel_secret create (POST /accounts/{id}/cfd_tunnel,
   *  config_src:"cloudflare" — remotely-managed ingress, set separately via
   *  configurations below, so the connector needs nothing but the run
   *  token to start), then GET .../token for the opaque connector run
   *  credential, then PUT .../configurations for the ingress rule routing
   *  `hostname` -> the LOCAL Loombre listener (RG2). */
  async provisionTunnel(input: ProvisionTunnelInput): Promise<ProvisionTunnelResult> {
    const created = await this.cfRequest<{ id: string }>("POST", `/accounts/${input.accountId}/cfd_tunnel`, input.token, {
      name: `loombre-${input.hostname}`,
      tunnel_secret: randomBytes(32).toString("base64"),
      config_src: "cloudflare",
    });
    const tunnelId = created.id;

    const connectorCredentials = await this.cfRequest<string>(
      "GET",
      `/accounts/${input.accountId}/cfd_tunnel/${tunnelId}/token`,
      input.token,
    );

    await this.cfRequest("PUT", `/accounts/${input.accountId}/cfd_tunnel/${tunnelId}/configurations`, input.token, {
      config: {
        ingress: [
          { hostname: input.hostname, service: input.localTargetUrl },
          { service: "http_status:404" },
        ],
      },
    });

    return { tunnelId, connectorCredentials };
  }

  async deprovisionTunnel(input: DeprovisionTunnelInput): Promise<void> {
    await this.cfRequest("DELETE", `/accounts/${input.accountId}/cfd_tunnel/${input.tunnelId}`, input.token);
  }

  /** Resolves the registrable zone by trying progressively shorter
   *  dot-separated suffixes of `hostname` against `GET /zones?name=`
   *  (handles multi-label TLDs like .co.uk more robustly than a fixed
   *  "last two labels" heuristic — the FIRST suffix Cloudflare recognizes
   *  as a zone it hosts wins), then creates a proxied CNAME to
   *  `<tunnelId>.cfargotunnel.com` (RG7/R4's own wording). */
  async createDnsRoute(input: DnsRouteInput): Promise<DnsRouteResult> {
    const labels = input.hostname.split(".");
    let zoneId: string | null = null;
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".");
      const zones = await this.cfRequest<Array<{ id: string }>>("GET", `/zones?name=${encodeURIComponent(candidate)}`, input.token);
      if (zones.length > 0) {
        zoneId = zones[0]!.id;
        break;
      }
    }
    if (!zoneId) {
      throw new TunnelProviderError(`no Cloudflare zone was found that owns "${input.hostname}" — add the domain to Cloudflare first.`);
    }

    const record = await this.cfRequest<{ id: string }>("POST", `/zones/${zoneId}/dns_records`, input.token, {
      type: "CNAME",
      name: input.hostname,
      content: `${input.tunnelId}.cfargotunnel.com`,
      proxied: true,
    });

    return { zoneId, dnsRecordId: record.id };
  }

  async removeDnsRoute(input: RemoveDnsRouteInput): Promise<void> {
    await this.cfRequest("DELETE", `/zones/${input.zoneId}/dns_records/${input.dnsRecordId}`, input.token);
  }
}
