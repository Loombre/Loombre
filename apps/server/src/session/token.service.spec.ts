// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/token.service.spec.ts

import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { TokenService } from "./token.service.js";

const ORIGINAL_SECRET_ENV = process.env["LOOMBRE_JWT_SECRET"];

afterEach(() => {
  if (ORIGINAL_SECRET_ENV === undefined) {
    delete process.env["LOOMBRE_JWT_SECRET"];
  } else {
    process.env["LOOMBRE_JWT_SECRET"] = ORIGINAL_SECRET_ENV;
  }
});

describe("TokenService", () => {
  it("signs an access token and verifies it back to the same claims", async () => {
    process.env["LOOMBRE_JWT_SECRET"] = "test-secret-value-not-for-prod";
    const service = new TokenService();
    const nowMs = Date.now();

    const { token, expiresAtMs } = await service.signAccessToken(
      { sub: "user-1", isAdmin: true, deviceId: "device-1", restrictedUnlocked: true },
      nowMs,
    );

    expect(expiresAtMs).toBe(nowMs + 15 * 60 * 1000);

    const claims = await service.verifyAccessToken(token);
    expect(claims).toEqual({
      sub: "user-1",
      isAdmin: true,
      deviceId: "device-1",
      restrictedUnlocked: true,
      // R-F7: iat is jose's own NumericDate unit — whole seconds, not ms.
      iat: Math.floor(nowMs / 1000),
    });
  });

  it("R-F7: exposes iat (whole seconds since epoch, jose's NumericDate unit)", async () => {
    process.env["LOOMBRE_JWT_SECRET"] = "test-secret-value-not-for-prod";
    const service = new TokenService();
    const nowMs = 1_700_000_123_456;

    const { token } = await service.signAccessToken({ sub: "user-iat", isAdmin: false }, nowMs);
    const claims = await service.verifyAccessToken(token);

    expect(claims.iat).toBe(Math.floor(nowMs / 1000));
  });

  it("defaults isAdmin/restrictedUnlocked false and omits deviceId when absent", async () => {
    process.env["LOOMBRE_JWT_SECRET"] = "test-secret-value-not-for-prod";
    const service = new TokenService();
    const { token } = await service.signAccessToken({ sub: "user-2", isAdmin: false }, Date.now());

    const claims = await service.verifyAccessToken(token);
    expect(claims.sub).toBe("user-2");
    expect(claims.isAdmin).toBe(false);
    expect(claims.deviceId).toBeUndefined();
    expect(claims.restrictedUnlocked).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    process.env["LOOMBRE_JWT_SECRET"] = "secret-a";
    const serviceA = new TokenService();
    const { token } = await serviceA.signAccessToken({ sub: "user-3", isAdmin: false }, Date.now());

    process.env["LOOMBRE_JWT_SECRET"] = "secret-b";
    const serviceB = new TokenService();
    await expect(serviceB.verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    process.env["LOOMBRE_JWT_SECRET"] = "test-secret-value-not-for-prod";
    const service = new TokenService();
    const secret = new TextEncoder().encode("test-secret-value-not-for-prod");
    const expiredToken = await new SignJWT({ isAdmin: false })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-4")
      .setIssuedAt(0)
      .setExpirationTime(1) // 1 second past epoch — long expired
      .sign(secret);

    await expect(service.verifyAccessToken(expiredToken)).rejects.toThrow();
  });

  it("boots with an ephemeral secret and a warning when LOOMBRE_JWT_SECRET is unset (P1.9 zero-config boot)", async () => {
    delete process.env["LOOMBRE_JWT_SECRET"];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const service = new TokenService();
    const { token } = await service.signAccessToken({ sub: "user-5", isAdmin: false }, Date.now());
    const claims = await service.verifyAccessToken(token);

    expect(claims.sub).toBe("user-5");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
