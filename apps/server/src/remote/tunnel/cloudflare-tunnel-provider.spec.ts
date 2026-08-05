// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/cloudflare-tunnel-provider.spec.ts
//
// R11: ALL provider tests run against recorded/local fixtures — never the
// live Cloudflare API. Mirrors packages/plugin-host/test/manifest-client.
// spec.ts's own convention exactly: a fake `fetchImpl` returning real
// `Response` objects (so hardenedFetch's real body-reading/status-check
// path is exercised, only the network transport itself is faked) plus a
// faked `dnsLookup` returning a public address so hardenedFetch's
// pre-dial validation step passes without any real DNS.

import { describe, expect, it, vi } from "vitest";
import type { DnsLookupFn } from "@loombre/plugin-host";
import { CloudflareTunnelProvider } from "./cloudflare-tunnel-provider.js";
import { TunnelProviderError } from "./tunnel-provider.js";

const publicDns: DnsLookupFn = async () => [{ address: "104.16.132.229", family: 4 }];

function cfEnvelope(result: unknown, success = true, errors: Array<{ code: number; message: string }> = []) {
  return JSON.stringify({ success, errors, messages: [], result });
}

/** Routes on the request path (never the method — every one of this
 *  provider's calls uses a distinct path) to a canned response, in call
 *  order per path when the same path is hit more than once. */
