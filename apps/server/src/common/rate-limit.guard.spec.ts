// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/rate-limit.guard.spec.ts
//
// Exercises the REAL @nestjs/core Reflector against REAL @RateLimit()-
// decorated methods (not a mocked reflector) — the only fake pieces are
// the minimal ExecutionContext shape (Nest's own testing docs recommend
// exactly this for guard unit tests) and the request object.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { RateLimit, SurfaceRateLimitGuard } from "./rate-limit.guard.js";
import { SurfaceRateLimiterService } from "./surface-rate-limiter.service.js";
import { RateLimitException } from "./rate-limit.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { createFakeSettingsService } from "./test-support/fake-settings-service.js";

class FakeController {
  @RateLimit("capabilities", "ip")
  byIp(): void {}

  @RateLimit("mediaToken", "identity")
  byIdentity(): void {}

  @RateLimit("export", "user")
  byUser(): void {}

  noDecorator(): void {}
}

function makeContext(handler: () => void, req: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const ENV_KEYS = ["LOOMBRE_RATE_CAPABILITIES", "LOOMBRE_RATE_MEDIA_TOKEN", "LOOMBRE_RATE_EXPORT"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("SurfaceRateLimitGuard", () => {
  const controllerInstance = new FakeController();
  const reflector = new Reflector();

  it("allows a route with no @RateLimit() decorator (no-op)", () => {
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: process.env }).service);
    const guard = new SurfaceRateLimitGuard(service, reflector);
    const context = makeContext(controllerInstance.noDecorator, { ip: "1.2.3.4", originalUrl: "/x" } as unknown as AuthenticatedRequest);
    expect(guard.canActivate(context)).toBe(true);
  });

  it("'ip' strategy keys by req.ip and trips after the configured capacity", () => {
    process.env["LOOMBRE_RATE_CAPABILITIES"] = "2";
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: process.env }).service);
    const guard = new SurfaceRateLimitGuard(service, reflector);
    const req = { ip: "1.2.3.4", originalUrl: "/system/capabilities" } as unknown as AuthenticatedRequest;
    const context = makeContext(controllerInstance.byIp, req);

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(RateLimitException);
  });

  it("a different IP gets its own independent bucket", () => {
    process.env["LOOMBRE_RATE_CAPABILITIES"] = "1";
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: process.env }).service);
    const guard = new SurfaceRateLimitGuard(service, reflector);
    const contextA = makeContext(controllerInstance.byIp, { ip: "1.1.1.1", originalUrl: "/x" } as unknown as AuthenticatedRequest);
    const contextB = makeContext(controllerInstance.byIp, { ip: "2.2.2.2", originalUrl: "/x" } as unknown as AuthenticatedRequest);

    expect(guard.canActivate(contextA)).toBe(true);
    expect(() => guard.canActivate(contextA)).toThrow(RateLimitException);
    expect(guard.canActivate(contextB)).toBe(true); // untouched by A's trip
  });

  it("'identity' strategy keys by userId:deviceId — the SAME limit whether auth arrived via header or ?token=", () => {
    process.env["LOOMBRE_RATE_MEDIA_TOKEN"] = "1";
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: process.env }).service);
    const guard = new SurfaceRateLimitGuard(service, reflector);
    const req = { user: { userId: "u1", isAdmin: false, deviceId: "d1" }, originalUrl: "/images/x" } as unknown as AuthenticatedRequest;
    const context = makeContext(controllerInstance.byIdentity, req);

    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(RateLimitException);
  });

  it("'identity' strategy: two devices of the SAME user get independent buckets", () => {
    process.env["LOOMBRE_RATE_MEDIA_TOKEN"] = "1";
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: process.env }).service);
    const guard = new SurfaceRateLimitGuard(service, reflector);
    const reqDeviceA = { user: { userId: "u1", isAdmin: false, deviceId: "deviceA" }, originalUrl: "/x" } as unknown as AuthenticatedRequest;
    const reqDeviceB = { user: { userId: "u1", isAdmin: false, deviceId: "deviceB" }, originalUrl: "/x" } as unknown as AuthenticatedRequest;

    expect(guard.canActivate(makeContext(controllerInstance.byIdentity, reqDeviceA))).toBe(true);
    expect(guard.canActivate(makeContext(controllerInstance.byIdentity, reqDeviceB))).toBe(true);
  });

  it("'user' strategy keys by userId alone — two devices of the same user SHARE a bucket", () => {
    process.env["LOOMBRE_RATE_EXPORT"] = "1";
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: process.env }).service);
    const guard = new SurfaceRateLimitGuard(service, reflector);
    const reqDeviceA = { user: { userId: "u1", isAdmin: false, deviceId: "deviceA" }, originalUrl: "/export" } as unknown as AuthenticatedRequest;
    const reqDeviceB = { user: { userId: "u1", isAdmin: false, deviceId: "deviceB" }, originalUrl: "/export" } as unknown as AuthenticatedRequest;

    expect(guard.canActivate(makeContext(controllerInstance.byUser, reqDeviceA))).toBe(true);
    expect(() => guard.canActivate(makeContext(controllerInstance.byUser, reqDeviceB))).toThrow(RateLimitException);
  });

  it("the thrown exception carries a positive retryAfterMs for the filter to translate into a Retry-After header", () => {
    process.env["LOOMBRE_RATE_CAPABILITIES"] = "1";
    const service = new SurfaceRateLimiterService(createFakeSettingsService({ env: process.env }).service);
    const guard = new SurfaceRateLimitGuard(service, reflector);
    const req = { ip: "9.9.9.9", originalUrl: "/system/capabilities" } as unknown as AuthenticatedRequest;
    const context = makeContext(controllerInstance.byIp, req);

    guard.canActivate(context);
    try {
      guard.canActivate(context);
      expect.unreachable("expected RateLimitException");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitException);
      expect((err as RateLimitException).retryAfterMs).toBeGreaterThan(0);
    }
  });
});
