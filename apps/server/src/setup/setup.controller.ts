// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/setup/setup.controller.ts
//
// GET /setup/state, POST /setup/first-admin (STATE.md P4.6/P4.10 — lane C,
// Phase 4 Wave 2). Both are PUBLIC (openapi.yaml: `security: []`) by
// necessity — the wizard runs before any credentials exist — and BOTH are
// registered in apps/server/src/gateway/auth.guard.ts's PUBLIC_ROUTES
// (mirroring the existing mechanism, not a parallel one).
//
// getState is a cheap, honest boolean: needsSetup = countUsers() === 0. No
// version, no counts, no capability data leak to an unauthenticated caller
// (contract description's own constraint).
//
// createFirstAdmin succeeds IFF the users table is empty at the moment of
// its race-safe check-then-insert (packages/db/src/query/identity.ts's
// createFirstAdminIfEmpty — transaction-scoped pg_advisory_xact_lock, see
// that function's doc comment for the full race-safety argument and why a
// naive "SELECT count then INSERT" is NOT enough). Once any user exists,
// EVERY subsequent call throws a bare `NotFoundException()` — deliberately
// the exact same call NotFoundController's `*splat` catch-all makes (see
// that file), so ProblemJsonExceptionFilter serializes both to the
// byte-identical body `{"type":"about:blank","title":"Not
// Found","status":404}` (no `detail`/`instance` — this exception carries
// neither). This is the P1 restricted-content-style "invisible is
// indistinguishable from nonexistent" posture (docs/PLAN.md §6.4) applied
// to the setup surface itself: a probe against a configured instance learns
// nothing about whether first-boot setup ever happened.
//
// On success, the response mirrors POST /auth/login's shape as closely as
// FirstAdminRequest allows: the created admin user PLUS a real TokenPair
// (TokenService + RefreshTokenService, same services login uses) backed by
// a freshly created device row (identity.ts's createDevice, the same
// function login calls) so the wizard proceeds authenticated without a
// second login round-trip. FirstAdminRequest carries no deviceName/
// deviceProfile (the contract's setup surface doesn't ask for one — this is
// a one-time bootstrap action, not a general login) — the device row is
// named generically and gets an empty profile; the wizard's own later
// hardware-probe/capability steps don't depend on it (docs/PLAYBACK.md's
// DeviceProfile only matters for PLAYBACK planning, out of scope here).
//
// Rate limiting (STATE.md P4.15, closes security-review M1): both routes
// are UNAUTHENTICATED and first-admin runs argon2id before the emptiness
// check, so an un-throttled surface is a hashing-amplification / admin-race
// DoS on a fresh instance and countUsers() spam on a configured one. Both
// carry G1's SurfaceRateLimitGuard + @RateLimit("setup","ip") — per-IP
// (the only viable key with no identity), default 20/min (LOOMBRE_RATE_SETUP);
// openapi.yaml already documents 429/Retry-After on getSetupState.

import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { countUsers, createDevice, createFirstAdminIfEmpty, type UserRow } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { unprocessableEntity } from "../gateway/problem.exception.js";
import { DbProvider } from "../common/db.provider.js";
import { HashService } from "../common/hash.service.js";
import { TokenService } from "../session/token.service.js";
import { RefreshTokenService } from "../session/refresh-token.service.js";

interface FirstAdminRequestBody {
  username?: unknown;
  email?: unknown;
  password?: unknown;
  displayName?: unknown;
}

interface SetupStateResponse {
  needsSetup: boolean;
}

interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAtMs: number;
  deviceId: string;
}

