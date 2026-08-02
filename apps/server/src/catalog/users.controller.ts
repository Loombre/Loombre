// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/users.controller.ts
//
// GET/POST /users, GET/PATCH/DELETE /users/{id} (admin), GET/PATCH /users/me,
// GET/PUT /users/me/settings (self-service).
//
// M1/M2 (migrations/0023_user_invites.sql): email is optional (an admin
// may create/leave a user email-less) and displayName is a real column at
// last — the H1 bug class this file's header used to document (the value
// was silently discarded while the UI reported "Saved") is closed.

import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import {
  createUserAdminAndEmit,
  deleteUserAdmin,
  getUserById,
  getUserSettings,
  listUsersAdmin,
  updateUserAdmin,
  updateUserPrefs,
  updateUserSelf,
  type AdminUserRow,
} from "@loombre/db";
import { isKnownLanguageCode, nowMs as clockNowMs } from "@loombre/shared";
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
    displayName: row.display_name,
    isAdmin: row.is_admin,
    birthDate: row.birth_date,
    maxContentRating: row.max_content_rating,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

const SETTINGS_THEMES = new Set(["light", "dark", "system"]);

/**
 * H1 (owner ledger item 6, closed): reads real values back out of
 * user_settings.prefs (JSONB whitelist, CLAUDE.md invariant 3) — written by
 * putMySettings below via @loombre/db's updateUserPrefs — falling back to
 * the same fixed defaults this function always returned when no PUT has
 * ever landed for this user (a fresh user_settings row's `prefs` is `{}`,
 * per migrations/0001_init.sql's `DEFAULT '{}'::jsonb`). Each key is
 * re-validated on the way OUT, not just the way in: a prefs blob written by
 * an older/looser version of this code (or edited directly) can never
 * surface a value putMySettings' current validation would now reject.
 */
function mapSettings(
  settings: { restricted_opt_in: boolean; updated_at_ms: number; prefs?: Record<string, unknown> } | undefined,
) {
  const prefs = settings?.prefs ?? {};
  const theme = prefs["theme"];
  const subtitlePreferredLanguage = prefs["subtitlePreferredLanguage"];
  const audioPreferredLanguage = prefs["audioPreferredLanguage"];
  return {
    restrictedOptIn: settings?.restricted_opt_in ?? false,
    locale: typeof prefs["locale"] === "string" && prefs["locale"].length > 0 ? prefs["locale"] : "en-US",
    theme: typeof theme === "string" && SETTINGS_THEMES.has(theme) ? (theme as "light" | "dark" | "system") : "system",
    subtitlePreferredLanguage:
      typeof subtitlePreferredLanguage === "string" && isKnownLanguageCode(subtitlePreferredLanguage)
        ? subtitlePreferredLanguage
        : null,
    audioPreferredLanguage:
      typeof audioPreferredLanguage === "string" && isKnownLanguageCode(audioPreferredLanguage)
        ? audioPreferredLanguage
        : null,
    autoplayNextEpisode: typeof prefs["autoplayNextEpisode"] === "boolean" ? prefs["autoplayNextEpisode"] : true,
    updatedAtMs: settings?.updated_at_ms ?? clockNowMs(),
  };
}

/** UserSettings' full property set (additionalProperties:false) — putMySettings
 *  422s on any OTHER key so an unknown property is rejected rather than
 *  silently ignored. */
