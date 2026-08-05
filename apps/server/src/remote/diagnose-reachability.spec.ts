// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/diagnose-reachability.spec.ts
//
// Fast unit coverage (stub deps, no I/O) for the orchestration logic:
// Tunnel-path short-circuit ordering, DNS-failure handling, and the
// classifyReachability hand-off. Real node:dns wiring is proven separately
// (remote-dns-resolver.service.spec.ts); real ConnectorHealthReaderService
// wiring is proven by its own default-value test below.

import { describe, expect, it, vi } from "vitest";
import { diagnoseReachability, extractHostname } from "./diagnose-reachability.js";
import { ConnectorHealthReaderService, type ConnectorHealth } from "./connector-health.service.js";
import { RemoteDnsResolverService } from "./remote-dns-resolver.service.js";

function stubDeps(opts: { connectorHealth?: ConnectorHealth; resolvedAddress?: string | null }) {
  const connectorHealthReader = new ConnectorHealthReaderService();
  vi.spyOn(connectorHealthReader, "read").mockResolvedValue(opts.connectorHealth ?? "unknown");
  const dnsResolver = new RemoteDnsResolverService();
  // `resolvedAddress` may be legitimately `null` (simulating a DNS-lookup
  // failure) — "resolvedAddress" in opts distinguishes "explicitly null"
  // from "not provided at all" (nullish-coalescing would collapse both).
  const resolved: string | null = "resolvedAddress" in opts ? (opts.resolvedAddress as string | null) : "203.0.113.10";
  vi.spyOn(dnsResolver, "resolvePublicAddress").mockResolvedValue(resolved);
  return { connectorHealthReader, dnsResolver };
}

describe("extractHostname", () => {
  it("passes a bare host through unchanged", () => {
    expect(extractHostname("loombre.example.com")).toBe("loombre.example.com");
  });
  it("strips a scheme", () => {
    expect(extractHostname("https://loombre.example.com")).toBe("loombre.example.com");
  });
  it("strips a trailing path", () => {
    expect(extractHostname("loombre.example.com/probe/abc")).toBe("loombre.example.com");
  });
  it("strips a numeric port", () => {
    expect(extractHostname("loombre.example.com:8443")).toBe("loombre.example.com");
  });
  it("strips scheme + port + path together", () => {
    expect(extractHostname("https://loombre.example.com:8443/x?y=1")).toBe("loombre.example.com");
  });
});

