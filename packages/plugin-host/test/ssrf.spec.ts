// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/test/ssrf.spec.ts
//
// LD5 matrix: address classification (isDisallowedAddress), hostname
// resolution + allowlist override (assertHostAllowed, with an injected
// DnsLookupFn — never real DNS), and hardenedFetch's transport-level rules
// (scheme, redirect, timeout, size cap) against REAL ephemeral-port local
// HTTP servers so the streaming/abort behavior is proven against Node's
// actual fetch implementation, not a mock.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import {
  assertHostAllowed,
  hardenedFetch,
  HardenedFetchError,
  isDisallowedAddress,
  resolveAndValidateHost,
  stripIPv6Brackets,
  type DnsLookupFn,
} from "../src/ssrf.js";

describe("isDisallowedAddress", () => {
  it.each([
    ["127.0.0.1", true, "IPv4 loopback"],
    ["127.255.255.255", true, "IPv4 loopback range"],
    ["10.0.0.1", true, "10/8 private"],
    ["10.255.255.255", true, "10/8 private range end"],
    ["172.16.0.1", true, "172.16/12 private (start)"],
    ["172.31.255.255", true, "172.16/12 private (end)"],
    ["172.15.255.255", false, "just below 172.16/12"],
    ["172.32.0.1", false, "just above 172.16/12"],
    ["192.168.1.1", true, "192.168/16 private"],
    ["169.254.1.1", true, "169.254/16 link-local"],
    ["0.0.0.0", true, "unspecified"],
    ["224.0.0.1", true, "multicast"],
    ["239.255.255.255", true, "multicast range end"],
    ["255.255.255.255", true, "broadcast"],
    ["8.8.8.8", false, "public IPv4"],
    ["1.1.1.1", false, "public IPv4"],
    ["::1", true, "IPv6 loopback"],
    ["::", true, "IPv6 unspecified"],
    ["fe80::1", true, "IPv6 link-local"],
    ["fe80::abcd:1234", true, "IPv6 link-local (variant)"],
    ["fc00::1", true, "IPv6 ULA (fc00::/7 start)"],
    ["fd12:3456::1", true, "IPv6 ULA (fc00::/7, fd block)"],
    ["ff02::1", true, "IPv6 multicast"],
    ["::ffff:127.0.0.1", true, "IPv4-mapped loopback (dotted form)"],
    ["::ffff:10.0.0.5", true, "IPv4-mapped private (dotted form)"],
    ["::ffff:8.8.8.8", false, "IPv4-mapped public (dotted form)"],
    ["2001:4860:4860::8888", false, "public IPv6 (Google DNS)"],
    ["not-an-ip", true, "malformed input fails closed"],
    // M-5 fix wave: the HEX form of an IPv4-mapped address (exactly what
    // WHATWG `URL` normalizes `[::ffff:127.0.0.1]` to) — the OLD classifier
    // only recognized the dotted-quad textual form via a regex and
    // classified this as ALLOWED (a live loopback-SSRF-shaped bug once the
    // separate bracket-stripping bug was fixed without this one).
    ["::ffff:7f00:1", true, "IPv4-mapped loopback (HEX form — the actual bug M-5 found)"],
    ["::ffff:a00:5", true, "IPv4-mapped private 10.0.0.5 (hex form)"],
    ["::ffff:808:808", false, "IPv4-mapped public 8.8.8.8 (hex form)"],
    // M-5 fix wave: NAT64 (RFC 6052) and 6to4 (RFC 3056) embeddings.
    ["64:ff9b::7f00:1", true, "NAT64 well-known prefix embedding 127.0.0.1"],
    ["64:ff9b::808:808", false, "NAT64 well-known prefix embedding public 8.8.8.8"],
    ["2002:7f00:1::", true, "6to4 embedding 127.0.0.1"],
    ["2002:808:808::", false, "6to4 embedding public 8.8.8.8"],
    // Deprecated IPv4-compatible form (::a.b.c.d, no ffff).
    ["::127.0.0.1", true, "deprecated IPv4-compatible loopback"],
    // M-6 fix wave: additional IPv4 deny ranges.
    ["100.64.0.1", true, "CGNAT 100.64.0.0/10 (start)"],
    ["100.100.100.200", true, "CGNAT — Alibaba Cloud metadata service"],
    ["100.127.255.255", true, "CGNAT 100.64.0.0/10 (end)"],
    ["100.63.255.255", false, "just below CGNAT range"],
    ["100.128.0.0", false, "just above CGNAT range"],
    ["192.0.0.1", true, "IETF protocol assignments 192.0.0.0/24"],
    ["192.0.2.1", true, "TEST-NET-1 192.0.2.0/24"],
    ["198.18.0.1", true, "benchmarking 198.18.0.0/15 (start)"],
    ["198.19.255.255", true, "benchmarking 198.18.0.0/15 (end)"],
    ["198.51.100.1", true, "TEST-NET-2 198.51.100.0/24"],
    ["203.0.113.1", true, "TEST-NET-3 203.0.113.0/24"],
    ["240.0.0.1", true, "reserved 240.0.0.0/4"],
    ["255.0.0.1", true, "reserved 240.0.0.0/4 (upper end)"],
  ])("%s -> disallowed=%s (%s)", (address, expected) => {
    expect(isDisallowedAddress(address)).toBe(expected);
  });
});

