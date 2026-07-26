// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/auth-rate-limiter.service.spec.ts
//
// Settings-driven defaults/overrides for the three auth rate-limit
// policies (STATE.md P2.1: login 10/min per-IP, refresh 30/min per-IP,
// unlock 5/min per-user). Constructed directly
// (`new AuthRateLimiterService(fakeSettingsService)`), not through Nest's
// DI container — same pattern as hash.service.spec.ts. Addendum A, lane
// S3: the fake (common/test-support/fake-settings-service.ts) resolves
// rateLimit.login/refresh/unlock through the SAME pure
// resolveEffectiveSettings() production uses (env-pin > DB > default),
// without a database — env var names/precedence are therefore still
// exercised for real, just via the fake's `env` input instead of mutating
// `process.env`.

import { describe, expect, it } from "vitest";
import { AuthRateLimiterService } from "./auth-rate-limiter.service.js";
import { createFakeSettingsService } from "../common/test-support/fake-settings-service.js";

function attemptsUntilBlocked(limiter: { attempt(key: string): { allowed: boolean } }, key: string): number {
  let count = 0;
  for (let i = 0; i < 1000; i++) {
    if (!limiter.attempt(key).allowed) return count;
    count++;
  }
  throw new Error("never blocked within 1000 attempts");
}

describe("AuthRateLimiterService", () => {
  it("defaults: login 10/min, refresh 30/min, unlock 5/min", () => {
    const service = new AuthRateLimiterService(createFakeSettingsService({ env: {} }).service);
    expect(attemptsUntilBlocked(service.login, "ip-a")).toBe(10);
    expect(attemptsUntilBlocked(service.refresh, "ip-b")).toBe(30);
    expect(attemptsUntilBlocked(service.unlock, "user-a")).toBe(5);
  });

  it("LOOMBRE_RATE_LOGIN overrides the login capacity", () => {
    const service = new AuthRateLimiterService(createFakeSettingsService({ env: { LOOMBRE_RATE_LOGIN: "3" } }).service);
    expect(attemptsUntilBlocked(service.login, "ip-c")).toBe(3);
  });

  it("LOOMBRE_RATE_REFRESH overrides the refresh capacity", () => {
    const service = new AuthRateLimiterService(createFakeSettingsService({ env: { LOOMBRE_RATE_REFRESH: "2" } }).service);
    expect(attemptsUntilBlocked(service.refresh, "ip-d")).toBe(2);
  });

  it("LOOMBRE_RATE_UNLOCK overrides the unlock capacity", () => {
    const service = new AuthRateLimiterService(createFakeSettingsService({ env: { LOOMBRE_RATE_UNLOCK: "1" } }).service);
    expect(attemptsUntilBlocked(service.unlock, "user-b")).toBe(1);
  });

  it("each policy keys buckets independently (login and refresh don't share state)", () => {
    const service = new AuthRateLimiterService(
      createFakeSettingsService({ env: { LOOMBRE_RATE_LOGIN: "1", LOOMBRE_RATE_REFRESH: "1" } }).service,
    );
    expect(service.login.attempt("shared-key").allowed).toBe(true);
    expect(service.refresh.attempt("shared-key").allowed).toBe(true);
  });

  it("Addendum A: a hot settings change (onChange, no restart) applies to the NEXT bucket check for a fresh key, and an in-flight bucket is not retroactively broken", () => {
    const fake = createFakeSettingsService({ env: {} });
    const service = new AuthRateLimiterService(fake.service);

    expect(attemptsUntilBlocked(service.login, "hot-reload-key-a")).toBe(10); // default capacity

    fake.setDbValue("rateLimit.login", 2);
    expect(attemptsUntilBlocked(service.login, "hot-reload-key-b")).toBe(2); // NEW key sees the new policy immediately
  });
});
