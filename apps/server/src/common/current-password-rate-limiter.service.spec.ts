// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/current-password-rate-limiter.service.spec.ts
//
// G4 (STATE.md "Current-password re-auth on self-changes"): settings-driven
// default/override/hot-reload coverage for the currentPassword re-auth
// limiter — same shape as session/auth-rate-limiter.service.spec.ts's own
// suite for its login/refresh/unlock trio, just for this one policy.
// Constructed directly (`new CurrentPasswordRateLimiterService(fake)`), not
// through Nest's DI container — same pattern as hash.service.spec.ts.

import { describe, expect, it } from "vitest";
import { CurrentPasswordRateLimiterService } from "./current-password-rate-limiter.service.js";
import { createFakeSettingsService } from "./test-support/fake-settings-service.js";

function attemptsUntilBlocked(limiter: { attempt(key: string): { allowed: boolean } }, key: string): number {
  let count = 0;
  for (let i = 0; i < 1000; i++) {
    if (!limiter.attempt(key).allowed) return count;
    count++;
  }
  throw new Error("never blocked within 1000 attempts");
}

describe("CurrentPasswordRateLimiterService", () => {
  it("defaults to 10/min", () => {
    const service = new CurrentPasswordRateLimiterService(createFakeSettingsService({ env: {} }).service);
    expect(attemptsUntilBlocked(service.currentPassword, "user-a")).toBe(10);
  });

  it("LOOMBRE_RATE_CURRENT_PASSWORD overrides the capacity", () => {
    const service = new CurrentPasswordRateLimiterService(
      createFakeSettingsService({ env: { LOOMBRE_RATE_CURRENT_PASSWORD: "3" } }).service,
    );
    expect(attemptsUntilBlocked(service.currentPassword, "user-b")).toBe(3);
  });

  it("buckets independently per user key", () => {
    const service = new CurrentPasswordRateLimiterService(
      createFakeSettingsService({ env: { LOOMBRE_RATE_CURRENT_PASSWORD: "1" } }).service,
    );
    expect(service.currentPassword.attempt("user-c").allowed).toBe(true);
    expect(service.currentPassword.attempt("user-d").allowed).toBe(true);
    expect(service.currentPassword.attempt("user-c").allowed).toBe(false);
  });

  it("a hot settings change (onChange, no restart) applies to the NEXT bucket check for a fresh key, and an in-flight bucket is not retroactively broken", () => {
    const fake = createFakeSettingsService({ env: {} });
    const service = new CurrentPasswordRateLimiterService(fake.service);

    expect(attemptsUntilBlocked(service.currentPassword, "hot-reload-key-a")).toBe(10); // default capacity

    fake.setDbValue("rateLimit.currentPassword", 2);
    expect(attemptsUntilBlocked(service.currentPassword, "hot-reload-key-b")).toBe(2); // NEW key sees the new policy immediately
  });

  it("onApplicationBootstrap re-applies the real effective policy (lifecycle hazard fix, same as AuthRateLimiterService)", () => {
    const fake = createFakeSettingsService({ env: { LOOMBRE_RATE_CURRENT_PASSWORD: "4" } });
    const service = new CurrentPasswordRateLimiterService(fake.service);
    service.onApplicationBootstrap();
    expect(attemptsUntilBlocked(service.currentPassword, "user-e")).toBe(4);
  });
});
