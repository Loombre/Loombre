// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/invites/invites.controller.ts
//
// E2 (invitations): POST/GET /invites, DELETE /invites/{id} (admin) plus
// the PUBLIC GET/POST /invites/claim/{token} pair (M12 quartet: contract
// `security: []` + auth.guard.ts PUBLIC_ROUTE_PATTERNS + conformance
// PUBLIC_OPERATION_IDS + dedicated public-op response assertions).
//
// F1 (opus adversarial review, fix wave): mounted at /invites/claim/{token},
// NOT bare /claim/{token} — that path belongs to the Next.js web PAGE
// (apps/web/src/app/claim/[token]), and docs/ops/remote-access/reverse-proxy.md routed
// /claim/* to this API, so the two collided and a real invite link opened
// JSON instead of the claim page. The human-facing invite link
// (composeClaimUrl below) is UNCHANGED — still `${publicUrl}/claim/${token}`,
// the web page's own route — only this JSON API's mounted path moved.
//
// Token handling (M3, "the refresh-token posture EXACTLY"): the raw invite
// token is generated + hashed via RefreshTokenService's OWN
// generateOpaqueToken()/hashToken() methods (256-bit randomBytes ->
// base64url; SHA-256 hex for storage) — reused directly rather than
// duplicated into a second service, since those two methods are already
// generic (nothing refresh-token-specific about their implementation).
// packages/db/src/query/invites.ts never sees a raw token, only its hash.
//
// Byte-identical 404 (M12): both claim routes throw a BARE
// `NotFoundException()` for invalid/expired/claimed/revoked tokens — the
// same call setup.controller.ts's createFirstAdmin makes once configured
// — so ProblemJsonExceptionFilter serializes all of them to the ONE
// shared not-found problem, `{"type":"urn:loombre:problem:not-found",
// "title":"Not Found","status":404,"detail":"Not found.","instance":
// "/invites/claim/{token}"}` (adi-F3, owner ruling 2026-08-24). Still
// indistinguishable from each other: the detail is fixed and `instance` is
// this route's TEMPLATE — sanitize-instance.ts collapses it before the body
// is built, so the submitted token never rides back and NOTHING in the body
// varies with what was probed. Also still indistinguishable from POST
// /setup/first-admin's own inert 404 in every member but `instance` (F11:
// NOT from an unknown route — an unknown route is unauthenticated-401'd by
// AuthGuard first; setup's post-configuration 404 is the true, verified
// twin, since both are public routes an AuthGuard never touches), and
// byte-identical to the catch-all's own 404 on this very path.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import {
  claimEmailCollisionNoticeWindow,
  claimInviteAndEmit,
  createDevice,
  createInviteAndEmit,
  deriveInviteStatus,
  getInviteByTokenHash,
  getLibraryByIdAdmin,
  isInviteClaimable,
  listInvitesAdmin,
  mapClaimState,
  releaseEmailCollisionNoticeWindow,
  revokeInviteAndEmit,
  type InviteAdminRow,
} from "@loombre/db";
import { isValidEmailFormat, nowMs as clockNowMs } from "@loombre/shared";
import { forbidden, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import { sanitizeInstancePath } from "../gateway/sanitize-instance.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { HashService } from "../common/hash.service.js";
import { DeviceProfileValidatorService } from "../common/device-profile-validator.js";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { TokenService } from "../session/token.service.js";
import { RefreshTokenService } from "../session/refresh-token.service.js";
import { MailDispatchService } from "../mail/mail-dispatch.service.js";
import { MailConfigService } from "../mail/mail-config.service.js";
import { parseLimitParam } from "../common/limit-param.js";

const EXPIRES_IN_MS_DEFAULT = 259_200_000; // 72h
const EXPIRES_IN_MS_MIN = 3_600_000; // 1h
const EXPIRES_IN_MS_MAX = 2_592_000_000; // 30d
const CLAIM_DEVICE_NAME_DEFAULT = "Invite claim";
const CLAIM_PASSWORD_MIN_LENGTH = 8;

// G8 (STATE.md "Current-password re-auth on self-changes"): claimInvite's
// own wall-clock floor — FORGOT_PASSWORD_MIN_MS precedent
// (auth.controller.ts). Unlike updateMe (floored only when the body
// carries an email member), claimInvite is floored UNCONDITIONALLY — this
// is the account-CREATION endpoint, and the collision-vs-clean timing
// distinction G8 exists to close applies to every claim alike (an email
// value is ALWAYS resolved here, whether submitted or defaulted from the
// invite's own preset).
const CLAIM_INVITE_MIN_MS = 200;

async function waitOutClaimInviteFloor(startedAtMs: number): Promise<void> {
  const remainingMs = CLAIM_INVITE_MIN_MS - (clockNowMs() - startedAtMs);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
}

// F6 (fix wave): CreateInviteRequest/ClaimInviteRequest both declare
// `additionalProperties: false` in openapi.yaml, but nothing enforced it —
// an unknown key was silently ignored rather than rejected. Allowlists
// mirror each schema's declared `properties` exactly (house precedent:
// apps/server/src/catalog/users.controller.ts's SETTINGS_BODY_KEYS).
const CREATE_INVITE_BODY_KEYS = new Set(["username", "displayName", "email", "expiresInMs", "libraryIds"]);
const CLAIM_INVITE_BODY_KEYS = new Set(["username", "password", "email", "displayName", "deviceName", "deviceProfile"]);

// F7 (fix wave): deliberately permissive shape check, not a deliverability
// test (the worker's real SMTP attempt is that test).
//
// R-F4 (opus adversarial review, fix wave): this used to be a locally
// hand-rolled regex duplicated in TWO files (here and admin-mail.
// controller.ts) — replaced by @loombre/shared's isValidEmailFormat
// (zod's z.email(), the same primitive settings-registry.ts already uses
// for mail.fromAddress), which additionally rejects embedded ASCII
// control characters a bare `[^\s@]` class does not (e.g. a NUL byte is
// not `\s`). Both createInvite and claimInvite below TRIM the submitted
// value before validating it, same reasoning as users.controller.ts's
// updateMe/createUser: a whitespace-padded copy of a real address must
// normalize into the identical string, not become a second, visually-
// distinct one.

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface CursorLimitQuery {
  cursor?: string;
  limit?: number;
}
function parseCursorLimitQuery(query: Record<string, unknown>): CursorLimitQuery {
  const result: CursorLimitQuery = {};
  if (typeof query["cursor"] === "string") result.cursor = query["cursor"];
  const limit = parseLimitParam(query["limit"]);
  if (limit !== undefined) result.limit = limit;
  return result;
}

/**
 * Human-readable expiry span for the invite email's `expiresLabel` template
 * param (Lane C's contract wants prose like "72 hours" / "3 days", not a
 * timestamp — the recipient's timezone is unknown).
 */
export function formatExpiresLabel(expiresInMs: number): string {
  const hours = Math.round(expiresInMs / 3_600_000);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * `${publicUrl}/claim/${token}` when publicUrl is set, else null (M9). A
 * pure function so the non-null composition shape is unit-testable without
 * ever needing MailConfigService's stub to return non-null for real (see
 * mail-config.service.ts's header) — invites.controller.spec.ts exercises
 * both branches directly.
 */
export function composeClaimUrl(publicUrl: string | null, token: string): string | null {
  if (publicUrl === null) return null;
  return `${publicUrl}/claim/${token}`;
}

function mapInvite(row: InviteAdminRow, nowMs: number) {
  return {
    id: row.id,
    createdByUserId: row.createdByUserId,
    createdAtMs: row.createdAtMs,
    expiresAtMs: row.expiresAtMs,
    usernamePreset: row.usernamePreset,
    displayNamePreset: row.displayNamePreset,
    email: row.email,
    libraryIds: row.libraryIds,
    status: deriveInviteStatus(row, nowMs),
    claimedByUserId: row.claimedUserId,
    claimedAtMs: row.claimedAtMs,
    revokedAtMs: row.revokedAtMs,
  };
}

async function requireAdmin(db: LoombreDb, req: AuthenticatedRequest): Promise<void> {
  if (!req.user?.isAdmin) {
    throw forbidden("Admin privileges are required for this operation.", req.originalUrl);
  }
  await requireLiveAdmin(db, req.user.userId, req.originalUrl);
}

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class InvitesController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly hashService: HashService,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly deviceProfileValidator: DeviceProfileValidatorService,
    private readonly mailDispatch: MailDispatchService,
    private readonly mailConfig: MailConfigService,
  ) {}

  // ==========================================================================
  // admin: create / list / revoke
  // ==========================================================================

  @Post("invites")
  @HttpCode(HttpStatus.CREATED)
  async createInvite(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    const body = rawBody ?? {};
    const instance = req.originalUrl;

    // F6: CreateInviteRequest declares additionalProperties:false.
    for (const key of Object.keys(body)) {
      if (!CREATE_INVITE_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    if (!Array.isArray(body["libraryIds"])) {
      throw unprocessableEntity("libraryIds is required and must be an array.", instance);
    }
    const libraryIds = body["libraryIds"] as unknown[];
    if (!libraryIds.every((id) => typeof id === "string")) {
      throw unprocessableEntity("libraryIds must be an array of strings.", instance);
    }
    const libraryIdList = libraryIds as string[];

    for (const libraryId of libraryIdList) {
      const library = await getLibraryByIdAdmin(db, libraryId);
      if (!library) {
        throw unprocessableEntity(`Unknown library id "${libraryId}".`, instance);
      }
      if (library.content_class === "restricted") {
        // M4 defense in depth: invites can never grant restricted-library
        // access — an intercepted invite link must not be able to mint
        // privilege beyond what the admin could hand to an anonymous link.
        throw unprocessableEntity(
          `Library "${libraryId}" is restricted-class; invites cannot grant restricted-library access.`,
          instance,
        );
      }
    }

    let expiresInMs = EXPIRES_IN_MS_DEFAULT;
    if (body["expiresInMs"] !== undefined) {
      if (
        typeof body["expiresInMs"] !== "number" ||
        !Number.isInteger(body["expiresInMs"]) ||
        body["expiresInMs"] < EXPIRES_IN_MS_MIN ||
        body["expiresInMs"] > EXPIRES_IN_MS_MAX
      ) {
        // R-F2/F4: Number.isInteger subsumes Number.isFinite (NaN/Infinity
        // are never integers) and additionally rejects a FRACTIONAL value
        // inside the 1h-30d bounds — e.g. 3_600_000.7 previously sailed
        // through this check and reached the BIGINT expires_at_ms column,
        // where Postgres raised "invalid input syntax for type bigint" as
        // an unhandled 500. The message already promised "integer"; now the
        // check does too.
        throw unprocessableEntity("expiresInMs must be an integer between 1h and 30d (ms).", instance);
      }
      expiresInMs = body["expiresInMs"];
    }

    const username = typeof body["username"] === "string" && body["username"].length > 0 ? body["username"] : null;
    const displayName =
      typeof body["displayName"] === "string" && body["displayName"].length > 0 ? body["displayName"] : null;
    const email = typeof body["email"] === "string" && body["email"].trim().length > 0 ? body["email"].trim() : null;
    // F7/R-F4: CreateInviteRequest.email declares format:email — this
    // preset feeds trySend's `to:` address directly (E6/E7), so a
    // malformed value must 422 here rather than surface as an opaque SMTP
    // failure later.
    if (email !== null && !isValidEmailFormat(email)) {
      throw unprocessableEntity("email must be a valid email address.", instance);
    }

    const nowMs = clockNowMs();
    const claimToken = this.refreshTokenService.generateOpaqueToken();
    const tokenHash = this.refreshTokenService.hashToken(claimToken);

    const invite = await createInviteAndEmit(db, {
      createdByUserId: req.user!.userId,
      tokenHash,
      usernamePreset: username,
      displayNamePreset: displayName,
      email,
      libraryIds: libraryIdList,
      expiresAtMs: nowMs + expiresInMs,
      nowMs,
    });

    const publicUrl = this.mailConfig.publicUrl();
    const claimUrl = composeClaimUrl(publicUrl, claimToken);

    // E6/M7: a dead/unconfigured mail system must never block invite
    // creation — trySend never throws and its result is not awaited-for-
    // correctness here beyond the call itself completing.
    if (email !== null && this.mailConfig.isConfigured()) {
      // Param names are Lane C's template contract (templates/types.ts):
      // `actionUrl` is the FULL claim link built from network.publicUrl
      // (E7 — never from a Host header), `displayName` greets, and
      // `expiresLabel` is human-readable prose, not a timestamp.
      await this.mailDispatch.trySend({
        templateId: "invite",
        to: email,
        params: {
          actionUrl: claimUrl ?? "",
          displayName: displayName ?? "",
          expiresLabel: formatExpiresLabel(expiresInMs),
        },
      });
    }

    return {
      invite: mapInvite(invite, nowMs),
      claimToken,
      claimUrl,
    };
  }

  @Get("invites")
  async listInvites(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    const { cursor, limit } = parseCursorLimitQuery(query);
    const page = await listInvitesAdmin(db, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const nowMs = clockNowMs();
    return { items: page.rows.map((row) => mapInvite(row, nowMs)), nextCursor: page.nextCursor };
  }

  @Delete("invites/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeInvite(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    const db = this.dbProvider.db;
    await requireAdmin(db, req);
    requireUuidParam(id, "Invite not found.", req.originalUrl);

    const won = await revokeInviteAndEmit(db, id, req.user!.userId, clockNowMs());
    if (!won) {
      throw notFound("Invite not found.", req.originalUrl);
    }
  }

  // ==========================================================================
  // public: claim
  // ==========================================================================

  // F1: mounted under /invites/claim/{token} — NOT bare /claim/{token},
  // which apps/web/src/app/claim/[token] owns as the human-facing PAGE
  // route (docs/ops/remote-access/reverse-proxy.md routed /claim/* to the API, so the
  // page and this JSON endpoint collided on the same path). The invite
  // link itself (composeClaimUrl below) is unaffected — it still points
  // at the web page, `${publicUrl}/claim/${token}`.
  @Get("invites/claim/:token")
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("claim", "ip")
  async getClaimState(@Param("token") token: string) {
    const db = this.dbProvider.db;
    const tokenHash = this.refreshTokenService.hashToken(token);
    const invite = await getInviteByTokenHash(db, tokenHash);
    const nowMs = clockNowMs();

    if (
      !invite ||
      !isInviteClaimable(
        { claimedAtMs: invite.claimed_at_ms, revokedAtMs: invite.revoked_at_ms, expiresAtMs: invite.expires_at_ms },
        nowMs,
      )
    ) {
      // Byte-identical to POST /setup/first-admin's inert 404 — see this file's header (F11).
      throw new NotFoundException();
    }

    return mapClaimState(invite);
  }

  @Post("invites/claim/:token")
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("claim", "ip")
  @HttpCode(HttpStatus.CREATED)
  async claimInvite(
    @Param("token") token: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: Request,
  ) {
    const startedAtMs = clockNowMs();
    const db = this.dbProvider.db;
    const tokenHash = this.refreshTokenService.hashToken(token);
    const nowMs = clockNowMs();
    // F9: a static, tokenless route template — req.originalUrl carries the
    // raw invite token as a PATH SEGMENT (not a query param), which
    // sanitizeInstancePath's own ?token= stripping alone would never
    // catch; see that file's header for the extension that closes this.
    const instance = sanitizeInstancePath(req);

    // Existence + liveness check FIRST (same ordering setup.controller.ts's
    // createFirstAdmin uses): a malformed/expired/claimed/revoked token
    // must 404 unconditionally, before any body validation runs — an
    // attacker sending a well-formed body must learn nothing different
    // from one sending garbage.
    const invite = await getInviteByTokenHash(db, tokenHash);
    if (
      !invite ||
      !isInviteClaimable(
        { claimedAtMs: invite.claimed_at_ms, revokedAtMs: invite.revoked_at_ms, expiresAtMs: invite.expires_at_ms },
        nowMs,
      )
    ) {
      throw new NotFoundException();
    }

    const body = rawBody ?? {};

    // F6: ClaimInviteRequest declares additionalProperties:false.
    for (const key of Object.keys(body)) {
      if (!CLAIM_INVITE_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    // M12: preset wins if both are present; required iff no preset.
    const usernamePreset = invite.username_preset;
    const submittedUsername = typeof body["username"] === "string" && body["username"].length > 0 ? body["username"] : null;
    const username = usernamePreset ?? submittedUsername;
    if (!username) {
      throw unprocessableEntity("username is required (this invite has no preset).", instance);
    }

    if (!isNonEmptyString(body["password"])) {
      throw unprocessableEntity("password is required.", instance);
    }
    // F8: aligns claim's minimum with POST /setup/first-admin's own
    // minLength:8 — a deliberate tightening (claim used to accept a
    // 1-char password); createUser/PATCH /users/me are OUT of scope.
    if (body["password"].length < CLAIM_PASSWORD_MIN_LENGTH) {
      throw unprocessableEntity(`password must be at least ${CLAIM_PASSWORD_MIN_LENGTH} characters.`, instance);
    }

    // LD-13b (STATE.md "Mail posture trio"): distinguishes ABSENT (the
    // `email` member is never sent — the invite's own emailPreset wins,
    // the long-standing behavior) from an EXPLICIT `null` (the claimant
    // opts OUT of the preset outright — the new account gets no email at
    // all, even when the invite carries one) from a submitted STRING
    // (trimmed then format-validated, same F7/R-F4 posture as before). A
    // present-but-neither-string-nor-null value 422s, same target-agnostic
    // shape-check posture as every other field in this file.
    let submittedEmail: string | null | undefined;
    if (body["email"] === undefined) {
      submittedEmail = undefined;
    } else if (body["email"] === null) {
      submittedEmail = null;
    } else if (typeof body["email"] === "string") {
      // R-F4: trim first (a whitespace-padded copy of an existing address
      // must normalize into the identical string the collision check
      // sees, not become a second, visually-distinct one).
      const trimmed = body["email"].trim();
      if (trimmed.length === 0) {
        // An all-whitespace value has never carried opt-out intent — that
        // is what an explicit `null` is for, above — so it falls back to
        // the invite's own preset exactly like an omitted member always
        // has (unchanged F7/R-F4 posture).
        submittedEmail = undefined;
      } else {
        // F7: ClaimInviteRequest.email declares format:email — only the
        // SUBMITTED value is checked (invite.email, the admin-set preset,
        // was already validated at creation time by F7's createInvite
        // check).
        if (!isValidEmailFormat(trimmed)) {
          throw unprocessableEntity("email must be a valid email address.", instance);
        }
        submittedEmail = trimmed;
      }
    } else {
      throw unprocessableEntity("email must be a string or null.", instance);
    }
    const email = submittedEmail !== undefined ? submittedEmail : invite.email;
    const displayName =
      typeof body["displayName"] === "string" && body["displayName"].length > 0
        ? body["displayName"]
        : invite.display_name_preset;

    let deviceProfile: Record<string, unknown> = {};
    if (body["deviceProfile"] !== undefined) {
      const profileCheck = this.deviceProfileValidator.validate(body["deviceProfile"]);
      if (!profileCheck.valid) {
        throw unprocessableEntity(`deviceProfile is invalid: ${profileCheck.errors}`, instance);
      }
      deviceProfile = body["deviceProfile"] as Record<string, unknown>;
    }
    const deviceName = isNonEmptyString(body["deviceName"]) ? body["deviceName"] : CLAIM_DEVICE_NAME_DEFAULT;

    const passwordHash = await this.hashService.hash(body["password"]);

    const result = await claimInviteAndEmit(db, {
      tokenHash,
      username,
      email,
      displayName,
      passwordHash,
      nowMs,
    });

    if (!result.ok) {
      if (result.reason === "username-conflict") {
        throw unprocessableEntity(`Username "${username}" is already taken.`, instance);
      }
      if (result.reason === "email-conflict") {
        // R-F3/F3 (E8): the COMMON case — a submitted email that already
        // belongs to another account — never reaches this branch at all;
        // packages/db's claimInviteAndEmit silently drops a conflicting
        // email and completes the claim normally (201, same as a
        // fresh-email claim — no distinguishable status, body, or
        // invite-consumption difference an attacker could use as an
        // oracle). This branch is the narrow safety net for the
        // vanishing race where the email is registered in the gap
        // between that check and the INSERT; the wording still never
        // blames the username (untrue) and never confirms the email is
        // "already registered"/"in use" (that phrasing would itself be
        // the oracle) — "could not be completed" is accurate without
        // confirming anything about the address.
        throw unprocessableEntity(
          "This invite could not be completed with the submitted email address. Try again without an email, or ask whoever sent the invite for a new one.",
          instance,
        );
      }
      // A concurrent claim won the race between this handler's pre-check
      // above and claimInviteAndEmit's own atomic consume — same
      // byte-identical 404 (this is the losing side of the RACE TEST).
      throw new NotFoundException();
    }

    const device = await createDevice(db, {
      userId: result.user.id,
      name: deviceName,
      platform: null,
      profile: deviceProfile,
      nowMs,
    });

    const { token: accessToken, expiresAtMs } = await this.tokenService.signAccessToken(
      { sub: result.user.id, isAdmin: false, deviceId: device.id, restrictedUnlocked: false },
      nowMs,
    );
    const { refreshToken } = await this.refreshTokenService.issue(db, result.user.id, device.id, nowMs);

    // G7: post-commit, mail-configured-only dispatch of the email-in-use
    // notice to the EXISTING owner of a colliding address — collision &&
    // MailConfigService.isConfigured() FIRST, THEN the ledger window
    // claim, THEN trySend (mirrors users.controller.ts's updateMe
    // dispatch exactly).
    //
    // R-F5/LOW-8 (opus adversarial review, fix wave): the claim above
    // already COMMITTED (the new account, device, and refresh token all
    // exist) — this block is best-effort from here on, so any throw in it
    // is caught and swallowed rather than 500ing an otherwise-successful
    // claim on the collision-only path. R-F5: trySend's `dispatched`
    // result is no longer ignored — a queue hiccup (trySend degrading to
    // `{dispatched:false}`) releases the window it just won so a LATER
    // collision on the same address can still notify.
    if (result.collidedEmail !== null && this.mailConfig.isConfigured()) {
      try {
        const claimedAtMs = clockNowMs();
        const won = await claimEmailCollisionNoticeWindow(db, result.collidedEmail, claimedAtMs);
        if (won) {
          const { dispatched } = await this.mailDispatch.trySend({
            templateId: "email-in-use-notice",
            to: result.collidedEmail,
            params: { serverName: this.mailConfig.fromName() },
          });
          if (!dispatched) {
            await releaseEmailCollisionNoticeWindow(db, result.collidedEmail, claimedAtMs);
          }
        }
      } catch (err) {
        console.error("invites.controller: email-in-use-notice dispatch failed (claim already committed):", err);
      }
    }

    // G8: unconditional wall-clock floor — see this file's header.
    await waitOutClaimInviteFloor(startedAtMs);

    // LD-13c (STATE.md "Mail posture trio"): `emailApplied` is the honest,
    // POST-AUTH-ONLY signal that G6/F3's existing silent-drop happened —
    // `false` iff a non-null intended email (submitted or preset-
    // inherited) collided with another account's and was dropped; `true`
    // whenever the email ended up applied as intended, INCLUDING when no
    // email was ever submitted/preset (nothing to drop) and when the
    // claimant explicitly opted out via LD-13b's `email: null` (intent
    // achieved, not a drop). Safe by construction, not merely by
    // convention: this field only exists on a response the caller can
    // only obtain by actually completing a real account creation (unlike
    // GET /invites/claim/{token} or any pre-account-creation error path,
    // which never consult collision state at all — see
    // email-collision-matrix.e2e.spec.ts's pre-auth byte-identity grid),
    // so it costs a real, rate-limited claim per probe rather than being a
    // free pre-auth oracle.
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAtMs: expiresAtMs,
      deviceId: device.id,
      emailApplied: result.collidedEmail === null,
    };
  }
}
