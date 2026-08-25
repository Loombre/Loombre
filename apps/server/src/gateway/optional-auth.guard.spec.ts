// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/optional-auth.guard.spec.ts
//
// api-restricted-leak-F1 (owner ruling 2026-08-24). OptionalAuthGuard's
// whole contract in six cases: it identifies a valid session, it treats
// every failure mode as "anonymous", and it NEVER throws — a public route
// that acquired this guard must not start answering 401 to a client
// carrying a stale token. TokenService is the REAL implementation signing
// and verifying real JWTs (same posture as auth.guard.spec.ts); no DB
// mocks are needed because this guard, by design, does no DB reads.

import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { OptionalAuthGuard } from "./optional-auth.guard.js";
import type { AuthenticatedRequest } from "./auth.guard.js";
import { TokenService } from "../session/token.service.js";

const USER_ID = "0191c1c0-0000-7000-8000-00000000000a";
const DEVICE_ID = "0191c1c0-0000-7000-8000-00000000000b";

function fakeRequest(authorization?: string): AuthenticatedRequest {
  return {
    method: "GET",
    path: "/system/capabilities",
    originalUrl: "/system/capabilities",
    headers: authorization === undefined ? {} : { authorization },
    query: {},
  } as unknown as AuthenticatedRequest;
}

function makeContext(req: AuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

describe("OptionalAuthGuard", () => {
  process.env["LOOMBRE_JWT_SECRET"] = process.env["LOOMBRE_JWT_SECRET"] ?? "optional-auth-guard-spec-secret";
  const tokenService = new TokenService();
  let guard: OptionalAuthGuard;

  beforeEach(() => {
    guard = new OptionalAuthGuard(tokenService);
  });

  it("no Authorization header: allows through, leaves req.user unset", async () => {
    const req = fakeRequest();
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it("a valid Bearer token: allows through and attaches the claims", async () => {
    const { token } = await tokenService.signAccessToken(
      { sub: USER_ID, isAdmin: false, deviceId: DEVICE_ID },
      Date.now(),
    );
    const req = fakeRequest(`Bearer ${token}`);

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.user).toEqual({ userId: USER_ID, isAdmin: false, deviceId: DEVICE_ID });
  });

  it("a token with no deviceId claim omits the key entirely (exactOptionalPropertyTypes)", async () => {
    const { token } = await tokenService.signAccessToken({ sub: USER_ID, isAdmin: true }, Date.now());
    const req = fakeRequest(`Bearer ${token}`);

    await guard.canActivate(makeContext(req));
    expect(req.user).toEqual({ userId: USER_ID, isAdmin: true });
    expect(Object.prototype.hasOwnProperty.call(req.user, "deviceId")).toBe(false);
  });

  it("garbage after Bearer: anonymous, no throw", async () => {
    const req = fakeRequest("Bearer not-a-jwt");
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it("an EXPIRED token: anonymous, no throw", async () => {
    // ACCESS_TOKEN_TTL_MS is 15 minutes — sign one an hour in the past.
    const { token } = await tokenService.signAccessToken(
      { sub: USER_ID, isAdmin: false },
      Date.now() - 60 * 60 * 1000,
    );
    const req = fakeRequest(`Bearer ${token}`);

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it("a non-Bearer Authorization scheme: anonymous, no throw", async () => {
    const req = fakeRequest("Basic dXNlcjpwYXNz");
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it("never overwrites a req.user AuthGuard already attached (its checks are stronger)", async () => {
    const req = fakeRequest("Bearer not-a-jwt");
    req.user = { userId: USER_ID, isAdmin: true };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.user).toEqual({ userId: USER_ID, isAdmin: true });
  });
});