describe("stripIPv6Brackets", () => {
  it("strips brackets from a bracketed IPv6 literal", () => {
    expect(stripIPv6Brackets("[::1]")).toBe("::1");
    expect(stripIPv6Brackets("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("is a no-op for anything not bracketed", () => {
    expect(stripIPv6Brackets("example.com")).toBe("example.com");
    expect(stripIPv6Brackets("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("assertHostAllowed", () => {
  const rejectingLookup: DnsLookupFn = async () => {
    throw new Error("boom");
  };

  it("resolves silently for a public IP literal hostname", async () => {
    await expect(assertHostAllowed("93.184.216.34", [])).resolves.toBeUndefined();
  });

  it("rejects a private IP literal hostname with disallowed-address", async () => {
    await expect(assertHostAllowed("192.168.1.1", [])).rejects.toMatchObject({ reason: "disallowed-address" });
  });

  it("allows a private IP literal when it exactly matches lan_allowlist", async () => {
    await expect(assertHostAllowed("192.168.1.1", ["192.168.1.1"])).resolves.toBeUndefined();
  });

  it("lan_allowlist match is case-insensitive on hostnames", async () => {
    const lookup: DnsLookupFn = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(assertHostAllowed("Plugin.Internal", ["plugin.internal"], lookup)).resolves.toBeUndefined();
  });

  it("rejects a hostname that resolves to a private address, via injected DNS", async () => {
    const lookup: DnsLookupFn = async () => [{ address: "10.1.2.3", family: 4 }];
    await expect(assertHostAllowed("evil.example", [], lookup)).rejects.toMatchObject({ reason: "disallowed-address" });
  });

  it("rejects if ANY resolved address is disallowed, even when others are public", async () => {
    const lookup: DnsLookupFn = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(assertHostAllowed("mixed.example", [], lookup)).rejects.toMatchObject({ reason: "disallowed-address" });
  });

  it("allows a hostname whose every resolved address is public", async () => {
    const lookup: DnsLookupFn = async () => [{ address: "8.8.8.8", family: 4 }];
    await expect(assertHostAllowed("public.example", [], lookup)).resolves.toBeUndefined();
  });

  it("a hostname allowlisted by name is never DNS-resolved at all", async () => {
    let called = false;
    const lookup: DnsLookupFn = async () => {
      called = true;
      return [{ address: "10.0.0.1", family: 4 }];
    };
    await expect(assertHostAllowed("plugin.lan", ["plugin.lan"], lookup)).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("propagates dns-resolution-failed when the lookup throws", async () => {
    await expect(assertHostAllowed("broken.example", [], rejectingLookup)).rejects.toMatchObject({
      reason: "dns-resolution-failed",
    });
  });

  it("propagates dns-resolution-failed when the lookup returns no addresses", async () => {
    const lookup: DnsLookupFn = async () => [];
    await expect(assertHostAllowed("empty.example", [], lookup)).rejects.toMatchObject({
      reason: "dns-resolution-failed",
    });
  });
});

describe("hardenedFetch (real ephemeral-port local servers)", () => {
  const servers: Server[] = [];
  const publicLookup: DnsLookupFn = async () => [{ address: "127.0.0.1", family: 4 }];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
  });

  async function listen(handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("rejects a non-http(s) scheme before ever touching the network", async () => {
    await expect(
      hardenedFetch("ftp://example.invalid/x", {}, { timeoutMs: 1000, maxResponseBytes: 1024 }),
    ).rejects.toMatchObject({ reason: "unsupported-scheme" });
  });

  it("rejects an unparseable URL", async () => {
    await expect(hardenedFetch("not a url", {}, { timeoutMs: 1000, maxResponseBytes: 1024 })).rejects.toMatchObject({
      reason: "invalid-url",
    });
  });

  it("127.0.0.1 (loopback) is rejected by default, without lan_allowlist", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await expect(
      hardenedFetch(baseUrl, {}, { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "disallowed-address" });
  });

  it("127.0.0.1 succeeds when present in lan_allowlist", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const host = new URL(baseUrl).hostname;
    const result = await hardenedFetch(
      baseUrl,
      {},
      { timeoutMs: 1000, maxResponseBytes: 1024, lanAllowlist: [host], dnsLookup: publicLookup },
    );
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe('{"ok":true}');
  });

  it("never follows a 3xx redirect — surfaced as a typed rejection", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(302, { location: "http://example.invalid/elsewhere" });
      res.end();
    });
    const host = new URL(baseUrl).hostname;
    await expect(
      hardenedFetch(baseUrl, {}, { timeoutMs: 1000, maxResponseBytes: 1024, lanAllowlist: [host], dnsLookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "redirect-not-followed" });
  });

  it("times out a hung response within the configured budget", async () => {
    const baseUrl = await listen(() => {
      // Never respond — the socket just hangs.
    });
    const host = new URL(baseUrl).hostname;
    const start = Date.now();
    await expect(
      hardenedFetch(baseUrl, {}, { timeoutMs: 150, maxResponseBytes: 1024, lanAllowlist: [host], dnsLookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  // H-3 fix wave: the SSRF matrix covered scheme/redirect/size-cap/loopback
  // and a timeout BEFORE any response arrived at all, but had no case for a
  // plugin that responds PROMPTLY (headers sent, `fetchImpl`'s own promise
  // resolves) and then drips the body slowly enough to trip the SAME
  // AbortController's timeout DURING the streamed read — which is exactly
  // the shape that previously escaped as a raw, untyped
  // `DOMException: AbortError` (readCapped's abort was not classified),
  // skipping breaker/backoff accounting at every call site (delivery loop,
  // metadata adapter) because `callPlugin`'s `instanceof HardenedFetchError`
  // catch did not recognize it and rethrew.
  it("H-3: a timeout firing mid-BODY-STREAM (headers already received) is a typed 'timeout', not an untyped abort", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial-body-then-silence");
      // Deliberately never res.end() — headers + some body arrive, then the
      // connection just hangs, exactly the "responds promptly then drips"
      // shape H-3 found missing from this matrix.
    });
    const host = new URL(baseUrl).hostname;
    const start = Date.now();
    await expect(
      hardenedFetch(baseUrl, {}, { timeoutMs: 150, maxResponseBytes: 1_000_000, lanAllowlist: [host], dnsLookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("enforces the response size cap while streaming, aborting rather than buffering an oversized body", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      // Write well past the cap in chunks so this exercises the streaming
      // path, not just a single oversized write.
      const chunk = Buffer.alloc(1024, 65);
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        res.write(chunk);
      }, 5);
      res.on("close", () => clearInterval(timer));
    });
    const host = new URL(baseUrl).hostname;
    await expect(
      hardenedFetch(baseUrl, {}, { timeoutMs: 5000, maxResponseBytes: 2048, lanAllowlist: [host], dnsLookup: publicLookup }),
    ).rejects.toMatchObject({ reason: "response-too-large" });
  });

  it("a body at or under the cap succeeds", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(100));
    });
    const host = new URL(baseUrl).hostname;
    const result = await hardenedFetch(
      baseUrl,
      {},
      { timeoutMs: 1000, maxResponseBytes: 200, lanAllowlist: [host], dnsLookup: publicLookup },
    );
    expect(result.status).toBe(200);
    expect(result.bodyText).toHaveLength(100);
  });

  it("HardenedFetchError carries both `reason` and the offending url/hostname", async () => {
    try {
      await hardenedFetch("ftp://plugin.example/x", {}, { timeoutMs: 1000, maxResponseBytes: 1024 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HardenedFetchError);
      expect((err as HardenedFetchError).reason).toBe("unsupported-scheme");
    }
  });

  // M-5 fix wave, end-to-end: a bracketed IPv6 literal (`URL.hostname` for
  // `http://[::1]/` is the literal string `"[::1]"`) now round-trips
  // through the SAME `lan_allowlist` bypass an IPv4 literal already used —
  // before this fix, EVERY IPv6 literal fell through to the DNS-lookup
  // branch (isIP("[::1]") === 0) and failed as 'dns-resolution-failed',
  // never 'disallowed-address', making IPv6 LAN plugins entirely
  // unreachable regardless of allowlist (a functional bug) while
  // ALSO leaving the classifier itself untested against real traffic.
  it("M-5: an IPv6 loopback literal (bracketed, as URL.hostname produces it) is rejected by default and succeeds via lan_allowlist", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ipv6-ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://[::1]:${port}`;

    await expect(hardenedFetch(baseUrl, {}, { timeoutMs: 1000, maxResponseBytes: 1024 })).rejects.toMatchObject({
      reason: "disallowed-address",
    });

    const result = await hardenedFetch(baseUrl, {}, { timeoutMs: 1000, maxResponseBytes: 1024, lanAllowlist: ["::1"] });
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe("ipv6-ok");
  });
});

// ---------------------------------------------------------------------------
// DNS-rebinding fix wave: resolveAndValidateHost (pinning DECISION)
// ---------------------------------------------------------------------------
//
// `pinnedDialFetch` (the actual socket-level pinning) is exercised for real,
// against real local servers, by every `lan_allowlist`-gated test above
// (an IP literal always resolves to `{ pinnedAddress: <that literal> }`,
// which is exactly what those tests dial through) — see this file's own
// `ssrf.ts` header for why a genuinely public-but-locally-reachable address
// does not exist in this sandbox, so the DNS-NAME pinning path is proven at
// the DECISION layer here (which address gets chosen to pin, and that it is
// resolved EXACTLY ONCE) rather than via a second live socket.
describe("resolveAndValidateHost (pinning decision)", () => {
  it("an IP literal pins to itself, regardless of allowlist", async () => {
    const resolution = await resolveAndValidateHost("93.184.216.34", [], async () => {
      throw new Error("must not be called for an IP literal");
    });
    expect(resolution).toEqual({ pinnedAddress: "93.184.216.34", family: 4 });
  });

  it("a DNS name resolves EXACTLY ONCE and pins to the FIRST validated address — the DNS-rebinding fix", async () => {
    let callCount = 0;
    const lookup: DnsLookupFn = async () => {
      callCount += 1;
      // A genuinely public-looking address (per isDisallowedAddress) —
      // simulates the FIRST, honest answer a rebinding attacker's DNS
      // server would give during validation.
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "203.0.113.9", family: 4 }, // TEST-NET-3, deliberately disallowed — proves "reject if ANY resolved address is bad" still holds even with pinning
      ];
    };
    await expect(resolveAndValidateHost("rebind-test.invalid", [], lookup)).rejects.toMatchObject({
      reason: "disallowed-address",
    });
    expect(callCount).toBe(1);

    // With every resolved address genuinely public, the FIRST is what gets
    // pinned — this module never calls dnsLookup a SECOND time to decide
    // what to actually dial (the exact TOCTOU window this fix closes: the
    // address `hardenedFetch` connects to is this exact value, not a fresh
    // getaddrinfo() the platform's own connection layer might perform).
    const cleanLookup: DnsLookupFn = async () => {
      callCount += 1;
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ];
    };
    const resolution = await resolveAndValidateHost("rebind-test.invalid", [], cleanLookup);
    expect(resolution).toEqual({ pinnedAddress: "93.184.216.34", family: 4 });
    expect(callCount).toBe(2); // one call per resolveAndValidateHost invocation, never more
  });

  it("a hostname allowlisted by exact name is never resolved — the one documented residual (see ssrf.ts's header)", async () => {
    let called = false;
    const lookup: DnsLookupFn = async () => {
      called = true;
      return [{ address: "93.184.216.34", family: 4 }];
    };
    const resolution = await resolveAndValidateHost("plugin.lan", ["plugin.lan"], lookup);
    expect(resolution).toEqual({ pinnedAddress: null, family: null });
    expect(called).toBe(false);
  });

  it("an IPv6 DNS answer pins with family 6", async () => {
    const lookup: DnsLookupFn = async () => [{ address: "2001:4860:4860::8888", family: 6 }];
    const resolution = await resolveAndValidateHost("v6-only.invalid", [], lookup);
    expect(resolution).toEqual({ pinnedAddress: "2001:4860:4860::8888", family: 6 });
  });
});