describe("diagnoseReachability", () => {
  it("Tunnel-path short-circuit FIRST: connector 'down' -> tunnelDown, WAN classification never consulted", async () => {
    const deps = stubDeps({ connectorHealth: "down" });
    const result = await diagnoseReachability(
      { path: "tunnel", expectedEndpoint: "tunnel.example.com", wanAddress: null },
      deps,
    );
    expect(result.code).toBe("tunnelDown");
    expect(deps.dnsResolver.resolvePublicAddress).not.toHaveBeenCalled();
  });

  it("Tunnel-path short-circuit: connector 'degraded' -> connectorUnhealthy, WAN classification never consulted", async () => {
    const deps = stubDeps({ connectorHealth: "degraded" });
    const result = await diagnoseReachability(
      { path: "tunnel", expectedEndpoint: "tunnel.example.com", wanAddress: null },
      deps,
    );
    expect(result.code).toBe("connectorUnhealthy");
    expect(deps.dnsResolver.resolvePublicAddress).not.toHaveBeenCalled();
  });

  it("Tunnel-path: connector 'unknown' (the default no-op) falls through to WAN classification", async () => {
    const deps = stubDeps({ connectorHealth: "unknown", resolvedAddress: "203.0.113.10" });
    const result = await diagnoseReachability(
      { path: "tunnel", expectedEndpoint: "tunnel.example.com", wanAddress: "203.0.113.10" },
      deps,
    );
    expect(deps.dnsResolver.resolvePublicAddress).toHaveBeenCalled();
    // WAN === resolvedPublicAddress and probeArrived is always false here
    // (this function is only invoked in the failure-diagnosis flow) ->
    // portBlocked, per classifyReachability's own rule 4.
    expect(result.code).toBe("portBlocked");
  });

  it("Tunnel-path: connector 'healthy' also falls through to WAN classification", async () => {
    const deps = stubDeps({ connectorHealth: "healthy", resolvedAddress: "203.0.113.10" });
    const result = await diagnoseReachability(
      { path: "tunnel", expectedEndpoint: "tunnel.example.com", wanAddress: null },
      deps,
    );
    expect(deps.dnsResolver.resolvePublicAddress).toHaveBeenCalled();
    expect(result.code).toBe("unknown"); // no wanAddress supplied
  });

  it("non-tunnel paths never consult connector health at all", async () => {
    const deps = stubDeps({ resolvedAddress: "203.0.113.10" });
    await diagnoseReachability({ path: "direct", expectedEndpoint: "direct.example.com", wanAddress: null }, deps);
    await diagnoseReachability({ path: "remote", expectedEndpoint: "remote.example.com", wanAddress: null }, deps);
    expect(deps.connectorHealthReader.read).not.toHaveBeenCalled();
  });

  it("DNS resolution failure (its own signal) -> dnsMismatch with a distinguishing detail, WAN classification never reached", async () => {
    const deps = stubDeps({ resolvedAddress: null });
    const result = await diagnoseReachability(
      { path: "direct", expectedEndpoint: "does-not-resolve.invalid", wanAddress: "198.51.100.1" },
      deps,
    );
    expect(result.code).toBe("dnsMismatch");
    expect(result.detail).toContain("does not resolve at all");
    expect(result.detail).toContain("does-not-resolve.invalid");
  });

  it("hands the extracted hostname (not the raw expectedEndpoint) to the DNS resolver", async () => {
    const deps = stubDeps({ resolvedAddress: "203.0.113.10" });
    await diagnoseReachability({ path: "direct", expectedEndpoint: "https://loombre.example.com:8443/x", wanAddress: null }, deps);
    expect(deps.dnsResolver.resolvePublicAddress).toHaveBeenCalledWith("loombre.example.com");
  });

  it("real WAN classification hand-off: CGNAT WAN address -> cgnat, regardless of path", async () => {
    const deps = stubDeps({ resolvedAddress: "203.0.113.10" });
    const result = await diagnoseReachability(
      { path: "remote", expectedEndpoint: "remote.example.com", wanAddress: "100.64.5.5" },
      deps,
    );
    expect(result.code).toBe("cgnat");
  });

  it("real WAN classification hand-off: WAN === resolved + (implicit probeArrived:false) -> portBlocked", async () => {
    const deps = stubDeps({ resolvedAddress: "203.0.113.10" });
    const result = await diagnoseReachability(
      { path: "direct", expectedEndpoint: "direct.example.com", wanAddress: "203.0.113.10" },
      deps,
    );
    expect(result.code).toBe("portBlocked");
  });

  it("detail is always the per-path guidance-mapping output for the returned code (never hand-rolled here for non-DNS-failure/non-tunnel-short-circuit cases)", async () => {
    const deps = stubDeps({ resolvedAddress: "203.0.113.10" });
    const result = await diagnoseReachability(
      { path: "remote", expectedEndpoint: "remote.example.com", wanAddress: "100.64.5.5" },
      deps,
    );
    const { diagnosisGuidance } = await import("@loombre/shared");
    expect(result.detail).toBe(diagnosisGuidance("remote", "cgnat"));
  });
});

describe("ConnectorHealthReaderService (the real, unstubbed default)", () => {
  it("returns 'unknown' — the deliberate no-op default (T2's future seam)", async () => {
    const service = new ConnectorHealthReaderService();
    await expect(service.read()).resolves.toBe("unknown");
  });
});
