// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/auth.guard.spec.ts
//
// AUD-A7b (audit fafa47f, Fix Wave 3 opus review, lane R3-guard-roundtrips):
// verifyAndAttach used to run getUserById and getDeviceById ONE AFTER THE
// OTHER even though neither depends on the other's result — +0.2ms and one
// extra DB round trip on every device-bound request (invariant 9: request
// paths do no heavy/needless work). This file pins two things:
//
//   1. The two lookups now fire CONCURRENTLY (Promise.all), not serially.
//      "fires getUserById and getDeviceById CONCURRENTLY" below FAILS
//      against the pre-fix guard — there, getDeviceById is only invoked
//      after getUserById's own promise has resolved — and passes after.
//   2. Concurrent I/O must not reorder the DECISIONS: which check throws
//      first — and therefore which of UnauthenticatedException (401) /
//      MustChangePasswordException (403) a caller sees when BOTH the user
//      and the device are invalid — is byte-for-byte unchanged from the
//      serial version. The matrix below (valid/missing/revoked crossed
//      with valid/missing user, plus the two "which check wins" cases)
//      locks that in so the concurrency fix can't silently reorder them.
//
// getUserById/getDeviceById are mocked at the `@loombre/db` module boundary
// (no live Postgres needed here); TokenService is the REAL implementation
// signing/verifying real JWTs — same "test the real thing" posture as
// rate-limit.guard.spec.ts's real Reflector.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import type { UserRow, DeviceRow } from "@loombre/db";

const dbMocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getDeviceById: vi.fn(),
}));

vi.mock("@loombre/db", () => ({
  getUserById: dbMocks.getUserById,
  getDeviceById: dbMocks.getDeviceById,
}));

import { AuthGuard } from "./auth.guard.js";
import type { AuthenticatedRequest } from "./auth.guard.js";
import { UnauthenticatedException } from "./unauthenticated.exception.js";
import { MustChangePasswordException } from "./must-change-password.exception.js";
import { TokenService } from "../session/token.service.js";
import type { DbProvider } from "../common/db.provider.js";

const USER_ID = "0191c1c0-0000-7000-8000-000000000001";
const DEVICE_ID = "0191c1c0-0000-7000-8000-000000000002";
// TokenService.verifyAccessToken checks `exp` against the REAL system clock
// (jose's default, no injectable clock) — this must stay close to
// Date.now() at sign time or every token below would already be expired by
// the time canActivate verifies it, regardless of the epoch fixtures.
const NOW_MS = Date.now();

function userRow(
  over: Partial<{ must_change_password: boolean; password_changed_at_ms: number | null }> = {},
): UserRow {
  return {
    id: USER_ID,
    must_change_password: over.must_change_password ?? false,
    password_changed_at_ms: over.password_changed_at_ms ?? null,
  } as unknown as UserRow;
}

function deviceRow(over: Partial<{ user_id: string; access_revoked_at_ms: number | null }> = {}): DeviceRow {
  return {
    id: DEVICE_ID,
    user_id: over.user_id ?? USER_ID,
    access_revoked_at_ms: over.access_revoked_at_ms ?? null,
  } as unknown as DeviceRow;
}

