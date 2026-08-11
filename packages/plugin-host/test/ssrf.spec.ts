// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/test/ssrf.spec.ts
//
// LD5 matrix: address classification (isDisallowedAddress), hostname
// resolution + allowlist override (assertHostAllowed, with an injected
// DnsLookupFn — never real DNS), and hardenedFetch's transport-level rules
// (scheme, redirect, timeout, size cap) against REAL ephemeral-port local
// HTTP servers so the streaming/abort behavior is proven against Node's
// actual fetch implementation, not a mock.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import {
  assertHostAllowed,
  hardenedFetch,
  hardenedFetchRaw,
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

  it("C5.2: a hostname allowlisted by name IS DNS-resolved (once) — the allowlist only skips the disallowed-range check on the result", async () => {
    let callCount = 0;
    const lookup: DnsLookupFn = async () => {
      callCount += 1;
      return [{ address: "10.0.0.1", family: 4 }]; // a private LAN address the range check would otherwise reject
    };
    await expect(assertHostAllowed("plugin.lan", ["plugin.lan"], lookup)).resolves.toBeUndefined();
    expect(callCount).toBe(1);
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

  // C5.2 fix wave: end-to-end proof that the ACTUAL SOCKET DIAL for an
  // allowlisted-by-name hostname goes to the pinned address, not a fresh
  // resolution — real local server (not a mock transport), real
  // resolveAndValidateHost + pinnedDialFetch code path. A resolver that
  // would flip to an unreachable address on any second call proves, by the
  // request SUCCEEDING at all within the timeout, that no second lookup
  // ever happened.
  it("C5.2 end-to-end: hardenedFetch dials the address PINNED for an allowlisted hostname — a resolver whose 2nd answer would be unreachable is never asked twice", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const port = new URL(baseUrl).port;
    let callCount = 0;
    const flipLookup: DnsLookupFn = async () => {
      callCount += 1;
      if (callCount === 1) return [{ address: "127.0.0.1", family: 4 }]; // the real listening server
      return [{ address: "127.0.0.250", family: 4 }]; // never bound to anything — would time out if ever dialed
    };
    const result = await hardenedFetch(
      `http://plugin.lan:${port}/`,
      {},
      { timeoutMs: 1000, maxResponseBytes: 1024, lanAllowlist: ["plugin.lan"], dnsLookup: flipLookup },
    );
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe('{"ok":true}');
    expect(callCount).toBe(1); // resolved once at validation, dialed via the pin — never re-resolved
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

describe("hardenedFetchRaw (real ephemeral-port local servers)", () => {
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

  // R6 fix wave: the whole-request timer is deliberately left running (never
  // cleared) on the SUCCESS path — see this file's ssrf.ts header comment on
  // `hardenedFetchRaw` — so it can still abort a body that drips slowly
  // AFTER the caller has already received the `Response` and started
  // reading it. But a timer Node still considers a reason to keep running
  // is also a reason the EVENT LOOP stays open, which — multiplied across
  // every successful image download — delays worker shutdown for up to
  // `timeoutMs` after the last real work finished. `unref()` fixes exactly
  // that without weakening the abort: the timer still fires and still
  // aborts a slow-drip body; it just stops being, by itself, a reason the
  // process stays alive. This is asserted via `Timeout#hasRef()` (a real
  // runtime property of the timer Node scheduled), not merely "was
  // `.unref` invoked" — spying on `setTimeout` to capture the actual
  // `NodeJS.Timeout` and reading back its live ref-state is the closest
  // thing to observing "would this hold the event loop open" from inside a
  // single test process without spawning a child process and racing its
  // exit.
  it("R6: unrefs its timeout timer once a successful response comes back, so it cannot hold the event loop open on its own", async () => {
    const realSetTimeout = globalThis.setTimeout;
    let capturedTimer: NodeJS.Timeout | undefined;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((...args: Parameters<typeof setTimeout>) => {
        const t = realSetTimeout(...args);
        capturedTimer = t as unknown as NodeJS.Timeout;
        return t;
      }) as typeof setTimeout);

    try {
      const baseUrl = await listen((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      const host = new URL(baseUrl).hostname;

      const response = await hardenedFetchRaw(baseUrl, { timeoutMs: 5000, lanAllowlist: [host], dnsLookup: publicLookup });
      expect(response.status).toBe(200);

      expect(capturedTimer).toBeDefined();
      expect(capturedTimer!.hasRef()).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
      // Belt-and-suspenders: whatever this test found, don't let a
      // still-ref'd leftover timer from a failing run hold up the test
      // process's own exit.
      capturedTimer?.unref();
    }
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
// does not exist in this sandbox, so the DNS-NAME pinning path (including,
// as of C5.2, an ALLOWLISTED DNS name) is proven at the DECISION layer here
// (which address gets chosen to pin, and that it is resolved EXACTLY ONCE)
// — the "C5.2 end-to-end" case in the `hardenedFetch` describe block above
// additionally proves the real-socket dial for the allowlisted-hostname
// path specifically, since that is the path whose behavior just changed.
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

  // C5.2 fix wave: an allowlisted-by-name hostname used to be the ONE case
  // this module never resolved at all ("the admin already trusts that
  // name") — that reasoning was backwards: trusting a NAME is exactly what
  // a DNS-rebinding attacker exploits, by changing what the name resolves
  // to between validation and dial. It is now resolved and pinned exactly
  // like any other DNS name; the allowlist's only remaining effect is
  // skipping the disallowed-RANGE check (a LAN name legitimately resolves
  // to a private range).
  it("C5.2: a hostname allowlisted by exact name IS NOW resolved and pinned, not left unpinned", async () => {
    const resolution = await resolveAndValidateHost("plugin.lan", ["plugin.lan"], async () => [
      { address: "10.0.0.1", family: 4 }, // a private LAN address — legitimately what this resolves to
    ]);
    expect(resolution).toEqual({ pinnedAddress: "10.0.0.1", family: 4 });
  });

  it("C5.2 flip-resolver (RED-FIRST proof): the resolver is asked EXACTLY ONCE for an allowlisted hostname — a rebinding attacker's SECOND answer (B) is never observed, the pin stays A", async () => {
    let callCount = 0;
    const flipLookup: DnsLookupFn = async () => {
      callCount += 1;
      // Call 1 (validation): the honest answer, A. Any FURTHER call would
      // be the rebinding attacker's flip to B — proving this module makes
      // no further call is exactly what closes the TOCTOU window.
      if (callCount === 1) return [{ address: "10.0.0.1", family: 4 }]; // A
      return [{ address: "10.0.0.2", family: 4 }]; // B — must never be pinned
    };
    const resolution = await resolveAndValidateHost("plugin.lan", ["plugin.lan"], flipLookup);
    expect(resolution).toEqual({ pinnedAddress: "10.0.0.1", family: 4 }); // A, never B
    expect(callCount).toBe(1);
  });

  it("C5.2: a private address resolved for an allowlisted name is NOT rejected by the disallowed-range check (that check is skipped for it, not its resolution)", async () => {
    // Same private address the non-allowlisted path rejects outright
    // (proven by "rejects a hostname that resolves to a private address"
    // in the assertHostAllowed suite above) — the ONLY difference the
    // allowlist makes is that THIS call succeeds.
    const resolution = await resolveAndValidateHost("plugin.lan", ["plugin.lan"], async () => [{ address: "10.1.2.3", family: 4 }]);
    expect(resolution).toEqual({ pinnedAddress: "10.1.2.3", family: 4 });
  });

  it("C5.2: multiple A-records for an allowlisted LAN host still pin the FIRST address — same rule as any other DNS name", async () => {
    const resolution = await resolveAndValidateHost("plugin.lan", ["plugin.lan"], async () => [
      { address: "10.0.0.9", family: 4 },
      { address: "10.0.0.10", family: 4 },
    ]);
    expect(resolution).toEqual({ pinnedAddress: "10.0.0.9", family: 4 });
  });

  it("C5.2: a DNS failure for an allowlisted name now fails AT VALIDATION with dns-resolution-failed (previously this name was never resolved at all, so failure only ever surfaced later at the transport layer)", async () => {
    await expect(
      resolveAndValidateHost("plugin.lan", ["plugin.lan"], async () => {
        throw new Error("boom");
      }),
    ).rejects.toMatchObject({ reason: "dns-resolution-failed" });
  });

  it("an IP-literal lan_allowlist entry is unaffected by C5.2 — already pinned by the literal itself, no resolution involved either way", async () => {
    const resolution = await resolveAndValidateHost("10.5.5.5", ["10.5.5.5"], async () => {
      throw new Error("must not be called for an IP literal, allowlisted or not");
    });
    expect(resolution).toEqual({ pinnedAddress: "10.5.5.5", family: 4 });
  });

  it("an IPv6 DNS answer pins with family 6", async () => {
    const lookup: DnsLookupFn = async () => [{ address: "2001:4860:4860::8888", family: 6 }];
    const resolution = await resolveAndValidateHost("v6-only.invalid", [], lookup);
    expect(resolution).toEqual({ pinnedAddress: "2001:4860:4860::8888", family: 6 });
  });
});
