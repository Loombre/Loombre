// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/main.spec.ts
//
// Unit tests for LOOMBRE_TRUST_PROXY value parsing (STATE.md P2.2). The
// full "a forwarded request's rate-limit key uses the forwarded IP" e2e
// proof lives in apps/server/test/auth-security.e2e.spec.ts (needs a real
// booted app + supertest); this file covers just the pure env-parsing
// logic in isolation.

import { describe, expect, it, vi } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { applySecurityHeaders, disableXPoweredBy, resolveCorsOrigins, resolveTrustProxySetting } from "./main.js";

describe("resolveTrustProxySetting", () => {
  it("is undefined (disabled) when the env var is unset or empty", () => {
    expect(resolveTrustProxySetting(undefined)).toBeUndefined();
    expect(resolveTrustProxySetting("")).toBeUndefined();
    expect(resolveTrustProxySetting("   ")).toBeUndefined();
  });

  it("is undefined (disabled) for explicit falsy values", () => {
    expect(resolveTrustProxySetting("0")).toBeUndefined();
    expect(resolveTrustProxySetting("false")).toBeUndefined();
    expect(resolveTrustProxySetting("off")).toBeUndefined();
    expect(resolveTrustProxySetting("no")).toBeUndefined();
  });

  it("is boolean true for truthy flag values", () => {
    expect(resolveTrustProxySetting("1")).toBe(true);
    expect(resolveTrustProxySetting("true")).toBe(true);
    expect(resolveTrustProxySetting("TRUE")).toBe(true);
    expect(resolveTrustProxySetting("on")).toBe(true);
    expect(resolveTrustProxySetting("yes")).toBe(true);
  });

  it("parses a bare integer as an Express hop count", () => {
    expect(resolveTrustProxySetting("2")).toBe(2);
  });

  it("passes an Express preset/CIDR string straight through", () => {
    expect(resolveTrustProxySetting("loopback")).toBe("loopback");
    expect(resolveTrustProxySetting("10.0.0.0/8")).toBe("10.0.0.0/8");
  });
});

describe("resolveCorsOrigins", () => {
  it("defaults to the local dev pairing when unset", () => {
    expect(resolveCorsOrigins(undefined)).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
  });

  it("parses a comma-separated allowlist, trimming and stripping trailing slashes", () => {
    expect(resolveCorsOrigins(" https://media.example.com/ , http://10.0.0.5:3000 ")).toEqual([
      "https://media.example.com",
      "http://10.0.0.5:3000",
    ]);
  });

  it("resolves an explicit empty value to no CORS at all", () => {
    expect(resolveCorsOrigins("")).toEqual([]);
    expect(resolveCorsOrigins(" , ")).toEqual([]);
  });
});

/** Minimal fake of the Express instance surface applySecurityHeaders/
 *  disableXPoweredBy touch — lets these be unit-tested (same
 *  exported-function pattern as applyCors/applyTrustProxy above) without
 *  booting a real Nest app + DB connection. The real HTTP-level proof
 *  (headers present on an actual response, X-Powered-By actually absent —
 *  F3's specific ask) lives in apps/server/test/security-hardening.e2e.spec.ts
 *  against a real supertest request, same split as applyTrustProxy's own
 *  e2e coverage in auth-security.e2e.spec.ts. */
function fakeApp(): { app: INestApplication; use: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> } {
  const use = vi.fn();
  const disable = vi.fn();
  const instance = { use, disable };
  const app = {
    getHttpAdapter: () => ({ getInstance: () => instance }),
  } as unknown as INestApplication;
  return { app, use, disable };
}

describe("applySecurityHeaders", () => {
  // Phase 4 lane G1 deliverable 2 (STATE.md P4.15's "helmet-equivalent
  // set") extended this from the original F2 three headers to six —
  // Permissions-Policy, Cross-Origin-Resource-Policy, and
  // Cross-Origin-Opener-Policy joined X-Content-Type-Options/
  // Referrer-Policy/X-Frame-Options. See applySecurityHeaders' own doc
  // comment in main.ts for the full COOP/COEP evaluation this test's
  // fixed set reflects.
  it("registers Express middleware that sets exactly the six security headers, then calls next()", () => {
    const { app, use } = fakeApp();
    applySecurityHeaders(app);

    expect(use).toHaveBeenCalledTimes(1);
    const middleware = use.mock.calls[0]![0] as (req: unknown, res: { setHeader: ReturnType<typeof vi.fn> }, next: () => void) => void;

    const res = { setHeader: vi.fn() };
    const next = vi.fn();
    middleware({}, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(res.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
    expect(res.setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(res.setHeader).toHaveBeenCalledWith("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
    expect(res.setHeader).toHaveBeenCalledWith("Cross-Origin-Resource-Policy", "cross-origin");
    expect(res.setHeader).toHaveBeenCalledWith("Cross-Origin-Opener-Policy", "same-origin");
    expect(res.setHeader).toHaveBeenCalledTimes(6);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("disableXPoweredBy", () => {
  it("disables Express's x-powered-by setting (F3)", () => {
    const { app, disable } = fakeApp();
    disableXPoweredBy(app);
    expect(disable).toHaveBeenCalledWith("x-powered-by");
  });
});