function fakeRequest(token: string, over: { method?: string; path?: string } = {}): AuthenticatedRequest {
  const method = over.method ?? "GET";
  const path = over.path ?? "/catalog/movies";
  return {
    method,
    path,
    originalUrl: path,
    headers: { authorization: `Bearer ${token}` },
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

describe("AuthGuard — user/device round trips (concurrency + semantics)", () => {
  const tokenService = new TokenService();
  const dbProvider = { db: {} } as unknown as DbProvider;
  let guard: AuthGuard;

  beforeEach(() => {
    dbMocks.getUserById.mockReset();
    dbMocks.getDeviceById.mockReset();
    guard = new AuthGuard(tokenService, new Reflector(), dbProvider);
  });

  async function signToken(over: { deviceId?: string; isAdmin?: boolean; sub?: string } = {}): Promise<string> {
    // exactOptionalPropertyTypes forbids `deviceId: undefined` against
    // AccessTokenClaims's `deviceId?: string` — omit the key entirely when
    // no device is under test, same as the guard's own `user.deviceId =`
    // pattern above in auth.guard.ts.
    const claims = { sub: over.sub ?? USER_ID, isAdmin: over.isAdmin ?? false, ...(over.deviceId !== undefined && { deviceId: over.deviceId }) };
    const { token } = await tokenService.signAccessToken(claims, NOW_MS);
    return token;
  }

  it("fires getUserById and getDeviceById CONCURRENTLY, not serially", async () => {
    const token = await signToken({ deviceId: DEVICE_ID });

    let resolveUser!: (v: UserRow | undefined) => void;
    const userPromise = new Promise<UserRow | undefined>((res) => (resolveUser = res));
    dbMocks.getUserById.mockReturnValue(userPromise);

    let resolveDevice!: (v: DeviceRow | undefined) => void;
    const devicePromise = new Promise<DeviceRow | undefined>((res) => (resolveDevice = res));
    dbMocks.getDeviceById.mockReturnValue(devicePromise);

    const activation = guard.canActivate(makeContext(fakeRequest(token)));

    // Poll until the (real, async) JWT verify has resolved and the guard has
    // reached the DB layer — WITHOUT resolving either DB promise ourselves.
    await vi.waitFor(() => expect(dbMocks.getUserById).toHaveBeenCalledTimes(1));

    // The regression this test exists to catch: in the pre-fix serial guard,
    // getDeviceById is only invoked AFTER `await getUserById(...)` settles.
    // userPromise is still pending here, so if getDeviceById has ALREADY
    // been called by this point, the two round trips were issued
    // concurrently rather than one-after-the-other.
    expect(dbMocks.getDeviceById).toHaveBeenCalledTimes(1);

    resolveUser(userRow());
    resolveDevice(deviceRow());
    await expect(activation).resolves.toBe(true);
  });

  it("valid user + valid device -> authenticates", async () => {
    dbMocks.getUserById.mockResolvedValue(userRow());
    dbMocks.getDeviceById.mockResolvedValue(deviceRow());
    const token = await signToken({ deviceId: DEVICE_ID });

    await expect(guard.canActivate(makeContext(fakeRequest(token)))).resolves.toBe(true);
  });

  it("valid user + missing device -> UnauthenticatedException (401)", async () => {
    dbMocks.getUserById.mockResolvedValue(userRow());
    dbMocks.getDeviceById.mockResolvedValue(undefined);
    const token = await signToken({ deviceId: DEVICE_ID });

    await expect(guard.canActivate(makeContext(fakeRequest(token)))).rejects.toBeInstanceOf(
      UnauthenticatedException,
    );
  });

  it("valid user + revoked device (access_revoked_at_ms after token iat) -> UnauthenticatedException", async () => {
    dbMocks.getUserById.mockResolvedValue(userRow());
    dbMocks.getDeviceById.mockResolvedValue(deviceRow({ access_revoked_at_ms: NOW_MS + 60_000 }));
    const token = await signToken({ deviceId: DEVICE_ID });

    await expect(guard.canActivate(makeContext(fakeRequest(token)))).rejects.toBeInstanceOf(
      UnauthenticatedException,
    );
  });

  it("missing user + valid device -> STILL authenticates (pre-existing quirk, preserved byte-for-byte)", async () => {
    // dbUser is only ever consulted for the password-epoch and must-change-
    // password checks (both `dbUser &&` / `dbUser?.` guarded) — an absent
    // user row never throws on its own. This pins that the concurrency fix
    // does not change that quirk in either direction.
    dbMocks.getUserById.mockResolvedValue(undefined);
    dbMocks.getDeviceById.mockResolvedValue(deviceRow());
    const token = await signToken({ deviceId: DEVICE_ID });

    await expect(guard.canActivate(makeContext(fakeRequest(token)))).resolves.toBe(true);
  });

  it("missing user + missing device -> UnauthenticatedException", async () => {
    dbMocks.getUserById.mockResolvedValue(undefined);
    dbMocks.getDeviceById.mockResolvedValue(undefined);
    const token = await signToken({ deviceId: DEVICE_ID });

    await expect(guard.canActivate(makeContext(fakeRequest(token)))).rejects.toBeInstanceOf(
      UnauthenticatedException,
    );
  });

  it("stale user password epoch throws even when the (concurrently-fetched) device is ALSO invalid — same exception either way", async () => {
    // password_changed_at_ms strictly after the token's iat -> the epoch
    // check fires first in source order and must still win the race even
    // though getDeviceById (now issued concurrently) resolves to "missing"
    // too — both paths throw the identical UnauthenticatedException, so
    // there is no new distinguishing signal for a caller to observe.
    dbMocks.getUserById.mockResolvedValue(userRow({ password_changed_at_ms: NOW_MS + 60_000 }));
    dbMocks.getDeviceById.mockResolvedValue(undefined);
    const token = await signToken({ deviceId: DEVICE_ID });

    await expect(guard.canActivate(makeContext(fakeRequest(token)))).rejects.toBeInstanceOf(
      UnauthenticatedException,
    );
  });

  it("device check still fires BEFORE the must-change-password check: invalid device + must_change_password=true -> 401, not 403", async () => {
    dbMocks.getUserById.mockResolvedValue(userRow({ must_change_password: true }));
    dbMocks.getDeviceById.mockResolvedValue(undefined);
    const token = await signToken({ deviceId: DEVICE_ID });

    const result = guard.canActivate(makeContext(fakeRequest(token)));
    await expect(result).rejects.toBeInstanceOf(UnauthenticatedException);
    await expect(result).rejects.not.toBeInstanceOf(MustChangePasswordException);
  });

  it("valid user + valid device + must_change_password=true on a non-allow-listed route -> MustChangePasswordException (403)", async () => {
    dbMocks.getUserById.mockResolvedValue(userRow({ must_change_password: true }));
    dbMocks.getDeviceById.mockResolvedValue(deviceRow());
    const token = await signToken({ deviceId: DEVICE_ID });

    await expect(guard.canActivate(makeContext(fakeRequest(token)))).rejects.toBeInstanceOf(
      MustChangePasswordException,
    );
  });

  it("no deviceId claim (admin/CLI-issued token) -> getDeviceById is never called, device check skipped entirely", async () => {
    dbMocks.getUserById.mockResolvedValue(userRow());
    const token = await signToken({});

    await expect(guard.canActivate(makeContext(fakeRequest(token)))).resolves.toBe(true);
    expect(dbMocks.getDeviceById).not.toHaveBeenCalled();
  });
});
