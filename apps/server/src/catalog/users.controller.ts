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
//
// G3/G4/G6/G7/G8/G9 (STATE.md "Current-password re-auth on self-changes"):
// updateMe now requires currentPassword whenever the body carries a
// password and/or email member (requireCurrentPassword, common/), rate-
// limited per-user (RateLimitExceptionFilter registered below, G4);
// updateUserSelf's email-collision silent-no-op (G6) dispatches the
// email-in-use notice post-commit when mail is configured (G7); a
// collision-bearing request pays the same wall-clock floor as a clean one
// (G8); updateUser (admin) now surfaces a real 409 on an email conflict
// instead of an uncaught 500 (G9).
//
// Opus adversarial review fix wave (STATE.md, same run): R-F3 closes a
// self-takeover hole — an admin resetting THEIR OWN account via
// resetUserPassword now also requires currentPassword (a stolen bearer
// token alone must never mint a permanent takeover, same F1 reasoning as
// updateMe/putRestricted; admin-on-ANOTHER-user stays exactly as before,
// live-admin-verified + audited). R-F4 validates email FORMAT (not just
// `typeof === "string"`) via @loombre/shared's isValidEmailFormat
// (zod's z.email(), same primitive settings-registry.ts already uses for
// mail.fromAddress) on every stored address here (updateMe, createUser) —
// trimmed first, so a whitespace-padded copy of an existing address
// normalizes into the SAME address (and is caught by the ordinary
// collision path) rather than becoming a second, visually-identical row.
// R-F5/LOW-8 (the email-in-use notice's post-commit block) and R-F6 (the
// email-collision 23505 backstop) are fixed in packages/db/src/query/
// admin.ts and email-collision-notice.ts — see those files' own headers.
//
// api-validation-F2 (QA 2026-08-21 remediation): createUser gets G9's
// treatment at last — a duplicate username OR email on POST /users used to
// be an uncaught 23505 rendered as a generic 500; both constraints are
// classified and answered 409 now (see uniqueViolationConstraint below and
// apps/server/test/users-duplicate-conflict.e2e.spec.ts).
//
// api-validation-F3 (same run): updateMe's birthDate gets R-F4's treatment
// too — `typeof === "string"` was the whole check, so a malformed date
// reached the Postgres `date` cast and 500'd, and a LOOSELY-parseable one
// ("now()", "03/14/1988") was stored as a date the caller never sent. It
// is format-checked against the contract's `format: date` now (common/
// iso-date.ts, apps/server/test/users-birthdate-validation.e2e.spec.ts).
// PATCH /users/me is the ONLY request path in this server that accepts a
// birthDate (updateUserAdmin/createUser take no such member, and
// UpdateMeRequest is the only request schema in openapi.yaml declaring
// one) — if you ever add a second, route it through isValidIsoDate.
//
// api-validation-F5 (same run): the hand-rolled body validation this house
// uses instead of class-validator/zod was applied UNEVENLY. updateMe,
// resetUserPassword and putMySettings each ran an allowlist loop; createUser
// and updateUser ran none, so an unknown key answered 201/200 and performed
// the mutation anyway, against request schemas that both declare
// `additionalProperties: false`. Worse, their nullable members used
// `typeof x === "string" ? x : null`, so a WRONG-TYPED value silently
// CLEARED the stored value (`PATCH /users/{id} {"email":42}` wiped the
// address) and `isAdmin: "yes"` fell through `=== true` to a silently
// ignored `false`. Both handlers now run CREATE_USER_BODY_KEYS /
// UPDATE_USER_BODY_KEYS and refuse wrong-typed values with the 422 their
// operations already declare; an explicit `null` still clears, which is
// what the contract's `[string, 'null']` members mean. Regression net:
// apps/server/test/api-body-validation.e2e.spec.ts.
//
// UNCHANGED, deliberately: updateMe's own null-to-clear coercion for a
// present-but-wrong-typed nullable member — api-validation-F3 pinned that
// cell on purpose (users-birthdate-validation.e2e.spec.ts) and F5's fix
// direction names createUser/updateUser only.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseFilters } from "@nestjs/common";
import {
  claimEmailCollisionNoticeWindow,
  createUserAdminAndEmit,
  deleteUserAdmin,
  getUserById,
  getUserSettings,
  listUsersAdmin,
  releaseEmailCollisionNoticeWindow,
  resetUserPasswordAndEmit,
  updateUserAdmin,
  updateUserPrefs,
  updateUserSelf,
  type AdminUserRow,
} from "@loombre/db";
import { generateTemporaryPassword, isKnownLanguageCode, isValidEmailFormat, nowMs as clockNowMs } from "@loombre/shared";
import { conflict, forbidden, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { HashService } from "../common/hash.service.js";
import { AnomalyLogService } from "../common/anomaly-log.service.js";
import { CurrentPasswordRateLimiterService } from "../common/current-password-rate-limiter.service.js";
import { requireCurrentPassword } from "../common/require-current-password.js";
import { isValidIsoDate } from "../common/iso-date.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { MailDispatchService } from "../mail/mail-dispatch.service.js";
import { MailConfigService } from "../mail/mail-config.service.js";
import { parseListQuery } from "./viewer.js";

// G8 (STATE.md "Current-password re-auth on self-changes"): the collision
// cell of updateMe (email member present, collided) does extra post-commit
// work — a ledger claim + a mail-send enqueue — that the non-collision
// cell never does, a fresh timing-oracle surface (a caller could time
// "did my email attempt collide" from response latency alone). Same
// FORGOT_PASSWORD_MIN_MS precedent (auth.controller.ts) — a fixed
// wall-clock floor applied whenever the body carries an `email` member
// (collision or not), so both cells cost the same from the caller's
// point of view. Plain profile saves (no email member) are unfloored.
const EMAIL_CHANGE_MIN_MS = 200;

async function waitOutEmailChangeFloor(startedAtMs: number): Promise<void> {
  const remainingMs = EMAIL_CHANGE_MIN_MS - (clockNowMs() - startedAtMs);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
}

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
    // E3a/M14, admin visibility — additive; always sent.
    mustChangePassword: row.must_change_password,
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

/** UpdateMeRequest's full property set (additionalProperties:false, G3) —
 *  updateMe 422s on any OTHER key, same SETTINGS_BODY_KEYS/
 *  CLAIM_INVITE_BODY_KEYS precedent (invites.controller.ts). */
const UPDATE_ME_BODY_KEYS = new Set(["displayName", "email", "birthDate", "password", "currentPassword"]);

/** AdminResetPasswordRequest's full property set (additionalProperties:false,
 *  R-F3 fix wave) — same allowlist pattern as UPDATE_ME_BODY_KEYS above. */
const RESET_PASSWORD_BODY_KEYS = new Set(["currentPassword"]);

/** CreateUserRequest's full property set (additionalProperties:false,
 *  api-validation-F5) — createUser used to run NO allowlist at all, so an
 *  unknown key answered 201 and created the row. */
const CREATE_USER_BODY_KEYS = new Set(["username", "email", "password", "displayName", "isAdmin", "maxContentRating"]);

/** UpdateUserRequest's full property set (additionalProperties:false,
 *  api-validation-F5). Deliberately NARROWER than UPDATE_ME_BODY_KEYS: an
 *  admin PATCH cannot set a password (POST /users/{id}/reset-password is
 *  that path) and carries no birthDate member. */
const UPDATE_USER_BODY_KEYS = new Set(["email", "displayName", "isAdmin", "maxContentRating"]);

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

// api-validation-F2 (QA 2026-08-21, P1): `users` carries TWO unique
// constraints — `users_username_key` and `users_email_key` (both CITEXT,
// migrations/0001; email loosened to NULLable by 0023, still unique when
// present). createUser below had neither a duplicate pre-check nor a
// unique-violation catch, so either constraint's 23505 travelled uncaught
// out of createUserAdminAndEmit's INSERT and ProblemJsonExceptionFilter's
// generic `@Catch()` rendered `urn:loombre:problem:internal` 500 for
// ordinary, user-typo-level input. Mapped to a real 409 now — the same
// treatment G9 gave the PATCH path (updateUser, further down this file).
//
// Matched by CONSTRAINT NAME, never by `code` alone: that transaction also
// writes the `user.created` outbox row, and a unique violation from THERE
// must stay an internal error rather than a misleading "already exists"
// (plugin-registration.service.ts's isBaseUrlUniqueViolation carries the
// identical rationale). The error's own `constraint` field is what's read
// — never `detail`, which echoes the conflicting VALUE back
// (packages/db/src/query/invites.ts documents that leak).
const USERS_USERNAME_UNIQUE_CONSTRAINT = "users_username_key";
const USERS_EMAIL_UNIQUE_CONSTRAINT = "users_email_key";

function uniqueViolationConstraint(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = err as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23505") return undefined;
  return typeof candidate.constraint === "string" ? candidate.constraint : undefined;
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
@UseFilters(RateLimitExceptionFilter)
export class UsersController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly hashService: HashService,
    private readonly mailDispatchService: MailDispatchService,
    private readonly mailConfigService: MailConfigService,
    private readonly anomalyLog: AnomalyLogService,
    private readonly currentPasswordRateLimiter: CurrentPasswordRateLimiterService,
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

    // api-validation-F5: CreateUserRequest declares additionalProperties:
    // false, and this is where that is enforced — the same loop updateMe/
    // putMySettings/resetUserPassword have always run. Before it, a POST
    // /users carrying `bogus: true` (or a misspelled `admin` for `isAdmin`)
    // answered 201 AND created the row, silently dropping the key.
    for (const key of Object.keys(body)) {
      if (!CREATE_USER_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    if (typeof body["username"] !== "string" || body["username"].length === 0) {
      throw unprocessableEntity("username is required.", instance);
    }
    // M1: email is optional now (CreateUserRequest no longer requires it)
    // — a present-but-non-string/empty value still 422s, matching every
    // other field's "present but wrong shape" posture.
    if (body["email"] !== undefined && (typeof body["email"] !== "string" || body["email"].length === 0)) {
      throw unprocessableEntity("email must be a non-empty string when present.", instance);
    }
    // R-F4 (opus adversarial review, fix wave): trim first — a
    // whitespace-padded address normalizes to the same string a clean
    // submission would, rather than becoming a second, visually-identical
    // stored value — then reject anything that isn't a real email shape
    // (the contract declares `format: email`; this used to be the only
    // gap between it and the server).
    const email = typeof body["email"] === "string" ? body["email"].trim() : null;
    if (email !== null && !isValidEmailFormat(email)) {
      throw unprocessableEntity("email must be a valid email address.", instance);
    }
    if (typeof body["password"] !== "string" || body["password"].length === 0) {
      throw unprocessableEntity("password is required.", instance);
    }
    // api-validation-F5: wrong-typed values are REFUSED, never coerced.
    // `isAdmin: "yes"` used to fall through `=== true` to a silently
    // ignored `false`, and a non-string displayName/maxContentRating was
    // coerced to null — a type mistake that CLEARED the field instead of
    // failing. CreateUserRequest types them `boolean` and
    // `[string, 'null']`, so explicit `null` still means "no value" and
    // everything else 422s. (`email`'s own present-but-wrong-shape 422 is
    // the M1 check above; it is deliberately stricter than the contract's
    // nullable type and stays as it is.)
    if (body["isAdmin"] !== undefined && typeof body["isAdmin"] !== "boolean") {
      throw unprocessableEntity("isAdmin must be a boolean.", instance);
    }
    if (
      body["maxContentRating"] !== undefined &&
      body["maxContentRating"] !== null &&
      typeof body["maxContentRating"] !== "string"
    ) {
      throw unprocessableEntity("maxContentRating must be a string or null.", instance);
    }
    if (body["displayName"] !== undefined && body["displayName"] !== null && typeof body["displayName"] !== "string") {
      throw unprocessableEntity("displayName must be a string or null.", instance);
    }

    const passwordHash = await this.hashService.hash(body["password"]);
    // createUserAdminAndEmit, never the non-emitting createUserAdmin: the
    // `user.created` outbox row (docs/PLAN.md §4.3) must be written in the
    // SAME transaction as the users row. actorUserId is the authenticated
    // admin resolved by requireAdmin above — without it the event would be
    // attributed to the newly created user instead of its creator
    // (@loombre/db CreateUserAdminAndEmitInput's documented fallback, which
    // exists for first-run onboarding only).
    //
    // api-validation-F2: the INSERT, not a pre-check, is the arbiter of
    // "taken" — a SELECT-then-INSERT pair would still lose the race two
    // concurrent creates of the same username can produce, and would have
    // to answer 500 when it did. Catching the constraint the database
    // actually raised is correct for BOTH the ordinary case and the race.
    // Both constraints are distinguished so a free username never surfaces
    // as a (false) username conflict when it was the email that collided.
    let created: AdminUserRow;
    try {
      created = await createUserAdminAndEmit(this.dbProvider.db, {
        username: body["username"],
        email,
        passwordHash,
        isAdmin: body["isAdmin"] === true,
        maxContentRating: typeof body["maxContentRating"] === "string" ? body["maxContentRating"] : null,
        displayName: typeof body["displayName"] === "string" ? body["displayName"] : null,
        nowMs: clockNowMs(),
        actorUserId: req.user!.userId,
      });
    } catch (err) {
      // Truthful wording is safe here for the same reason G9's 409 is:
      // this endpoint is admin-only and admins already enumerate every
      // account via GET /users, so there is no enumeration channel to
      // protect (unlike the self-serve invite-claim path, which keeps its
      // silent email drop — packages/db/src/query/invites.ts).
      const constraintName = uniqueViolationConstraint(err);
      if (constraintName === USERS_USERNAME_UNIQUE_CONSTRAINT) {
        throw conflict("A user with this username already exists.", instance);
      }
      if (constraintName === USERS_EMAIL_UNIQUE_CONSTRAINT) {
        throw conflict("A user with this email address already exists.", instance);
      }
      throw err;
    }
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

  // G3/G6/G7/G8 (STATE.md "Current-password re-auth on self-changes"):
  // re-auth is required iff the body carries a `password` and/or `email`
  // member (ANY value, `email: null` to clear included) — the target-
  // agnostic 422/403 both go through the shared requireCurrentPassword
  // helper (common/), same detail regardless of which field prompted it
  // (F2). The wall-clock floor (G8) always wraps the WHOLE handler when
  // an email member is present, so the collision and non-collision cells
  // cost the caller the same regardless of any early throw along the way
  // — a `try/finally` would let a 422/403/404 skip the floor entirely,
  // which is exactly the timing leak G8 exists to close, so the floor is
  // applied on every exit path via the awaited helper below instead.
  @Patch("users/me")
  async updateMe(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    const startedAtMs = clockNowMs();
    const body = rawBody ?? {};
    const instance = req.originalUrl;
    const userId = req.user!.userId;
    const floorRequired = body["email"] !== undefined;

    for (const key of Object.keys(body)) {
      if (!UPDATE_ME_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    const reauthRequired = body["password"] !== undefined || body["email"] !== undefined;
    if (reauthRequired) {
      await requireCurrentPassword({
        db: this.dbProvider.db,
        userId,
        currentPasswordValue: body["currentPassword"],
        instance,
        hashService: this.hashService,
        rateLimiter: this.currentPasswordRateLimiter,
        anomalyLog: this.anomalyLog,
      });
    }

    let passwordHash: string | undefined;
    if (body["password"] !== undefined) {
      if (typeof body["password"] !== "string" || body["password"].length === 0) {
        throw unprocessableEntity("password must be a non-empty string.", instance);
      }
      // OPEN ledger item 8 ("Re-setting the same temporary password clears
      // must_change_password — no 'must differ from temp' check"): without
      // this, a user handed a temporary password could satisfy the
      // required-change gate (auth.guard.ts's must-change-password lockdown)
      // by resubmitting the SAME password — must_change_password clears
      // (runUpdateUserSelfTransaction below), but nothing has actually
      // changed. `reauthRequired` above guarantees requireCurrentPassword
      // already verified `body["currentPassword"]` against the caller's
      // CURRENT hash whenever `password` is present, so it is a plaintext
      // string here — a plain equality check against the new password is
      // both correct and free (no extra hash work).
      if (body["password"] === body["currentPassword"]) {
        throw unprocessableEntity("password must differ from the current password.", instance);
      }
      passwordHash = await this.hashService.hash(body["password"]);
    }

    // R-F4 (opus adversarial review, fix wave): trim, THEN validate format
    // — a taken address padded with whitespace (`" victim@x.y "`) must
    // normalize into the SAME string the collision pre-SELECT already
    // catches, not become a second, visually-identical stored value; a
    // string that still isn't a real email shape after trimming 422s
    // (target-agnostic — a syntax check on the caller's OWN submitted
    // string reveals nothing about any other account, E8-safe). Explicit
    // `null` (clear) bypasses this entirely, matching the null-to-clear
    // convention every other nullable field here already uses.
    let emailInput: string | null | undefined;
    if (body["email"] !== undefined) {
      if (typeof body["email"] === "string") {
        const trimmed = body["email"].trim();
        if (!isValidEmailFormat(trimmed)) {
          throw unprocessableEntity("email must be a valid email address.", instance);
        }
        emailInput = trimmed;
      } else {
        emailInput = null;
      }
    }

    // api-validation-F3 (QA 2026-08-21, P1): birthDate gets email's R-F4
    // treatment at last. `typeof === "string"` used to be the WHOLE check
    // here, so any string travelled verbatim into updateUserSelf and the
    // Postgres `date` column — where it either blew up (22007/22008 out of
    // the driver, uncaught, rendered `urn:loombre:problem:internal` **500**
    // for a plain client typo: the cited defect) or, worse, was quietly
    // ACCEPTED by Postgres' deliberately-loose date input and stored as a
    // value the caller never sent (`now()` -> today's date; `03/14/1988`
    // read per DateStyle). The second half matters more than it looks:
    // birth_date is resolve-clearance.ts's gate 2, so a silently-wrong
    // date moves a user across the age boundary that unlocks restricted
    // content. Both are closed by validating the caller's own string
    // BEFORE the cast, against the exact shape the contract declares
    // (`UpdateMeRequest.birthDate: { type: [string,'null'], format: date }`
    // — an RFC 3339 full-date), and 422ing on anything else (a response
    // this operation already declares). Present-but-not-a-string still
    // clears, unchanged: that is this file's null-to-clear convention for
    // every nullable member (email/displayName/maxContentRating), not part
    // of the format gap.
    let birthDateInput: string | null | undefined;
    if (body["birthDate"] !== undefined) {
      if (typeof body["birthDate"] === "string") {
        if (!isValidIsoDate(body["birthDate"])) {
          throw unprocessableEntity("birthDate must be a calendar date in YYYY-MM-DD form.", instance);
        }
        birthDateInput = body["birthDate"];
      } else {
        birthDateInput = null;
      }
    }

    const result = await updateUserSelf(this.dbProvider.db, userId, {
      // M1: UpdateMeRequest's email is now `[string, 'null']` — present-but-
      // not-a-string (i.e. explicit `null`) clears it, matching birthDate's
      // own established null-to-clear convention below.
      ...(emailInput !== undefined ? { email: emailInput } : {}),
      ...(birthDateInput !== undefined ? { birthDate: birthDateInput } : {}),
      ...(body["displayName"] !== undefined
        ? { displayName: typeof body["displayName"] === "string" ? body["displayName"] : null }
        : {}),
      ...(passwordHash !== undefined ? { passwordHash } : {}),
      // F5: only consulted when passwordHash is present (see
      // updateUserSelf's own doc comment) — the caller's OWN device, from
      // the access-token claim, so THIS session survives its own password
      // change while every other one is revoked.
      currentDeviceId: req.user?.deviceId ?? null,
      nowMs: clockNowMs(),
    });
    if (!result) {
      if (floorRequired) await waitOutEmailChangeFloor(startedAtMs);
      throw notFound("User not found.", instance);
    }

    // G7: post-commit, mail-configured-only dispatch of the email-in-use
    // notice to the EXISTING owner of a colliding address — collision &&
    // MailConfigService.isConfigured() FIRST, THEN the ledger window
    // claim, THEN trySend (an unconfigured install never burns the
    // window; a mail-configured install that's already inside another
    // notice's 24h window for the SAME address never sends a second one).
    //
    // R-F5/LOW-8 (opus adversarial review, fix wave): the profile update
    // above already COMMITTED — this whole block is best-effort from here
    // on, so ANY throw in it (the ledger claim is a live DB call) is
    // caught and swallowed rather than failing an otherwise-successful
    // request on the collision-only path (a distinguishable-failure
    // signal LOW-8 named in its own right). R-F5: trySend's `dispatched`
    // result is no longer ignored — when the queue enqueue itself throws
    // and trySend degrades to `{dispatched:false}` (its documented E6
    // posture), the window this call just won is immediately released so
    // a LATER collision on the same address can still notify, instead of
    // silently burning the full 24h on a notice nobody received.
    if (result.collidedEmail !== null && this.mailConfigService.isConfigured()) {
      try {
        const claimedAtMs = clockNowMs();
        const won = await claimEmailCollisionNoticeWindow(this.dbProvider.db, result.collidedEmail, claimedAtMs);
        if (won) {
          const { dispatched } = await this.mailDispatchService.trySend({
            templateId: "email-in-use-notice",
            to: result.collidedEmail,
            params: { serverName: this.mailConfigService.fromName() },
          });
          if (!dispatched) {
            await releaseEmailCollisionNoticeWindow(this.dbProvider.db, result.collidedEmail, claimedAtMs);
          }
        }
      } catch (err) {
        console.error("users.controller: email-in-use-notice dispatch failed (profile update already committed):", err);
      }
    }

    if (floorRequired) await waitOutEmailChangeFloor(startedAtMs);
    return mapUser(result.user);
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

    // api-validation-F5: UpdateUserRequest declares additionalProperties:
    // false and types every member; neither was enforced. An unknown key
    // (or a member that belongs to a DIFFERENT schema — `password`,
    // `birthDate`, `username`) answered 200, wrote nothing, and still
    // bumped updated_at; a wrong-typed value did worse, taking the
    // `: null` branch below and CLEARING the stored email/displayName/
    // maxContentRating the caller never meant to touch. Both 422 now (a
    // response this operation already declares), and nothing is written
    // on either path. Explicit `null` still clears — that is what the
    // contract's `[string, 'null']` members mean, and the null-to-clear
    // convention this file has always used.
    for (const key of Object.keys(body)) {
      if (!UPDATE_USER_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, req.originalUrl);
      }
    }
    if (body["email"] !== undefined && body["email"] !== null && typeof body["email"] !== "string") {
      throw unprocessableEntity("email must be a string or null.", req.originalUrl);
    }
    if (body["isAdmin"] !== undefined && typeof body["isAdmin"] !== "boolean") {
      throw unprocessableEntity("isAdmin must be a boolean.", req.originalUrl);
    }
    if (
      body["maxContentRating"] !== undefined &&
      body["maxContentRating"] !== null &&
      typeof body["maxContentRating"] !== "string"
    ) {
      throw unprocessableEntity("maxContentRating must be a string or null.", req.originalUrl);
    }
    if (body["displayName"] !== undefined && body["displayName"] !== null && typeof body["displayName"] !== "string") {
      throw unprocessableEntity("displayName must be a string or null.", req.originalUrl);
    }

    const result = await updateUserAdmin(this.dbProvider.db, id, {
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
    if (!result.ok) {
      if (result.reason === "not-found") {
        throw notFound("User not found.", req.originalUrl);
      }
      // G9: today's uncaught-23505 500 replaced with a real 409 — admins
      // already enumerate every account via GET /users, so unlike
      // updateUserSelf's silent E8 drop, no enumeration concern applies
      // here (same posture as Addendum A's env-pin-lockout 409).
      throw conflict("A user with this email address already exists.", req.originalUrl);
    }
    return mapUser(result.user);
  }

  @Delete("users/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "User not found.", req.originalUrl);
    const existing = await getUserById(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("User not found.", req.originalUrl);
    }
    await deleteUserAdmin(this.dbProvider.db, id);
  }

  // E3a/M14 (STATE.md "Optional mail transport + invitation & reset
  // flows"): admin/CLI password recovery, tier (a). Admin fast-fail +
  // requireLiveAdmin (requireAdmin does both, same as every other admin
  // op above) BEFORE requireUuidParam-first for the target — order
  // matches the M14/brief instruction and every other admin action in
  // this file (requireAdmin is always the very first line). Self-reset
  // (an admin resetting THEIR OWN account) is PERMITTED — they are the
  // one person who unambiguously knows the consequence (every session,
  // including this one's refresh token, dies; the very next request needs
  // the printed temporary password).
  //
  // R-F3 (opus adversarial review, fix wave): self-reset used to need
  // NOTHING beyond the bearer token itself — a stolen admin access token
  // was a complete, silent account takeover (a printed temporary
  // password, a working login, and the real owner locked out, their own
  // password now 401ing). That is exactly the threat F1 exists to close
  // on every OTHER self-service credential change ("a re-auth prompt must
  // not become a password-guessing oracle" presumes the token ALONE
  // cannot set a password) — users-me.controller.ts's own header draws
  // the identical distinction for the CLI comparison this endpoint used
  // to lean on: "filesystem access to the running server is that
  // privilege boundary, not a bearer token." So: id === the caller's OWN
  // userId now goes through the SAME requireCurrentPassword helper
  // updateMe/putRestricted use (target-agnostic 422/403, the shared
  // per-user rate limiter, the same anomaly-log entries). Resetting
  // ANOTHER user's password is UNCHANGED — that path is already
  // live-admin-verified + audited, a different actor's credential
  // entirely, not the caller's own.
  @Post("users/:id/reset-password")
  @HttpCode(HttpStatus.OK)
  async resetUserPassword(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "User not found.", req.originalUrl);

    const db = this.dbProvider.db;
    const instance = req.originalUrl;
    const body = rawBody ?? {};

    for (const key of Object.keys(body)) {
      if (!RESET_PASSWORD_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    if (id === req.user!.userId) {
      await requireCurrentPassword({
        db,
        userId: req.user!.userId,
        currentPasswordValue: body["currentPassword"],
        instance,
        hashService: this.hashService,
        rateLimiter: this.currentPasswordRateLimiter,
        anomalyLog: this.anomalyLog,
      });
    }

    const target = await getUserById(db, id);
    if (!target) {
      throw notFound("User not found.", req.originalUrl);
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hashService.hash(temporaryPassword);

    await resetUserPasswordAndEmit(db, {
      userId: target.id,
      username: target.username,
      passwordHash,
      actor: "admin",
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
    });

    // E7/M14: when the mail tier is active AND the target has an email on
    // file, a non-fatal security-notice mail follows — never blocks or
    // changes this response either way (M7's trySend contract). Same
    // posture as AuthController.forgotPassword(): this call site never
    // pre-checks MailConfigService.isConfigured() itself — the seam
    // decides (M7: "never throws, returns dispatched:false when mail is
    // unconfigured").
    if (target.email) {
      // Lane C's security-notice template reads only {actionUrl?,
      // displayName?} (templates/types.ts) — the notice is informational,
      // so no actionUrl is passed.
      await this.mailDispatchService.trySend({
        templateId: "security-notice",
        to: target.email,
        params: { displayName: target.display_name ?? target.username },
      });
    }

    return { temporaryPassword };
  }
}
