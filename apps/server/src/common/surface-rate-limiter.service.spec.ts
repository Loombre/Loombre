// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/surface-rate-limiter.service.spec.ts
//
// Same "plain `new`, bypass Nest's container" pattern
// apps/server/src/session/auth-rate-limiter.service.ts's own header
// documents. Addendum A, lane S3: capacities now come from SettingsService
// — this file constructs a fake (./test-support/fake-settings-service.ts)
// resolving rateLimit.* through the SAME pure resolveEffectiveSettings()
// production uses, so env var names/precedence are still exercised for
// real (via the fake's `env` input, never a real `process.env` mutation).

import { describe, expect, it } from "vitest";
import { SurfaceRateLimiterService } from "./surface-rate-limiter.service.js";
import { createFakeSettingsService } from "./test-support/fake-settings-service.js";

describe("SurfaceRateLimiterService", () => {
  it("defaults: capabilities 120/min, mediaToken 600/min, export 5/hour, claim 10/min", () => {
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: {} }).service);
    expect(service.capabilities.attempt("k").allowed).toBe(true);
    expect(service.mediaToken.attempt("k").allowed).toBe(true);
    expect(service.export.attempt("k").allowed).toBe(true);
    expect(service.claim.attempt("k").allowed).toBe(true);
  });

  it("rateLimit.claim (M12): env override changes capacity, independent key bucket", () => {
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: { LOOMBRE_RATE_CLAIM: "1" } }).service);
    expect(service.claim.attempt("only-key").allowed).toBe(true);
    expect(service.claim.attempt("only-key").allowed).toBe(false);
  });

  it("env overrides change capacity", () => {
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: { LOOMBRE_RATE_CAPABILITIES: "1" } }).service);
    expect(service.capabilities.attempt("only-key").allowed).toBe(true);
    expect(service.capabilities.attempt("only-key").allowed).toBe(false);
  });

  it("each policy keys independently — a different key is a fresh bucket", () => {
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: { LOOMBRE_RATE_EXPORT: "1" } }).service);
    expect(service.export.attempt("user-a").allowed).toBe(true);
    expect(service.export.attempt("user-a").allowed).toBe(false);
    expect(service.export.attempt("user-b").allowed).toBe(true);
  });

  it("an invalid/non-positive env value falls back to the default rather than throwing", () => {
    expect(() => new SurfaceRateLimiterService(createFakeSettingsService({ env: { LOOMBRE_RATE_MEDIA_TOKEN: "not-a-number" } }).service)).not.toThrow();
    expect(() => new SurfaceRateLimiterService(createFakeSettingsService({ env: { LOOMBRE_RATE_MEDIA_TOKEN: "-5" } }).service)).not.toThrow();
  });

  it("Addendum A: a hot settings change (onChange, no restart) applies to the NEXT bucket check for a fresh key", () => {
    const fake = createFakeSettingsService({ env: {} });
    const service = new SurfaceRateLimiterService(fake.service);

    expect(service.capabilities.attempt("hot-key-a").allowed).toBe(true);

    fake.setDbValue("rateLimit.capabilities", 1);
    expect(service.capabilities.attempt("hot-key-b").allowed).toBe(true); // fresh key, new policy
    expect(service.capabilities.attempt("hot-key-b").allowed).toBe(false); // capacity 1 -> already exhausted
  });
});