function fakeFetch(responses: Record<string, { status: number; body: string }[]>): typeof fetch {
  const cursors: Record<string, number> = {};
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = url.pathname + url.search;
    // Exact match wins; otherwise the LONGEST matching prefix (so
    // "/client/v4/accounts/acct-123/cfd_tunnel" never accidentally matches
    // the shorter "/client/v4/accounts" fixture).
    const matchKey =
      Object.keys(responses).find((k) => key === k) ??
      Object.keys(responses)
        .filter((k) => key.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
    if (!matchKey) throw new Error(`fakeFetch: no fixture for ${key}`);
    const i = cursors[matchKey] ?? 0;
    const list = responses[matchKey]!;
    const entry = list[Math.min(i, list.length - 1)]!;
    cursors[matchKey] = i + 1;
    return new Response(entry.body, { status: entry.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("CloudflareTunnelProvider.validateToken", () => {
  it("valid:true with resolved accountId and all four scope probes recorded when everything succeeds", async () => {
    const provider = new CloudflareTunnelProvider({
      dnsLookup: publicDns,
      fetchImpl: fakeFetch({
        "/client/v4/user/tokens/verify": [{ status: 200, body: cfEnvelope({ id: "tok1", status: "active" }) }],
        "/client/v4/accounts": [{ status: 200, body: cfEnvelope([{ id: "acct-123" }]) }],
        "/client/v4/accounts/acct-123/cfd_tunnel": [{ status: 200, body: cfEnvelope([]) }],
        "/client/v4/zones": [{ status: 200, body: cfEnvelope([{ id: "zone-1" }]) }],
      }),
    });

    const result = await provider.validateToken("cf-token-abc");
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("acct-123");
    expect(result.missingScopes).toEqual([]);
    expect(result.scopes).toEqual(["Account Settings: Read", "Cloudflare Tunnel: Edit", "Zone: DNS Edit"]);
    expect(result.detail).toBeNull();
  });

  it("valid:false with a detail explaining an inactive/invalid token — never echoes the token", async () => {
    const provider = new CloudflareTunnelProvider({
      dnsLookup: publicDns,
      fetchImpl: fakeFetch({
        "/client/v4/user/tokens/verify": [
          { status: 400, body: cfEnvelope(null, false, [{ code: 1000, message: "Invalid API Token" }]) },
        ],
      }),
    });

    const result = await provider.validateToken("super-secret-token-value");
    expect(result.valid).toBe(false);
    expect(result.accountId).toBeNull();
    expect(result.detail).not.toBeNull();
    expect(result.detail).not.toContain("super-secret-token-value");
  });

  it("valid:false listing exactly the missing permission groups when scope probes fail", async () => {
    const provider = new CloudflareTunnelProvider({
      dnsLookup: publicDns,
      fetchImpl: fakeFetch({
        "/client/v4/user/tokens/verify": [{ status: 200, body: cfEnvelope({ id: "tok1", status: "active" }) }],
        "/client/v4/accounts": [{ status: 200, body: cfEnvelope([{ id: "acct-123" }]) }],
        "/client/v4/accounts/acct-123/cfd_tunnel": [
          { status: 403, body: cfEnvelope(null, false, [{ code: 9109, message: "Unauthorized to access requested resource" }]) },
        ],
        "/client/v4/zones": [{ status: 200, body: cfEnvelope([{ id: "zone-1" }]) }],
      }),
    });

    const result = await provider.validateToken("cf-token-abc");
    expect(result.valid).toBe(false);
    expect(result.missingScopes).toEqual(["Cloudflare Tunnel: Edit"]);
    expect(result.detail).toContain("Cloudflare Tunnel: Edit");
    expect(result.detail).not.toContain("Account Settings: Read");
  });

  it("valid:false with an explanatory detail when the API is unreachable (transport failure, not an invalid token)", async () => {
    const provider = new CloudflareTunnelProvider({
      dnsLookup: publicDns,
      fetchImpl: (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch,
    });

    const result = await provider.validateToken("cf-token-abc");
    expect(result.valid).toBe(false);
    expect(result.detail).toContain("could not be verified");
  });

  it("never throws — every branch above returns a typed result", async () => {
    const provider = new CloudflareTunnelProvider({ dnsLookup: publicDns, fetchImpl: fakeFetch({}) });
    await expect(provider.validateToken("x")).resolves.toBeDefined();
  });
});

describe("CloudflareTunnelProvider.provisionTunnel / createDnsRoute / deprovisionTunnel / removeDnsRoute", () => {
  it("provisionTunnel creates the tunnel, fetches the run token, and sets ingress config to the local target", async () => {
    let configuredIngress: unknown;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/client/v4/accounts/acct-1/cfd_tunnel" && init?.method === "POST") {
        return new Response(cfEnvelope({ id: "tunnel-xyz" }), { status: 200 });
      }
      if (url.pathname === "/client/v4/accounts/acct-1/cfd_tunnel/tunnel-xyz/token") {
        return new Response(cfEnvelope("opaque-run-token-blob"), { status: 200 });
      }
      if (url.pathname === "/client/v4/accounts/acct-1/cfd_tunnel/tunnel-xyz/configurations" && init?.method === "PUT") {
        configuredIngress = JSON.parse(String(init.body));
        return new Response(cfEnvelope({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected request: ${init?.method} ${url.pathname}`);
    }) as unknown as typeof fetch;

    const provider = new CloudflareTunnelProvider({ dnsLookup: publicDns, fetchImpl });
    const result = await provider.provisionTunnel({
      token: "cf-token",
      accountId: "acct-1",
      hostname: "media.example.com",
      localTargetUrl: "http://127.0.0.1:3001",
    });

    expect(result.tunnelId).toBe("tunnel-xyz");
    expect(result.connectorCredentials).toBe("opaque-run-token-blob");
    expect(configuredIngress).toEqual({
      config: {
        ingress: [
          { hostname: "media.example.com", service: "http://127.0.0.1:3001" },
          { service: "http_status:404" },
        ],
      },
    });
  });

  it("provisionTunnel throws TunnelProviderError (never echoing the token) on a Cloudflare error response", async () => {
    const provider = new CloudflareTunnelProvider({
      dnsLookup: publicDns,
      fetchImpl: fakeFetch({
        "/client/v4/accounts/acct-1/cfd_tunnel": [
          { status: 409, body: cfEnvelope(null, false, [{ code: 1000, message: "tunnel with that name already exists" }]) },
        ],
      }),
    });

    await expect(
      provider.provisionTunnel({ token: "secret-tok", accountId: "acct-1", hostname: "h.example.com", localTargetUrl: "http://127.0.0.1:3001" }),
    ).rejects.toMatchObject({ constructor: TunnelProviderError });
    try {
      await provider.provisionTunnel({ token: "secret-tok", accountId: "acct-1", hostname: "h.example.com", localTargetUrl: "http://127.0.0.1:3001" });
    } catch (err) {
      expect(err).toBeInstanceOf(TunnelProviderError);
      expect((err as InstanceType<typeof TunnelProviderError>).detail).not.toContain("secret-tok");
      expect((err as InstanceType<typeof TunnelProviderError>).detail).toContain("already exists");
    }
  });

  it("createDnsRoute walks progressively shorter suffixes to find the owning zone, then creates a proxied CNAME to <tunnelId>.cfargotunnel.com", async () => {
    const requestedZoneQueries: string[] = [];
    let createdRecord: unknown;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/client/v4/zones") {
        requestedZoneQueries.push(url.searchParams.get("name") ?? "");
        const found = url.searchParams.get("name") === "example.com";
        return new Response(cfEnvelope(found ? [{ id: "zone-1" }] : []), { status: 200 });
      }
      if (url.pathname === "/client/v4/zones/zone-1/dns_records" && init?.method === "POST") {
        createdRecord = JSON.parse(String(init.body));
        return new Response(cfEnvelope({ id: "record-1" }), { status: 200 });
      }
      throw new Error(`unexpected request: ${init?.method} ${url.pathname}`);
    }) as unknown as typeof fetch;

    const provider = new CloudflareTunnelProvider({ dnsLookup: publicDns, fetchImpl });
    const result = await provider.createDnsRoute({ token: "cf-token", accountId: "acct-1", tunnelId: "tunnel-xyz", hostname: "media.example.com" });

    expect(result).toEqual({ zoneId: "zone-1", dnsRecordId: "record-1" });
    expect(requestedZoneQueries).toEqual(["media.example.com", "example.com"]);
    expect(createdRecord).toEqual({
      type: "CNAME",
      name: "media.example.com",
      content: "tunnel-xyz.cfargotunnel.com",
      proxied: true,
    });
  });

  it("createDnsRoute throws when no zone owns the hostname", async () => {
    const provider = new CloudflareTunnelProvider({
      dnsLookup: publicDns,
      fetchImpl: fakeFetch({ "/client/v4/zones": [{ status: 200, body: cfEnvelope([]) }] }),
    });
    await expect(
      provider.createDnsRoute({ token: "cf-token", accountId: "acct-1", tunnelId: "t", hostname: "nowhere.invalid" }),
    ).rejects.toThrow(/no Cloudflare zone was found/);
  });

  it("deprovisionTunnel DELETEs the tunnel; removeDnsRoute DELETEs the DNS record", async () => {
    const deleted: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      deleted.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return new Response(cfEnvelope({}), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new CloudflareTunnelProvider({ dnsLookup: publicDns, fetchImpl });
    await provider.deprovisionTunnel({ token: "cf-token", accountId: "acct-1", tunnelId: "tunnel-xyz" });
    await provider.removeDnsRoute({ token: "cf-token", zoneId: "zone-1", dnsRecordId: "record-1" });

    expect(deleted).toEqual([
      "DELETE /client/v4/accounts/acct-1/cfd_tunnel/tunnel-xyz",
      "DELETE /client/v4/zones/zone-1/dns_records/record-1",
    ]);
  });
});

describe("CloudflareTunnelProvider — every request carries the bearer token, never logged/echoed", () => {
  it("Authorization header is set on every call", async () => {
    const authHeaders: (string | null)[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get("authorization"));
      return new Response(cfEnvelope({ id: "tok1", status: "active" }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new CloudflareTunnelProvider({ dnsLookup: publicDns, fetchImpl });
    await provider.validateToken("my-cf-token");
    expect(authHeaders.length).toBeGreaterThan(0);
    for (const h of authHeaders) expect(h).toBe("Bearer my-cf-token");
  });

  it("setTestDeps swaps the fetch/dns deps post-construction (the e2e test-injection seam)", async () => {
    const provider = new CloudflareTunnelProvider();
    const fetchImpl = vi.fn(async () => new Response(cfEnvelope({ id: "tok1", status: "active" }), { status: 200 }));
    provider.setTestDeps({ dnsLookup: publicDns, fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.validateToken("x");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