interface UserResponse {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  birthDate: string | null;
  maxContentRating: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

interface FirstAdminResponse {
  user: UserResponse;
  tokens: TokenPairResponse;
}

/** Generic device identity for the token pair this endpoint mints — there
 *  is no deviceName/deviceProfile in FirstAdminRequest (contract-frozen;
 *  see file header), so unlike POST /auth/login this is not device-
 *  specific. Mirrors createUserAdmin's `displayName` situation: the
 *  contract accepts a field this wave has nowhere to persist, so it is
 *  read (to keep the request shape self-documenting) and intentionally
 *  ignored — same as apps/server/src/catalog/users.controller.ts's
 *  createUser, which has the identical gap (see that file's mapUser
 *  header comment: the `users` table has no displayName column). */
const SETUP_DEVICE_NAME = "First-boot setup";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function mapUser(row: UserRow): UserResponse {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: null,
    isAdmin: row.is_admin,
    birthDate: row.birth_date,
    maxContentRating: row.max_content_rating,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

@Controller("setup")
@UseFilters(RateLimitExceptionFilter)
export class SetupController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly hashService: HashService,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  @Get("state")
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("setup", "ip")
  async getState(): Promise<SetupStateResponse> {
    const count = await countUsers(this.dbProvider.db);
    return { needsSetup: count === 0 };
  }

  @Post("first-admin")
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("setup", "ip")
  @HttpCode(HttpStatus.CREATED)
  async createFirstAdmin(
    @Body() rawBody: FirstAdminRequestBody | undefined,
    @Req() req: Request,
  ): Promise<FirstAdminResponse> {
    const db = this.dbProvider.db;

    // STATE.md P4.10: this existence check MUST win before any body
    // validation — a populated instance answers this route as if it
    // doesn't exist AT ALL, unconditionally, not merely on a well-formed
    // request (the identical "invisible == nonexistent" posture
    // docs/PLAN.md §6.4 uses for restricted content: an attacker sending a
    // deliberately malformed body must learn nothing different from one
    // sending a valid one). This is a plain, non-transactional read —
    // createFirstAdminIfEmpty below re-checks emptiness ATOMICALLY under
    // its own advisory lock, so a request that sneaks a first admin in
    // between this read and that transaction still cannot mint a second
    // one; it just also resolves to 404 below (the `if (!created)` branch),
    // never a 500 or a silent second admin.
    if ((await countUsers(db)) > 0) {
      throw new NotFoundException();
    }

    const body = rawBody ?? {};
    const instance = req.originalUrl;

    if (!isNonEmptyString(body.username)) {
      throw unprocessableEntity("username is required.", instance);
    }
    if (!isNonEmptyString(body.email)) {
      throw unprocessableEntity("email is required.", instance);
    }
    // FirstAdminRequest.password: { minLength: 8 } (openapi.yaml) — a
    // stricter floor than createUserAdmin's other callers (admin-created
    // users only require length >= 1); this is the one account every
    // instance boots with, so the contract holds it to a real minimum.
    if (!isNonEmptyString(body.password) || body.password.length < 8) {
      throw unprocessableEntity("password must be at least 8 characters.", instance);
    }

    const passwordHash = await this.hashService.hash(body.password);
    const nowMs = clockNowMs();

    const created = await createFirstAdminIfEmpty(db, {
      username: body.username,
      email: body.email,
      passwordHash,
      nowMs,
    });

    if (!created) {
      // STATE.md P4.10: permanently inert once ANY user exists. Bare
      // NotFoundException() — no message override — so the response body
      // is byte-identical to NotFoundController's catch-all (see this
      // file's header); apps/server/test/setup.e2e.spec.ts asserts the
      // byte-identity directly against a live catch-all response.
      throw new NotFoundException();
    }

    const device = await createDevice(db, {
      userId: created.id,
      name: SETUP_DEVICE_NAME,
      platform: null,
      profile: {},
      nowMs,
    });

    const { token: accessToken, expiresAtMs } = await this.tokenService.signAccessToken(
      { sub: created.id, isAdmin: true, deviceId: device.id, restrictedUnlocked: false },
      nowMs,
    );
    const { refreshToken } = await this.refreshTokenService.issue(db, created.id, device.id, nowMs);

    return {
      user: mapUser(created),
      tokens: { accessToken, refreshToken, accessTokenExpiresAtMs: expiresAtMs, deviceId: device.id },
    };
  }
}
