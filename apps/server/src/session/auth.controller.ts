// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/auth.controller.ts
//
// POST /auth/login, /auth/refresh, /auth/logout (task spec). Login and
// refresh are public (AuthGuard's PUBLIC_ROUTES); logout requires a Bearer
// token like everything else.
//
// Phase 2 additions (STATE.md P2.1/P2.3/P2.12/P2.16):
//   - deviceProfile is now strictly Ajv-validated against the contract's
//     DeviceProfile schema (docs/PLAYBACK.md §2.2) instead of a loose
//     plain-object check — malformed profiles 422, never best-guessed.
//   - Per-IP token-bucket rate limits on login/refresh (429 + Retry-After,
//     via RateLimitExceptionFilter — see that file's header for why this
//     is a controller-scoped filter rather than a gateway/ edit).
//   - A fail2ban-compatible anomaly log line on every failed login and
//     every refresh-token reuse (theft) detection.
//   - Login device-row reuse: a caller-presented `deviceId` owned by the
//     authenticating user rotates that device's refresh chain and
//     refreshes its profile/last-seen instead of registering a new row;
//     an unknown or foreign deviceId falls back to Phase 1 behavior
//     (silent new-device creation — device existence is never leaked).

import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters } from "@nestjs/common";
import type { Request } from "express";
import {
  createDevice,
  getDeviceForUser,
  getUserByEmail,
  getUserById,
  getUserByUsername,
  getUserSettings,
  revokeRefreshTokensForDevice,
  setRestrictedUnlockUntil,
  updateDeviceForLogin,
  type UserRow,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { unauthorized, unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { HashService } from "../common/hash.service.js";
import { DeviceProfileValidatorService } from "../common/device-profile-validator.js";
import { TokenService } from "./token.service.js";
import { RefreshTokenService } from "./refresh-token.service.js";
import { AuthRateLimiterService } from "./auth-rate-limiter.service.js";
import { AnomalyLogService } from "./anomaly-log.service.js";
import { tooManyRequests } from "../common/rate-limit.exception.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";

interface LoginRequestBody {
  email?: unknown;
  username?: unknown;
  password?: unknown;
  deviceName?: unknown;
  deviceProfile?: unknown;
  deviceId?: unknown;
}

interface RefreshRequestBody {
  refreshToken?: unknown;
  deviceId?: unknown;
}

interface LogoutRequestBody {
  deviceId?: unknown;
}

interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAtMs: number;
  deviceId: string;
}

/** Every offline-generated seed hash starts this way (argon2id, m=19456,
 *  t=2, p=1) — used as a plausible-but-unrelated hash to verify against
 *  when the identifier doesn't resolve to a user, so an unknown-username
 *  login takes roughly the same code path (and wall-clock work) as a
 *  wrong-password one. Never a real credential (task spec: "same shape/
 *  timing whether user exists or not"). */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The resolved client address (main.ts's LOOMBRE_TRUST_PROXY wiring makes
 *  `req.ip` honor X-Forwarded-For only when explicitly enabled, P2.2) —
 *  falls back to a fixed key rather than `undefined` so a missing address
 *  still buckets deterministically instead of bypassing the limiter. */
function clientIp(req: Request): string {
  return req.ip && req.ip.length > 0 ? req.ip : "unknown";
}

@Controller("auth")
@UseFilters(RateLimitExceptionFilter)
export class AuthController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly hashService: HashService,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly deviceProfileValidator: DeviceProfileValidatorService,
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly anomalyLog: AnomalyLogService,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() rawBody: LoginRequestBody | undefined, @Req() req: Request): Promise<TokenPairResponse> {
    const ip = clientIp(req);
    const limit = this.rateLimiter.login.attempt(ip);
    if (!limit.allowed) {
      this.anomalyLog.log("RATE_LIMITED", { ip, op: "login" });
      throw tooManyRequests("Too many login attempts. Try again later.", req.originalUrl, limit.retryAfterMs);
    }

    const body = rawBody ?? {};
    if (!isNonEmptyString(body.password) || !isNonEmptyString(body.deviceName)) {
      throw unprocessableEntity("password, deviceName, and deviceProfile are required.", req.originalUrl);
    }
    const profileCheck = this.deviceProfileValidator.validate(body.deviceProfile);
    if (!profileCheck.valid) {
      throw unprocessableEntity(`deviceProfile is invalid: ${profileCheck.errors}`, req.originalUrl);
    }
    const deviceProfile = body.deviceProfile as Record<string, unknown>;

    const username = isNonEmptyString(body.username) ? body.username : undefined;
    const email = isNonEmptyString(body.email) ? body.email : undefined;
    if (!username && !email) {
      throw unprocessableEntity("Either username or email is required.", req.originalUrl);
    }

    const db = this.dbProvider.db;
    const user: UserRow | undefined = username
      ? await getUserByUsername(db, username)
      : await getUserByEmail(db, email!);

    const passwordOk = await this.hashService.verify(
      user?.password_hash ?? DUMMY_PASSWORD_HASH,
      body.password,
    );

    if (!user || !passwordOk) {
      const identifier = username ?? email;
      this.anomalyLog.log("FAILED_LOGIN", { ip, ...(identifier !== undefined ? { user: identifier } : {}) });
      throw unauthorized("Invalid credentials.", req.originalUrl);
    }

    const nowMs = clockNowMs();

    // P2.16: reuse the caller's own device row when a known deviceId is
    // presented; unknown/foreign ids fall back to Phase 1's silent
    // new-device creation (device existence must never be leaked).
    const presentedDeviceId = isNonEmptyString(body.deviceId) ? body.deviceId : undefined;
    const existingDevice = presentedDeviceId
      ? await getDeviceForUser(db, user.id, presentedDeviceId)
      : undefined;

    const device = existingDevice
      ? await (async () => {
          await revokeRefreshTokensForDevice(db, user.id, existingDevice.id, nowMs);
          return updateDeviceForLogin(db, existingDevice.id, { profile: deviceProfile, nowMs });
        })()
      : await createDevice(db, {
          userId: user.id,
          name: body.deviceName,
          platform: null,
          profile: deviceProfile,
          nowMs,
        });

    // "Unlock state never persists across logins" (openapi.yaml
    // /restricted/unlock description, docs/PLAN.md §6.4 gate 5) — every
    // fresh login starts locked, regardless of any unlock left live from a
    // previous session.
    await setRestrictedUnlockUntil(db, user.id, null, nowMs);

    const { token: accessToken, expiresAtMs } = await this.tokenService.signAccessToken(
      { sub: user.id, isAdmin: user.is_admin, deviceId: device.id, restrictedUnlocked: false },
      nowMs,
    );
    const { refreshToken } = await this.refreshTokenService.issue(db, user.id, device.id, nowMs);

    return { accessToken, refreshToken, accessTokenExpiresAtMs: expiresAtMs, deviceId: device.id };
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() rawBody: RefreshRequestBody | undefined, @Req() req: Request): Promise<TokenPairResponse> {
    const ip = clientIp(req);
    const limit = this.rateLimiter.refresh.attempt(ip);
    if (!limit.allowed) {
      this.anomalyLog.log("RATE_LIMITED", { ip, op: "refresh" });
      throw tooManyRequests("Too many refresh attempts. Try again later.", req.originalUrl, limit.retryAfterMs);
    }

    const body = rawBody ?? {};
    if (!isNonEmptyString(body.refreshToken) || !isNonEmptyString(body.deviceId)) {
      throw unauthorized("Malformed refresh request.", req.originalUrl);
    }

    const db = this.dbProvider.db;
    const nowMs = clockNowMs();
    const result = await this.refreshTokenService.rotate(db, body.refreshToken, nowMs);

    if (!result.ok) {
      if (result.reason === "reused") {
        this.anomalyLog.log("REFRESH_REUSE", { ip, device: body.deviceId });
      }
      throw unauthorized("Invalid, expired, or reused refresh token.", req.originalUrl);
    }
    if (result.deviceId !== null && result.deviceId !== body.deviceId) {
      // Presented deviceId doesn't match the token's own device — treat as
      // invalid rather than silently accepting a cross-device presentation
      // (decision beyond spec: RefreshRequest requires deviceId but the
      // contract doesn't say what to do on a mismatch).
      throw unauthorized("Invalid, expired, or reused refresh token.", req.originalUrl);
    }

    const user = await getUserById(db, result.userId);
    if (!user) {
      throw unauthorized("Invalid, expired, or reused refresh token.", req.originalUrl);
    }

    const settings = await getUserSettings(db, result.userId);
    const restrictedUnlocked =
      settings?.restricted_unlocked_until_ms != null && settings.restricted_unlocked_until_ms > nowMs;

    const { token: accessToken, expiresAtMs } = await this.tokenService.signAccessToken(
      {
        sub: user.id,
        isAdmin: user.is_admin,
        restrictedUnlocked,
        ...(result.deviceId !== null ? { deviceId: result.deviceId } : {}),
      },
      nowMs,
    );

    return {
      accessToken,
      refreshToken: result.issued.refreshToken,
      accessTokenExpiresAtMs: expiresAtMs,
      deviceId: result.deviceId ?? body.deviceId,
    };
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() rawBody: LogoutRequestBody | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    const body = rawBody ?? {};
    const deviceId = isNonEmptyString(body.deviceId) ? body.deviceId : req.user?.deviceId;
    if (!deviceId || !req.user) {
      // No device to revoke (e.g. a hand-crafted token with no deviceId
      // claim and no deviceId in the body) — logout stays idempotent-
      // successful rather than erroring; /auth/logout documents only
      // 401/default, no 422, for this operation.
      return;
    }
    await this.refreshTokenService.logout(this.dbProvider.db, req.user.userId, deviceId, clockNowMs());
  }
}
