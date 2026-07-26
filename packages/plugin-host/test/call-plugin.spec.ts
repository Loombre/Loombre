// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/test/call-plugin.spec.ts
//
// callPlugin's composition of breaker admission + hardenedFetch + breaker
// outcome recording (LD2/LD8) — the seam W3/W4 call through. Uses a fake
// fetchImpl for the success/failure-classification cases and one real
// hung-server timeout case (mirroring the mission's own e2e scenario:
// "breaker auto-disable after 5 timeouts").

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { PluginCircuitBreaker } from "../src/breaker.js";
import { callPlugin } from "../src/call-plugin.js";
import type { DnsLookupFn } from "../src/ssrf.js";

const publicDns: DnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

describe("callPlugin", () => {
  it("returns ok:true on a successful call and resets the breaker", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    breaker.onFailure(0); // pre-trip so we can prove success resets it
    breaker.reset(); // start clean for this assertion
    const fetchImpl = (async () => new Response("hello", { status: 200 })) as unknown as typeof fetch;
    const result = await callPlugin(
      "http://plugin.example/x",
      {},
      { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicDns, fetchImpl, breaker, clock: () => 0 },
    );
    expect(result).toMatchObject({ ok: true, status: 200, bodyText: "hello" });
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("short-circuits with reason='circuit-open' when the breaker is open, without touching the network", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 999_999 });
    breaker.onFailure(0);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await callPlugin(
      "http://plugin.example/x",
      {},
      { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicDns, fetchImpl, breaker, clock: () => 1 },
    );
    expect(result).toEqual({ ok: false, reason: "circuit-open" });
    expect(called).toBe(false);
  });

  it("merges caller headers under opts.headers (opts.headers wins on collision)", async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await callPlugin(
      "http://plugin.example/x",
      { headers: { "x-caller": "1", "x-lpp-config": "stale" } },
      { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicDns, fetchImpl, headers: { "x-lpp-config": "fresh" } },
    );
    expect(seenHeaders?.get("x-caller")).toBe("1");
    expect(seenHeaders?.get("x-lpp-config")).toBe("fresh");
  });

  it("does NOT count a disallowed-address (SSRF) rejection against the breaker — only timeout/network-error do", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    const result = await callPlugin(
      "http://127.0.0.1:9/x",
      {},
      { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicDns, breaker, clock: () => 0 },
    );
    expect(result).toMatchObject({ ok: false, reason: "disallowed-address" });
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("M-8: a non-2xx HTTP status counts as a breaker FAILURE (not a success)", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    const fetchImpl = (async () => new Response("internal error", { status: 500 })) as unknown as typeof fetch;
    const result = await callPlugin(
      "http://plugin.example/x",
      {},
      { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicDns, fetchImpl, breaker, clock: () => 0 },
    );
    // Transport succeeded — callPlugin still returns ok:true with the
    // status; it's the BREAKER accounting that changed (M-8 fix wave: a
    // plugin that fast-fails every call with e.g. HTTP 500 used to
    // accumulate NOTHING against the breaker, so it never tripped open and
    // never auto-disabled).
    expect(result).toMatchObject({ ok: true, status: 500 });
    expect(breaker.snapshot()).toMatchObject({ state: "open", consecutiveFailures: 1 });
  });

  it("M-8: a 2xx status still counts as a breaker SUCCESS (unchanged)", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    breaker.onFailure(0);
    breaker.reset();
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const result = await callPlugin(
      "http://plugin.example/x",
      {},
      { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicDns, fetchImpl, breaker, clock: () => 0 },
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("H-3: never rethrows — an unexpected (non-HardenedFetchError-shaped) throw from fetchImpl never escapes as an exception, and is counted against the breaker", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    // A raw, untyped throw — exactly the SHAPE H-3 found escaping from
    // ssrf.ts's readCapped before that fix (a raw DOMException, not a
    // HardenedFetchError). hardenedFetch's own catch already converts a
    // synchronous fetchImpl throw into a typed HardenedFetchError, so this
    // proves the END-TO-END guarantee ("callPlugin never throws, and
    // counts the failure") holds regardless of which layer does the
    // conversion — callPlugin's OWN `catch (err) { ... else { map to
    // network-error } }` fallback is the belt-and-braces layer for any
    // throw that reaches IT directly, un-converted.
    const fetchImpl = (async () => {
      throw new DOMException("aborted mid-body", "AbortError");
    }) as unknown as typeof fetch;
    let thrown = false;
    let result;
    try {
      result = await callPlugin(
        "http://plugin.example/x",
        {},
        { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicDns, fetchImpl, breaker, clock: () => 0 },
      );
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false); // the documented "never throws" contract
    expect(result).toMatchObject({ ok: false, reason: "network-error" });
    expect(breaker.snapshot()).toMatchObject({ state: "open", consecutiveFailures: 1 });
  });

  it("a network-error counts against the breaker", async () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await callPlugin(
      "http://plugin.example/x",
      {},
      { timeoutMs: 1000, maxResponseBytes: 1024, dnsLookup: publicDns, fetchImpl, breaker, clock: () => 0 },
    );
    expect(result).toMatchObject({ ok: false, reason: "network-error" });
    expect(breaker.snapshot().state).toBe("open");
  });

  describe("real timeout against a hung server (mission scenario: repeated timeouts trip the breaker)", () => {
    const servers: Server[] = [];
    afterEach(async () => {
      await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
    });

    it("5 consecutive timeouts trip the breaker open, exactly on the 5th", async () => {
      const server = createServer(() => {
        // never respond
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}/`;

      const breaker = new PluginCircuitBreaker({ failureThreshold: 5 });
      let lastResult;
      for (let i = 0; i < 5; i++) {
        lastResult = await callPlugin(
          baseUrl,
          {},
          { timeoutMs: 100, maxResponseBytes: 1024, lanAllowlist: ["127.0.0.1"], breaker, clock: () => i },
        );
        expect(lastResult).toMatchObject({ ok: false, reason: "timeout" });
      }
      expect(breaker.snapshot().state).toBe("open");
      expect(breaker.snapshot().consecutiveFailures).toBe(5);

      // A 6th call while open never touches the network — circuit-open.
      const sixth = await callPlugin(
        baseUrl,
        {},
        { timeoutMs: 100, maxResponseBytes: 1024, lanAllowlist: ["127.0.0.1"], breaker, clock: () => 5 },
      );
      expect(sixth).toEqual({ ok: false, reason: "circuit-open" });
    }, 15_000);
  });
});
