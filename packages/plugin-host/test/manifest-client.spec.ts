// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/test/manifest-client.spec.ts
//
// fetchPluginManifest against a fake fetchImpl (a real `Response` object,
// so the streaming/body-reading path in ssrf.ts's hardenedFetch is
// exercised for real — only the network transport itself is faked). Proves
// every FetchManifestResult stage (LD2's "fetch -> size cap -> staged
// parse", C2's "unknown-capability-type surfaced as a typed rejection").

import { describe, expect, it } from "vitest";
import type { DnsLookupFn } from "../src/ssrf.js";
import { describeFetchManifestFailure, fetchPluginManifest } from "../src/manifest-client.js";
import { PluginCircuitBreaker } from "../src/breaker.js";

const publicDns: DnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

function fakeFetch(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(body, { status, headers: { "content-type": "application/json", ...headers } })) as unknown as typeof fetch;
}

const VALID_MANIFEST = {
  name: "fixture-plugin",
  version: "0.1.0",
  protocolVersion: 1,
  capabilities: [
    {
      type: "metadata-provider",
      mediaKinds: ["movie"],
      contentClass: "general",
      endpoints: { search: "/lpp/provider/search", details: "/lpp/provider/details", images: "/lpp/provider/images" },
    },
  ],
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  description: "fixture",
  publisher: "Loombre",
};

describe("fetchPluginManifest", () => {
  it("returns ok:true for a valid manifest", async () => {
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(200, JSON.stringify(VALID_MANIFEST)),
      dnsLookup: publicDns,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("fixture-plugin");
      expect(result.raw).toEqual(VALID_MANIFEST);
    }
  });

  it("requests GET /lpp/manifest relative to baseUrl", async () => {
    let requestedUrl = "";
    const fetchImpl = (async (input: string | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchPluginManifest("http://plugin.example:1234/base/", { fetchImpl, dnsLookup: publicDns });
    expect(requestedUrl).toBe("http://plugin.example:1234/lpp/manifest");
  });

  it("stage='capabilities': an unknown capability type is a typed rejection (C2), never silently ignored", async () => {
    const manifest = { ...VALID_MANIFEST, capabilities: [{ type: "future-capability", foo: "bar" }] };
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(200, JSON.stringify(manifest)),
      dnsLookup: publicDns,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "capabilities") {
      expect(result.unknownTypes).toEqual(["future-capability"]);
      expect(describeFetchManifestFailure(result)).toContain("this Loombre doesn't support capability type 'future-capability' yet");
    } else {
      expect.unreachable(`expected stage=capabilities, got ${JSON.stringify(result)}`);
    }
  });

  it("stage='protocol-version': an unsupported protocolVersion is rejected", async () => {
    const manifest = { ...VALID_MANIFEST, protocolVersion: 2 };
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(200, JSON.stringify(manifest)),
      dnsLookup: publicDns,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("protocol-version");
  });

  it("stage='json': a non-JSON body is rejected without throwing", async () => {
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(200, "not json at all"),
      dnsLookup: publicDns,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("json");
  });

  it("stage='http-status': a non-2xx response is rejected with the status code", async () => {
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(500, "internal error"),
      dnsLookup: publicDns,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "http-status") {
      expect(result.status).toBe(500);
    } else {
      expect.unreachable(`expected stage=http-status, got ${JSON.stringify(result)}`);
    }
  });

  it("M-3: stage='http-status' detail NEVER echoes the upstream response body (SSRF read-oracle fix)", async () => {
    const distinctiveBody = "DISTINCTIVE-INTERNAL-SECRET-fbe3c1-should-never-appear-in-any-error-detail";
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(500, distinctiveBody),
      dnsLookup: publicDns,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "http-status") {
      expect(result.detail).not.toContain(distinctiveBody);
      expect(result.detail).not.toContain("DISTINCTIVE");
      expect(result.detail).toBe("HTTP 500");
    } else {
      expect.unreachable(`expected stage=http-status, got ${JSON.stringify(result)}`);
    }
    expect(describeFetchManifestFailure(result as never)).not.toContain(distinctiveBody);
  });

  it("M-8: stage='http-status' counts as a breaker FAILURE (not left untouched) — a fast-failing manifest endpoint can now trip open", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(500, "internal error"),
      dnsLookup: publicDns,
      breaker,
      clock: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(breaker.snapshot()).toMatchObject({ state: "open", consecutiveFailures: 1 });
  });

  it("stage='transport': an oversized manifest response is rejected via the size cap (LD5 256KiB manifest cap)", async () => {
    const oversized = JSON.stringify({ ...VALID_MANIFEST, description: "x".repeat(300 * 1024) });
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(200, oversized),
      dnsLookup: publicDns,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "transport") {
      expect(result.reason).toBe("response-too-large");
    } else {
      expect.unreachable(`expected stage=transport/response-too-large, got ${JSON.stringify(result)}`);
    }
  });

  it("stage='transport': SSRF rejection surfaces as a transport failure, never throws", async () => {
    const result = await fetchPluginManifest("http://127.0.0.1:9", {
      fetchImpl: fakeFetch(200, JSON.stringify(VALID_MANIFEST)),
      dnsLookup: publicDns,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "transport") {
      expect(result.reason).toBe("disallowed-address");
    } else {
      expect.unreachable(`expected stage=transport/disallowed-address, got ${JSON.stringify(result)}`);
    }
  });

  it("with a breaker: a network-error counts against it, and a subsequent open breaker short-circuits with stage='circuit-open'", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const first = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: failingFetch,
      dnsLookup: publicDns,
      breaker,
      clock: () => 0,
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.stage).toBe("transport");
    expect(breaker.snapshot().state).toBe("open");

    let called = false;
    const trackingFetch = (async () => {
      called = true;
      return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 });
    }) as unknown as typeof fetch;
    const second = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: trackingFetch,
      dnsLookup: publicDns,
      breaker,
      clock: () => 1,
    });
    expect(second).toEqual({ ok: false, stage: "circuit-open" });
    expect(called).toBe(false);
  });

  it("with a breaker: success resets it after a prior failure", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 5 });
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await fetchPluginManifest("http://plugin.example", { fetchImpl: failingFetch, dnsLookup: publicDns, breaker, clock: () => 0 });
    expect(breaker.snapshot().consecutiveFailures).toBe(1);

    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(200, JSON.stringify(VALID_MANIFEST)),
      dnsLookup: publicDns,
      breaker,
      clock: () => 1,
    });
    expect(result.ok).toBe(true);
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("respects an explicit maxResponseBytes override even for a small manifest", async () => {
    const result = await fetchPluginManifest("http://plugin.example", {
      fetchImpl: fakeFetch(200, JSON.stringify(VALID_MANIFEST)),
      dnsLookup: publicDns,
      maxResponseBytes: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === "transport") {
      expect(result.reason).toBe("response-too-large");
    }
  });
});