const SETTINGS_BODY_KEYS = new Set([
  "restrictedOptIn",
  "locale",
  "theme",
  "subtitlePreferredLanguage",
  "audioPreferredLanguage",
  "autoplayNextEpisode",
  "updatedAtMs",
]);

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
    // M1: email is optional now (CreateUserRequest no longer requires it)
    // — a present-but-non-string/empty value still 422s, matching every
    // other field's "present but wrong shape" posture.
    if (body["email"] !== undefined && (typeof body["email"] !== "string" || body["email"].length === 0)) {
      throw unprocessableEntity("email must be a non-empty string when present.", instance);
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
      email: typeof body["email"] === "string" ? body["email"] : null,
      passwordHash,
      isAdmin: body["isAdmin"] === true,
      maxContentRating: typeof body["maxContentRating"] === "string" ? body["maxContentRating"] : null,
      displayName: typeof body["displayName"] === "string" ? body["displayName"] : null,
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
      // M1: UpdateMeRequest's email is now `[string, 'null']` — present-but-
      // not-a-string (i.e. explicit `null`) clears it, matching birthDate's
      // own established null-to-clear convention below.
      ...(body["email"] !== undefined ? { email: typeof body["email"] === "string" ? body["email"] : null } : {}),
      ...(body["birthDate"] !== undefined
        ? { birthDate: typeof body["birthDate"] === "string" ? body["birthDate"] : null }
        : {}),
      ...(body["displayName"] !== undefined
        ? { displayName: typeof body["displayName"] === "string" ? body["displayName"] : null }
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

  // H1 (owner ledger item 6, closed): writes user_settings.prefs for real
  // via @loombre/db's updateUserPrefs. `restrictedOptIn` and `updatedAtMs`
  // are BOTH required by the contract (UserSettings' required set, so a
  // client omitting either 422s) but their VALUES are intentionally
  // ignored: restrictedOptIn is `readOnly` in the contract (the old client
  // still sends it back — it changes only via PUT /users/me/restricted, see
  // RestrictedSection in AccountSection.tsx) and no optimistic-concurrency
  // scheme exists for updatedAtMs. Every other field is validated before
  // anything is written — locale length, the theme enum, and
  // subtitle/audio language membership in @loombre/shared's known-language
  // list (isKnownLanguageCode) — and additionalProperties:false is enforced
  // by hand via SETTINGS_BODY_KEYS, this house's established no-
  // class-validator/no-zod pattern (see createUser/updateMe above).
  @Put("users/me/settings")
  async putMySettings(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    const body = rawBody ?? {};
    const instance = req.originalUrl;

    for (const key of Object.keys(body)) {
      if (!SETTINGS_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    if (typeof body["restrictedOptIn"] !== "boolean") {
      throw unprocessableEntity("restrictedOptIn is required and must be a boolean.", instance);
    }

    const locale = body["locale"];
    if (typeof locale !== "string" || locale.length < 1 || locale.length > 35) {
      throw unprocessableEntity("locale is required and must be 1-35 characters.", instance);
    }

    const theme = body["theme"];
    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      throw unprocessableEntity("theme must be one of light, dark, system.", instance);
    }

    const subtitlePreferredLanguage = body["subtitlePreferredLanguage"];
    if (
      subtitlePreferredLanguage !== null &&
      !(typeof subtitlePreferredLanguage === "string" && isKnownLanguageCode(subtitlePreferredLanguage))
    ) {
      throw unprocessableEntity(
        "subtitlePreferredLanguage must be a known ISO 639-2 language code, or null for no preference.",
        instance,
      );
    }

    const audioPreferredLanguage = body["audioPreferredLanguage"];
    if (
      audioPreferredLanguage !== null &&
      !(typeof audioPreferredLanguage === "string" && isKnownLanguageCode(audioPreferredLanguage))
    ) {
      throw unprocessableEntity(
        "audioPreferredLanguage must be a known ISO 639-2 language code, or null for no preference.",
        instance,
      );
    }

    if (typeof body["autoplayNextEpisode"] !== "boolean") {
      throw unprocessableEntity("autoplayNextEpisode is required and must be a boolean.", instance);
    }

    if (typeof body["updatedAtMs"] !== "number" || !Number.isFinite(body["updatedAtMs"])) {
      throw unprocessableEntity("updatedAtMs is required and must be a number.", instance);
    }

    const updated = await updateUserPrefs(this.dbProvider.db, {
      userId: req.user!.userId,
      prefs: {
        locale,
        theme,
        subtitlePreferredLanguage,
        audioPreferredLanguage,
        autoplayNextEpisode: body["autoplayNextEpisode"],
      },
      updatedAtMs: clockNowMs(),
    });
    return mapSettings(updated);
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
      // M1: UpdateUserRequest.email is `[string, 'null']` now — present-but-
      // not-a-string clears it (same null-to-clear convention as
      // maxContentRating below).
      ...(body["email"] !== undefined ? { email: typeof body["email"] === "string" ? body["email"] : null } : {}),
      ...(typeof body["isAdmin"] === "boolean" ? { isAdmin: body["isAdmin"] } : {}),
      ...(body["maxContentRating"] !== undefined
        ? { maxContentRating: typeof body["maxContentRating"] === "string" ? body["maxContentRating"] : null }
        : {}),
      ...(body["displayName"] !== undefined
        ? { displayName: typeof body["displayName"] === "string" ? body["displayName"] : null }
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
