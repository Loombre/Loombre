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
// byte-identical body `{"type":"urn:loombre:problem:not-found","title":"Not
// Found","status":404,"detail":"Not found.","instance":"/setup/first-admin"}`
// — one shared not-found problem whose only per-request member is
// `instance`, the caller's own path, identical for both since both are the
// same request path (adi-F3, owner ruling 2026-08-24; the filter's own
// header explains why enriching both sides preserves the posture). This is
// the P1 restricted-content-style "invisible is
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
//
// d3-b4 (QA 2026-08-21 follow-up backlog, P3): createFirstAdmin's `email`
// was the fourth and last user-email write path in this server still
// storing the caller's string with no FORMAT check — see its inline note.
// The 404-before-validation ordering above is UNCHANGED by that fix: the
// emptiness check still wins over every body check, so a probe against a
// configured instance still learns nothing from a malformed body.
//
// d4-b3 (QA 2026-08-24 backlog #096, P3): createFirstAdmin was also the
// last body in this server running NO unknown-key allowlist, although
// FirstAdminRequest is `additionalProperties: false` — an unknown key, or
// a misspelled `displayName`, was dropped and the admin created anyway —
// and its `displayName` still ran the pre-F5-round-2 coercion that turned
// a wrong-typed value into a silent null. Both are closed inline below.
// The 404-before-validation ordering is unchanged by them too, and
// setup.e2e.spec.ts pins that directly: an unknown key on a CONFIGURED
// instance is still 404, never 422.

import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { countUsers, createDevice, createFirstAdminIfEmpty, type UserRow } from "@loombre/db";
import { isValidEmailFormat, nowMs as clockNowMs } from "@loombre/shared";
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
  email: string | null;
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
 *  specific. */
const SETUP_DEVICE_NAME = "First-boot setup";

/** d4-b3: FirstAdminRequest's own property set (packages/contract/openapi.
 *  yaml), which declares `additionalProperties: false`. Same allowlist
 *  mechanism api-validation-F5 put on every other body in this server —
 *  users.controller.ts's CREATE_USER_BODY_KEYS is the reference. */
const FIRST_ADMIN_BODY_KEYS = new Set(["username", "email", "password", "displayName"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function mapUser(row: UserRow): UserResponse {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
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

    // d4-b3 (QA 2026-08-24 backlog #096, P3): FirstAdminRequest declares
    // `additionalProperties: false` and this handler ran NO allowlist — the
    // one api-validation-F5 put on every other body in this server. An
    // unknown key, or a misspelled `displayName`, was silently dropped and
    // the admin was created ANYWAY: 201 with real tokens for a body the
    // server only partly understood, on the one call an instance can never
    // take back (the route goes permanently inert the moment it succeeds).
    // Runs FIRST among the body checks, as it does everywhere else — an
    // unknown key is a statement about the caller's body that does not
    // depend on which required field is also missing. It stays strictly
    // INSIDE the already-empty branch: the countUsers() 404 above still wins
    // over every one of these, so a probe against a configured instance
    // learns nothing from a malformed body (STATE.md P4.10 — the new checks
    // are pinned against that in setup.e2e.spec.ts).
    for (const key of Object.keys(body)) {
      if (!FIRST_ADMIN_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    if (!isNonEmptyString(body.username)) {
      throw unprocessableEntity("username is required.", instance);
    }
    if (!isNonEmptyString(body.email)) {
      throw unprocessableEntity("email is required.", instance);
    }
    // d3-b4 (QA 2026-08-21 follow-up backlog): isNonEmptyString was the
    // WHOLE check here, so `not-an-email` — or an address carrying a CRLF
    // header-injection payload — became the first admin's stored address
    // verbatim, against a member the contract declares `format: email`
    // (FirstAdminRequest, packages/contract/openapi.yaml) on an operation
    // that already declares 422. This is the LAST of the four user-email
    // write paths to catch up with R-F4: createUser and updateMe have
    // trimmed-then-validated since that fix wave, updateUser since
    // api-validation-F4, and this one — the mailbox every password-reset
    // on a fresh instance goes to — was the one still storing raw input.
    // Same block as those three (@loombre/shared's isValidEmailFormat,
    // z.email(), which has no character class admitting a control byte),
    // minus their null branch: email is REQUIRED here, not nullable. Trim
    // first for the same reason they do — a padded address normalizes into
    // the string the CITEXT unique index actually compares, rather than
    // being stored with its padding.
    const email = body.email.trim();
    if (!isValidEmailFormat(email)) {
      throw unprocessableEntity("email must be a valid email address.", instance);
    }
    // FirstAdminRequest.password: { minLength: 8 } (openapi.yaml) — a
    // stricter floor than createUserAdmin's other callers (admin-created
    // users only require length >= 1); this is the one account every
    // instance boots with, so the contract holds it to a real minimum.
    if (!isNonEmptyString(body.password) || body.password.length < 8) {
      throw unprocessableEntity("password must be at least 8 characters.", instance);
    }
    // d4-b3, second half: `displayName` still carried the pre-F5-round-2
    // `typeof === "string" ? … : null` coercion, so a wrong-typed value was
    // SILENTLY dropped — the admin was created with no display name and a
    // 201 that said nothing about it. FirstAdminRequest types it
    // `[string, 'null']`, so explicit null still means "none" and everything
    // else 422s, with createUser/updateUser/updateMe's exact wording (four
    // write paths for one member must not drift into four messages).
    if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== "string") {
      throw unprocessableEntity("displayName must be a string or null.", instance);
    }

    const passwordHash = await this.hashService.hash(body.password);
    const nowMs = clockNowMs();

    const created = await createFirstAdminIfEmpty(db, {
      username: body.username,
      email,
      passwordHash,
      // After the shape check above the only non-string values that reach
      // here are `undefined` and an explicit `null`, both meaning "none".
      // The `length > 0` clause therefore now decides ONE case, and is kept
      // deliberately: `""` is contract-valid but there is no PATCH on this
      // surface to correct it with, and an empty display_name would render
      // as a blank name everywhere `display_name ?? username` is the
      // fallback. Storing it as null is the honest reading of "no display
      // name given" for this one-shot bootstrap call.
      displayName: typeof body.displayName === "string" && body.displayName.length > 0 ? body.displayName : null,
      nowMs,
    });

    if (!created) {
      // STATE.md P4.10: permanently inert once ANY user exists. Bare
      // NotFoundException() — no message override, and adi-F3's conversion
      // in ProblemJsonExceptionFilter drops any message a future caller
      // might add, so the response body stays byte-identical to
      // NotFoundController's catch-all AT THIS SAME PATH (see this file's
      // header); apps/server/test/setup.e2e.spec.ts asserts that
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
