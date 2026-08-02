// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/invites/invites.controller.ts
//
// E2 (invitations): POST/GET /invites, DELETE /invites/{id} (admin) plus
// the PUBLIC GET/POST /claim/{token} pair (M12 quartet: contract
// `security: []` + auth.guard.ts PUBLIC_ROUTE_PATTERNS + conformance
// PUBLIC_OPERATION_IDS + dedicated public-op response assertions).
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
// — so ProblemJsonExceptionFilter serializes all of them to
// `{"type":"about:blank","title":"Not Found","status":404}`, indistinguishable
// from an unknown route or from each other.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import {
  claimInviteAndEmit,
  createDevice,
  createInviteAndEmit,
  deriveInviteStatus,
  getInviteByTokenHash,
  getLibraryByIdAdmin,
  isInviteClaimable,
  listInvitesAdmin,
  mapClaimState,
  revokeInviteAndEmit,
  type InviteAdminRow,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { forbidden, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
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

const EXPIRES_IN_MS_DEFAULT = 259_200_000; // 72h
const EXPIRES_IN_MS_MIN = 3_600_000; // 1h
const EXPIRES_IN_MS_MAX = 2_592_000_000; // 30d
const CLAIM_DEVICE_NAME_DEFAULT = "Invite claim";

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
  if (typeof query["limit"] === "string") {
    const n = Number.parseInt(query["limit"], 10);
    if (Number.isFinite(n) && n > 0) result.limit = n;
  }
  return result;
}

/**
 * `${publicUrl}/claim/${token}` when publicUrl is set, else null (M9). A
 * pure function so the non-null composition shape is unit-testable without
 * ever needing MailConfigService's stub to return non-null for real (see
 * mail-config.service.ts's header) — invites.controller.spec.ts exercises
 * both branches directly.
 */
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
        !Number.isFinite(body["expiresInMs"]) ||
        body["expiresInMs"] < EXPIRES_IN_MS_MIN ||
        body["expiresInMs"] > EXPIRES_IN_MS_MAX
      ) {
        throw unprocessableEntity("expiresInMs must be an integer between 1h and 30d (ms).", instance);
      }
      expiresInMs = body["expiresInMs"];
    }

    const username = typeof body["username"] === "string" && body["username"].length > 0 ? body["username"] : null;
    const displayName =
      typeof body["displayName"] === "string" && body["displayName"].length > 0 ? body["displayName"] : null;
    const email = typeof body["email"] === "string" && body["email"].length > 0 ? body["email"] : null;

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

  @Get("claim/:token")
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
      // Byte-identical to the unknown-route 404 — see this file's header.
      throw new NotFoundException();
    }

    return mapClaimState(invite);
  }

  @Post("claim/:token")
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("claim", "ip")
  @HttpCode(HttpStatus.CREATED)
  async claimInvite(
    @Param("token") token: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: Request,
  ) {
    const db = this.dbProvider.db;
    const tokenHash = this.refreshTokenService.hashToken(token);
    const nowMs = clockNowMs();
    const instance = req.originalUrl;

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

    const email = typeof body["email"] === "string" && body["email"].length > 0 ? body["email"] : invite.email;
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

    return { accessToken, refreshToken, accessTokenExpiresAtMs: expiresAtMs, deviceId: device.id };
  }
}
