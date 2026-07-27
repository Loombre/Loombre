// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/users.controller.ts
//
// GET/POST /users, GET/PATCH/DELETE /users/{id} (admin), GET/PATCH /users/me,
// GET/PUT /users/me/settings (self-service). See
// packages/db/src/query/admin.ts's header for why displayName is always
// `null` (no such column exists yet).

import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import {
  createUserAdminAndEmit,
  deleteUserAdmin,
  getUserById,
  getUserSettings,
  listUsersAdmin,
  updateUserAdmin,
  updateUserSelf,
  type AdminUserRow,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { forbidden, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { HashService } from "../common/hash.service.js";
import { parseListQuery } from "./viewer.js";

function mapUser(row: AdminUserRow) {
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

function mapSettings(settings: { restricted_opt_in: boolean; updated_at_ms: number } | undefined) {
  // user_settings.prefs (JSONB whitelist, CLAUDE.md invariant 3) is where
  // theme/locale/subtitle-language/etc. live implicitly (STATE.md Wave-3
  // note n1/n2/n4/n6) — Phase 1 has no typed columns for them yet, so
  // fixed, documented defaults are returned rather than partially-wired
  // fields that would silently ignore a client's PUT.
  return {
    restrictedOptIn: settings?.restricted_opt_in ?? false,
    locale: "en-US",
    theme: "system" as const,
    subtitlePreferredLanguage: null,
    audioPreferredLanguage: null,
    autoplayNextEpisode: true,
    updatedAtMs: settings?.updated_at_ms ?? clockNowMs(),
  };
}

// L2 (pre-public hardening): claim fast-fail, then a FRESH DB re-read via
// requireLiveAdmin — the JWT isAdmin claim alone can be stale for up to the
// access token's 15-minute lifetime after a demotion.
async function requireAdmin(db: LoombreDb, req: AuthenticatedRequest): Promise<void> {
  if (!req.user?.isAdmin) {
    throw forbidden("Admin privileges are required for this operation.", req.originalUrl);
  }
  await requireLiveAdmin(db, req.user.userId, req.originalUrl);
}

@Controller()
export class UsersController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly hashService: HashService,
  ) {}

  @Get("users")
  async listUsers(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await listUsersAdmin(this.dbProvider.db, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { items: page.rows.map(mapUser), nextCursor: page.nextCursor };
  }

  @Post("users")
  async createUser(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const body = rawBody ?? {};
    const instance = req.originalUrl;

    if (typeof body["username"] !== "string" || body["username"].length === 0) {
      throw unprocessableEntity("username is required.", instance);
    }
    if (typeof body["email"] !== "string" || body["email"].length === 0) {
      throw unprocessableEntity("email is required.", instance);
    }
    if (typeof body["password"] !== "string" || body["password"].length === 0) {
      throw unprocessableEntity("password is required.", instance);
    }

    const passwordHash = await this.hashService.hash(body["password"]);
    // createUserAdminAndEmit, never the non-emitting createUserAdmin: the
    // `user.created` outbox row (docs/PLAN.md §4.3) must be written in the
    // SAME transaction as the users row. actorUserId is the authenticated
    // admin resolved by requireAdmin above — without it the event would be
    // attributed to the newly created user instead of its creator
    // (@loombre/db CreateUserAdminAndEmitInput's documented fallback, which
    // exists for first-run onboarding only).
    const created = await createUserAdminAndEmit(this.dbProvider.db, {
      username: body["username"],
      email: body["email"],
      passwordHash,
      isAdmin: body["isAdmin"] === true,
      maxContentRating: typeof body["maxContentRating"] === "string" ? body["maxContentRating"] : null,
      nowMs: clockNowMs(),
      actorUserId: req.user!.userId,
    });
    return mapUser(created);
  }

  // "/users/me" and "/users/me/settings" MUST be registered before
  // "/users/:id" below — Express/Nest matches routes in REGISTRATION
  // (declaration) order, and a `:id` param segment matches the literal
  // string "me" just as readily as a UUID. Registering the literal routes
  // first is the fix (mirrors gateway.module.ts's HealthController-before-
  // NotFoundController ordering rationale for the exact same reason).

  @Get("users/me")
  async getMe(@Req() req: AuthenticatedRequest) {
    const user = await getUserById(this.dbProvider.db, req.user!.userId);
    if (!user) {
      throw notFound("User not found.", req.originalUrl);
    }
    return mapUser(user);
  }

  @Patch("users/me")
  async updateMe(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    const body = rawBody ?? {};
    const instance = req.originalUrl;
    let passwordHash: string | undefined;
    if (body["password"] !== undefined) {
      if (typeof body["password"] !== "string" || body["password"].length === 0) {
        throw unprocessableEntity("password must be a non-empty string.", instance);
      }
      passwordHash = await this.hashService.hash(body["password"]);
    }

    const updated = await updateUserSelf(this.dbProvider.db, req.user!.userId, {
      ...(typeof body["email"] === "string" ? { email: body["email"] } : {}),
      ...(body["birthDate"] !== undefined
        ? { birthDate: typeof body["birthDate"] === "string" ? body["birthDate"] : null }
        : {}),
      ...(passwordHash !== undefined ? { passwordHash } : {}),
      nowMs: clockNowMs(),
    });
    if (!updated) {
      throw notFound("User not found.", instance);
    }
    return mapUser(updated);
  }

  @Get("users/me/settings")
  async getMySettings(@Req() req: AuthenticatedRequest) {
    const settings = await getUserSettings(this.dbProvider.db, req.user!.userId);
    return mapSettings(settings);
  }

  @Put("users/me/settings")
  async putMySettings(@Req() req: AuthenticatedRequest) {
    // Phase 1 has no typed columns for the free-form preference fields this
    // schema documents (locale/theme/subtitle+audio language/autoplay) —
    // only restrictedOptIn (read-only here; changed via
    // PUT /users/me/restricted) is backed by real storage. Echoing the
    // current settings back keeps this endpoint idempotent-safe rather than
    // silently discarding a client's write with no persistence at all.
    // No UI offers these fields while that holds — the web Playback-
    // preferences form was deleted for reporting a green "Saved" over this
    // no-op (apps/web/src/components/settings/sections/AccountSection.tsx,
    // cleanup 3); restore both ends together when user_settings.prefs is
    // wired for real (STATE.md owner ledger item 6).
    const settings = await getUserSettings(this.dbProvider.db, req.user!.userId);
    return mapSettings(settings);
  }

  @Get("users/:id")
  async getUser(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "User not found.", req.originalUrl);
    const user = await getUserById(this.dbProvider.db, id);
    if (!user) {
      throw notFound("User not found.", req.originalUrl);
    }
    return mapUser(user);
  }

  @Patch("users/:id")
  async updateUser(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "User not found.", req.originalUrl);
    const body = rawBody ?? {};
    const updated = await updateUserAdmin(this.dbProvider.db, id, {
      ...(typeof body["email"] === "string" ? { email: body["email"] } : {}),
      ...(typeof body["isAdmin"] === "boolean" ? { isAdmin: body["isAdmin"] } : {}),
      ...(body["maxContentRating"] !== undefined
        ? { maxContentRating: typeof body["maxContentRating"] === "string" ? body["maxContentRating"] : null }
        : {}),
      nowMs: clockNowMs(),
    });
    if (!updated) {
      throw notFound("User not found.", req.originalUrl);
    }
    return mapUser(updated);
  }

  @Delete("users/:id")
  async deleteUser(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "User not found.", req.originalUrl);
    const existing = await getUserById(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("User not found.", req.originalUrl);
    }
    await deleteUserAdmin(this.dbProvider.db, id);
  }
}
