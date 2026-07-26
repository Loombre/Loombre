// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/csp.test.ts
//
// Non-browser verification (this lane's RESOURCE ISOLATION: the browser is
// orchestrator-owned this wave) — proves the STRING the middleware would
// send is correct by construction. It CANNOT prove a real browser accepts
// it/doesn't block hydration — see this task's report for the browser
// checklist the orchestrator must run for that.

import { describe, expect, it } from "vitest";
import { buildCsp, generateNonce, resolveServerOrigins } from "./csp.js";

describe("generateNonce", () => {
  it("produces a base64 string of the expected length (16 random bytes)", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // 16 bytes base64-encoded -> 24 chars incl. padding.
    expect(nonce.length).toBe(24);
  });

  it("is different on every call (not a static/cached value)", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
  });
});

describe("resolveServerOrigins", () => {
  it("empty when unset", () => {
    expect(resolveServerOrigins(undefined)).toEqual([]);
  });

  it("splits, trims, and strips trailing slashes — same convention as apps/server's resolveCorsOrigins", () => {
    expect(resolveServerOrigins("https://api.example.com/ , https://other.example.com")).toEqual([
      "https://api.example.com",
      "https://other.example.com",
    ]);
  });

  it("drops empty entries", () => {
    expect(resolveServerOrigins("https://a.example.com,,  ,")).toEqual(["https://a.example.com"]);
  });
});

describe("buildCsp", () => {
  const nonce = "TEST_NONCE_VALUE_1234";

  it("REGRESSION GUARD: media-src always keeps blob: (Phase 3's own scar tissue — hls.js MediaSource attach)", () => {
    const withOrigin = buildCsp({ nonce, isDev: false, serverOrigins: ["https://api.example.com"] });
    const withoutOrigin = buildCsp({ nonce, isDev: false, serverOrigins: [] });
    expect(withOrigin).toMatch(/media-src[^;]*\bblob:/);
    expect(withoutOrigin).toMatch(/media-src[^;]*\bblob:/);
  });

  it("script-src carries the nonce + strict-dynamic and NEVER 'unsafe-inline' (closes the Phase 2 Open item)", () => {
    const csp = buildCsp({ nonce, isDev: false, serverOrigins: [] });
    const scriptSrc = extractDirective(csp, "script-src");
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("unsafe-inline");
  });

  it("dev mode adds 'unsafe-eval' to script-src only; production never carries it", () => {
    const dev = extractDirective(buildCsp({ nonce, isDev: true, serverOrigins: [] }), "script-src");
    const prod = extractDirective(buildCsp({ nonce, isDev: false, serverOrigins: [] }), "script-src");
    expect(dev).toContain("'unsafe-eval'");
    expect(prod).not.toContain("unsafe-eval");
  });

  it("style-src keeps 'unsafe-inline' (documented: inline style={{}} props across 13 files, no CSP nonce mechanism for style attributes)", () => {
    const csp = buildCsp({ nonce, isDev: false, serverOrigins: [] });
    expect(extractDirective(csp, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("with NO LOOMBRE_SERVER_ORIGIN configured: falls back to the documented scheme-wildcard posture", () => {
    const csp = buildCsp({ nonce, isDev: false, serverOrigins: [] });
    expect(extractDirective(csp, "connect-src")).toEqual(["'self'", "http:", "https:", "ws:", "wss:"]);
    expect(extractDirective(csp, "img-src")).toEqual(["'self'", "data:", "blob:", "http:", "https:"]);
    expect(extractDirective(csp, "media-src")).toEqual(["'self'", "blob:", "http:", "https:"]);
  });

  it("with LOOMBRE_SERVER_ORIGIN configured: tightens connect/img/media-src to 'self' + the explicit origin (task-mandated tightening)", () => {
    const csp = buildCsp({ nonce, isDev: false, serverOrigins: ["https://api.example.com"] });
    expect(extractDirective(csp, "connect-src")).not.toContain("https:");
    expect(extractDirective(csp, "connect-src")).not.toContain("http:");
    expect(extractDirective(csp, "connect-src")).toEqual(["'self'", "https://api.example.com", "wss://api.example.com"]);
    expect(extractDirective(csp, "img-src")).toEqual(["'self'", "data:", "blob:", "https://api.example.com"]);
    expect(extractDirective(csp, "media-src")).toEqual(["'self'", "blob:", "https://api.example.com"]);
  });

  it("supports multiple configured server origins", () => {
    const csp = buildCsp({ nonce, isDev: false, serverOrigins: ["https://a.example.com", "http://b.example.com"] });
    const connectSrc = extractDirective(csp, "connect-src");
    expect(connectSrc).toContain("https://a.example.com");
    expect(connectSrc).toContain("wss://a.example.com");
    expect(connectSrc).toContain("http://b.example.com");
    expect(connectSrc).toContain("ws://b.example.com");
  });

  it("keeps the other closed-vector directives unchanged", () => {
    const csp = buildCsp({ nonce, isDev: false, serverOrigins: [] });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'");
  });

  it("REGRESSION GUARD (U6): font-src is 'self'-only, in every mode/origin combination — Phosphor self-hosts Archivo + IBM Plex Mono under public/fonts/, so no fonts.googleapis.com/fonts.gstatic.com allowance may ever exist", () => {
    for (const isDev of [true, false]) {
      for (const serverOrigins of [[], ["https://api.example.com"], ["https://a.example.com", "http://b.example.com"]]) {
        const csp = buildCsp({ nonce, isDev, serverOrigins });
        expect(extractDirective(csp, "font-src")).toEqual(["'self'"]);
        expect(csp).not.toMatch(/fonts\.googleapis\.com/);
        expect(csp).not.toMatch(/fonts\.gstatic\.com/);
      }
    }
  });
});

function extractDirective(csp: string, name: string): string[] {
  const directive = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);
  if (!directive) throw new Error(`directive "${name}" not found in: ${csp}`);
  return directive.slice(name.length).trim().split(/\s+/);
}
