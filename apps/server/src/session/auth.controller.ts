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

import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import {
  createDevice,
  getDeviceForUser,
  getUserByEmail,
  getUserById,
  getUserByUsername,
  getUserSettings,
  invalidateUnusedPasswordResetTokens,
  issuePasswordResetToken,
  resetPasswordViaTokenAndEmit,
  revokeRefreshTokensForDevice,
  setRestrictedUnlockUntil,
  updateDeviceForLogin,
  type UserRow,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { unauthorized, unprocessableEntity } from "../gateway/problem.exception.js";
import { sanitizeInstancePath } from "../gateway/sanitize-instance.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { HashService } from "../common/hash.service.js";
import { DeviceProfileValidatorService } from "../common/device-profile-validator.js";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { TokenService } from "./token.service.js";
import { RefreshTokenService } from "./refresh-token.service.js";
import { AuthRateLimiterService } from "./auth-rate-limiter.service.js";
import { AnomalyLogService } from "../common/anomaly-log.service.js";
import { generatePasswordResetToken, hashPasswordResetToken, PASSWORD_RESET_TOKEN_TTL_MS } from "./reset-token.js";
import { tooManyRequests } from "../common/rate-limit.exception.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { MailDispatchService } from "../mail/mail-dispatch.service.js";
import { MailConfigService } from "../mail/mail-config.service.js";

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

interface ForgotPasswordRequestBody {
  identifier?: unknown;
}

interface ResetPasswordRequestBody {
  token?: unknown;
  password?: unknown;
}

// F6 (fix wave): ForgotPasswordRequest/ResetPasswordRequest both declare
// additionalProperties:false in openapi.yaml — allowlists mirror each
// schema's declared `properties` exactly (house precedent: apps/server/
// src/catalog/users.controller.ts's SETTINGS_BODY_KEYS).
const FORGOT_PASSWORD_BODY_KEYS = new Set(["identifier"]);
const RESET_PASSWORD_BODY_KEYS = new Set(["token", "password"]);

// F8 (fix wave): aligns reset-password's minimum with POST
// /setup/first-admin's own minLength:8 (a deliberate tightening —
// reset-password used to accept a 1-char password); createUser/PATCH
// /users/me are OUT of scope.
const RESET_PASSWORD_MIN_LENGTH = 8;

interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAtMs: number;
  deviceId: string;
  /** E3a/M14 — additive; always sent (never omitted, even when false). */
  mustChangePassword: boolean;
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

/** F2 (fix wave): forgotPassword()'s fixed wall-clock response-time floor
 *  — see that method's doc comment for the full three-part rationale.
 *  200ms comfortably exceeds the real branch's natural cost (two small
 *  writes + a crypto mint, single-digit milliseconds locally) without
 *  being large enough to feel like a stall to a genuine caller. */
const FORGOT_PASSWORD_MIN_MS = 200;

/** Sleeps until at least FORGOT_PASSWORD_MIN_MS has elapsed since
 *  `startedAtMs` (an explicit clock read at forgotPassword()'s entry) —
 *  a no-op if the handler already took longer than the floor. */
async function waitOutForgotPasswordFloor(startedAtMs: number): Promise<void> {
  const remainingMs = FORGOT_PASSWORD_MIN_MS - (clockNowMs() - startedAtMs);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
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
    private readonly mailDispatchService: MailDispatchService,
    private readonly mailConfigService: MailConfigService,
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

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAtMs: expiresAtMs,
      deviceId: device.id,
      mustChangePassword: user.must_change_password,
    };
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
      mustChangePassword: user.must_change_password,
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

  /**
   * POST /auth/forgot-password (E3b, PUBLIC, M12 quartet). ALWAYS the
   * identical 202 + identical (empty) body, regardless of whether
   * `identifier` resolves to a real account, whether that account has an
   * email on file, or whether mail is configured at all (E3b/E8 —
   * anti-enumeration).
   *
   * F2 (opus adversarial review, fix wave): the original three-class
   * timing split — a live single-request classifier proved ~100% accurate
   * across (a) unknown identifier, (b) real account/no email, (c) real
   * account/email — is closed by THREE independent changes, each load-
   * bearing on its own:
   *   1. No more `getUserByUsername(...) ?? getUserByEmail(...)`
   *      short-circuit — BOTH lookups always run (Promise.all), so a
   *      username hit costs the same as a miss-then-email-hit or a
   *      miss-then-miss.
   *   2. Mail UNCONFIGURED skips the real/dummy split entirely — no
   *      lookups, no token, ever. This branch's cost depends ONLY on
   *      server config (identical for every caller by construction, since
   *      MailConfigService.isConfigured() is a synchronous in-memory
   *      check — no I/O, no per-identifier work), so it cannot itself be
   *      a timing class. As a side effect this also closes F10's
   *      "tokens minted nobody could ever use" waste.
   *   3. The WHOLE handler is floored to a fixed wall-clock budget
   *      (FORGOT_PASSWORD_MIN_MS below) measured from an explicit clock
   *      read at entry — whichever branch above ran, the response never
   *      leaves before the floor, so residual jitter between branches
   *      (a real INSERT vs. a discarded crypto mint vs. no work at all)
   *      is absorbed rather than merely narrowed. This is DB-shape parity
   *      PLUS a hard ceiling, not either alone — mirrors login()'s
   *      DUMMY_PASSWORD_HASH discipline above in spirit (do equivalent
   *      work down every branch) while adding the floor DUMMY_PASSWORD_HASH
   *      doesn't need (argon2id's own cost already dominates login's
   *      timing budget; forgot-password's cheap crypto mint does not).
   */
  @Post("forgot-password")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("passwordReset", "ip")
  async forgotPassword(
    @Body() rawBody: ForgotPasswordRequestBody | undefined,
    @Req() req: Request,
  ): Promise<Record<string, never>> {
    const startedAtMs = clockNowMs();
    // F9: defensive — this route's own path never carries the reset
    // token (identifier is a JSON body field, not a path/query value),
    // but every public throw site in this controller goes through the
    // same helper on principle, so a future ?token= caller mistake can
    // never surface one in a 422/429 body here either.
    const instance = sanitizeInstancePath(req);
    const body = rawBody ?? {};
    // F6: ForgotPasswordRequest declares additionalProperties:false.
    for (const key of Object.keys(body)) {
      if (!FORGOT_PASSWORD_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    if (!isNonEmptyString(body.identifier)) {
      throw unprocessableEntity("identifier is required.", instance);
    }

    const db = this.dbProvider.db;
    const nowMs = clockNowMs();

    if (this.mailConfigService.isConfigured()) {
      // F2(1): always both lookups, never a short-circuit.
      const [byUsername, byEmail] = await Promise.all([
        getUserByUsername(db, body.identifier),
        getUserByEmail(db, body.identifier),
      ]);
      const user = byUsername ?? byEmail;

      if (user && user.email) {
        const plaintext = generatePasswordResetToken();
        await issuePasswordResetToken(db, {
          userId: user.id,
          tokenHash: hashPasswordResetToken(plaintext),
          createdAtMs: nowMs,
          expiresAtMs: nowMs + PASSWORD_RESET_TOKEN_TTL_MS,
        });

        // Param names are Lane C's template contract (apps/worker/src/mail/
        // templates/types.ts): `actionUrl` is the full publicUrl-derived
        // reset link (E7 — never Host-header-derived), `displayName` greets.
        const publicUrl = this.mailConfigService.publicUrl() ?? "";
        await this.mailDispatchService.trySend({
          templateId: "password-reset",
          to: user.email,
          params: {
            actionUrl: `${publicUrl}/reset/${plaintext}`,
            displayName: user.display_name ?? user.username,
          },
        });
      } else {
        // Unknown identifier, OR a real account with no email on file —
        // see this method's doc comment for the anti-timing rationale.
        // Neither sub-case is distinguishable from the other, or from the
        // real branch above, by the caller.
        hashPasswordResetToken(generatePasswordResetToken());
        await invalidateUnusedPasswordResetTokens(db, randomUUID(), nowMs);
      }
    }
    // F2(2): mail unconfigured -> no lookups, no token, no mail, for
    // every identifier alike — intentionally falls straight through to
    // the floor below.

    await waitOutForgotPasswordFloor(startedAtMs);

    return {};
  }

  /**
   * POST /auth/reset-password (E3b, PUBLIC, M12 quartet). Atomic consume +
   * password set + refresh-token revocation + must_change_password clear +
   * event emission, all one transaction
   * (@loombre/db's resetPasswordViaTokenAndEmit). An invalid, expired, or
   * already-used token — indistinguishable from one another — produces a
   * BARE `NotFoundException()`, byte-identical to POST /setup/first-admin's
   * own inert 404 (F11: NOT an unknown route's 404 — an unknown route is
   * unauthenticated-401'd by AuthGuard first; setup's post-configuration
   * 404 is the true, verified twin, since both are public routes AuthGuard
   * never touches — see setup.controller.ts's header): no `detail`/
   * `instance`, so `{"type":"about:blank","title":"Not
   * Found","status":404}` every time.
   */
  @Post("reset-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("passwordReset", "ip")
  async resetPassword(
    @Body() rawBody: ResetPasswordRequestBody | undefined,
    @Req() req: Request,
  ): Promise<void> {
    // F9: defensive, same rationale as forgotPassword() above — this
    // route's own token travels in the JSON body, never the path/query,
    // but every public throw site here uses the same helper on principle.
    const instance = sanitizeInstancePath(req);
    const body = rawBody ?? {};
    // F6: ResetPasswordRequest declares additionalProperties:false.
    for (const key of Object.keys(body)) {
      if (!RESET_PASSWORD_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    if (!isNonEmptyString(body.token) || !isNonEmptyString(body.password)) {
      throw unprocessableEntity("token and password are required.", instance);
    }
    // F8: see RESET_PASSWORD_MIN_LENGTH's own comment.
    if (body.password.length < RESET_PASSWORD_MIN_LENGTH) {
      throw unprocessableEntity(`password must be at least ${RESET_PASSWORD_MIN_LENGTH} characters.`, instance);
    }

    const passwordHash = await this.hashService.hash(body.password);
    const result = await resetPasswordViaTokenAndEmit(this.dbProvider.db, {
      tokenHash: hashPasswordResetToken(body.token),
      passwordHash,
      nowMs: clockNowMs(),
    });

    if (!result.ok) {
      throw new NotFoundException();
    }
  }
}
