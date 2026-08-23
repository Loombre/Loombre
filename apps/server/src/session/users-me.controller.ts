// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/users-me.controller.ts
//
// GET + PUT /users/me/restricted (task spec, docs/PLAN.md §6.4 gate 3):
// SELF opt-in + PIN management, and (browser-restricted-settings-F3) the
// matching read of that same state for a freshly-loaded client — see
// getRestricted's own comment below. There is no admin path here by construction —
// the route has no user-id param, it always acts on the caller from the
// AuthGuard-attached `req.user`. Still true over HTTP after H2: a user who
// forgets their PIN entirely (nothing to prove via `currentPin` below) has
// no path through THIS endpoint — the recovery is the server-local
// `loombre admin reset-pin <username>` CLI command (apps/server/src/cli/
// admin-reset-pin.ts), deliberately never exposed here or anywhere else
// over HTTP; filesystem access to the running server is that privilege
// boundary, not a bearer token.
//
// A NEW pin must match the contract's `^[0-9]{4}$` exactly (pin-format.ts —
// read its header for why: the unlock UI can only ever enter 4 digits, so
// storing any other length is a permanent lockout). `currentPin` is NOT
// format-checked: it proves an already-stored secret that may predate the
// rule, and this endpoint is that user's only route back to a conforming
// PIN. Both are still checked for non-emptiness.
//
// G3/G4 (STATE.md "Current-password re-auth on self-changes"): EVERY call
// to this endpoint is account-critical (PIN set/change AND opt-in/out are
// one operation, F1) — currentPassword re-authentication is therefore
// unconditionally required, checked via the SAME shared
// requireCurrentPassword helper (common/) updateMe uses, BEFORE the optIn/
// pin business logic (same "rate-limit attempt before the real check"
// ordering restricted.controller.ts's unlock handler already establishes).
// currentPin logic below is UNCHANGED (F4: currentPassword is additional,
// never a PIN-verification replacement).

import { Body, Controller, Get, Put, Req, UseFilters } from "@nestjs/common";
import { getUserSettings, updateRestrictedSettings } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { HashService } from "../common/hash.service.js";
import { AnomalyLogService } from "../common/anomaly-log.service.js";
import { CurrentPasswordRateLimiterService } from "../common/current-password-rate-limiter.service.js";
import { requireCurrentPassword } from "../common/require-current-password.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { PIN_LENGTH, isValidNewPin } from "./pin-format.js";

interface RestrictedSettingsUpdateBody {
  optIn?: unknown;
  pin?: unknown;
  currentPin?: unknown;
  currentPassword?: unknown;
}

interface RestrictedSettingsResponse {
  optIn: boolean;
  hasPin: boolean;
  unlockedUntilMs: number | null;
}

/** RestrictedSettingsUpdate's full property set (additionalProperties:
 *  false, G3) — putRestricted used to silently ignore an unknown key;
 *  same allowlist precedent as catalog/users.controller.ts's
 *  UPDATE_ME_BODY_KEYS/SETTINGS_BODY_KEYS. */
const RESTRICTED_SETTINGS_BODY_KEYS = new Set(["optIn", "pin", "currentPin", "currentPassword"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

@Controller("users/me")
@UseFilters(RateLimitExceptionFilter)
export class UsersMeController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly hashService: HashService,
    private readonly anomalyLog: AnomalyLogService,
    private readonly currentPasswordRateLimiter: CurrentPasswordRateLimiterService,
  ) {}

  // GET /users/me/restricted (browser-restricted-settings-F3 /
  // browser-items-F3, 2026-08-21 QA): the READ side of the state the PUT
  // below returns. Until this existed a web client could only learn its own
  // {optIn, hasPin, unlockedUntilMs} as the RESULT OF A MUTATION, so a fresh
  // page load had to guess — it showed first-time-opt-in UI to a PIN holder
  // (hasPin unknown) and a "locked" indicator while the server was still
  // serving the zone from a live unlock window.
  //
  // Self-scoped by construction, exactly like the PUT: no user-id param,
  // always the AuthGuard-attached caller. No currentPassword re-auth and no
  // rate-limit budget — this reads nothing an authenticated caller cannot
  // already infer about their OWN account, and it verifies no secret (the
  // G3/G4 re-auth rule covers account-critical WRITES). The PIN itself is
  // never returned in any form; `hasPin` is a boolean.
  @Get("restricted")
  async getRestricted(@Req() req: AuthenticatedRequest): Promise<RestrictedSettingsResponse> {
    const userId = req.user!.userId;
    const settings = await getUserSettings(this.dbProvider.db, userId);
    const unlockedUntilMs = settings?.restricted_unlocked_until_ms ?? null;
    return {
      optIn: settings?.restricted_opt_in ?? false,
      hasPin: settings?.restricted_pin_hash != null,
      // An ELAPSED window reads as null, never as a stale past timestamp:
      // gate 5 is `unlockedUntilMs > now` server-side
      // (common/resolve-clearance.ts), so this is the same lock state the
      // server itself would apply to the very next request — the whole
      // point of the endpoint is that a client can mirror it rather than
      // re-derive it.
      unlockedUntilMs: unlockedUntilMs !== null && unlockedUntilMs > clockNowMs() ? unlockedUntilMs : null,
    };
  }

  @Put("restricted")
  async putRestricted(
    @Body() rawBody: RestrictedSettingsUpdateBody | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<RestrictedSettingsResponse> {
    const body = rawBody ?? {};
    const instance = req.originalUrl;
    const userId = req.user!.userId; // AuthGuard guarantees this on any non-public route.

    for (const key of Object.keys(body)) {
      if (!RESTRICTED_SETTINGS_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }

    const db = this.dbProvider.db;

    // G3: ALWAYS required on this endpoint — every call is account-critical.
    await requireCurrentPassword({
      db,
      userId,
      currentPasswordValue: body.currentPassword,
      instance,
      hashService: this.hashService,
      rateLimiter: this.currentPasswordRateLimiter,
      anomalyLog: this.anomalyLog,
    });

    if (typeof body.optIn !== "boolean") {
      throw unprocessableEntity("optIn (boolean) is required.", instance);
    }

    const nowMs = clockNowMs();
    const current = await getUserSettings(db, userId);
    const currentlyOptedIn = current?.restricted_opt_in ?? false;
    const currentPinHash = current?.restricted_pin_hash ?? null;

    // `pin` is validated whenever the key is PRESENT — not only on the
    // branches that go on to hash it — so a malformed value can never be
    // silently dropped and reported as a successful save.
    if (body.pin !== undefined && !isValidNewPin(body.pin)) {
      throw unprocessableEntity(
        `pin must be exactly ${PIN_LENGTH} digits (0-9).`,
        instance,
      );
    }

    const pin = isValidNewPin(body.pin) ? body.pin : undefined;
    const currentPin = isNonEmptyString(body.currentPin) ? body.currentPin : undefined;

    let newPinHash: string | null;

    if (body.optIn) {
      if (!currentlyOptedIn || currentPinHash === null) {
        // First-time opt-in (or opting back in after a prior opt-out
        // cleared the PIN): a brand-new PIN is required.
        if (!pin) {
          throw unprocessableEntity(
            "pin is required when enabling opt-in for the first time.",
            instance,
          );
        }
        newPinHash = await this.hashService.hash(pin);
      } else if (pin) {
        // Changing an existing PIN requires proving the current one.
        if (!currentPin) {
          throw unprocessableEntity("currentPin is required to change the PIN.", instance);
        }
        const currentPinOk = await this.hashService.verify(currentPinHash, currentPin);
        if (!currentPinOk) {
          throw unprocessableEntity("currentPin is incorrect.", instance);
        }
        newPinHash = await this.hashService.hash(pin);
      } else {
        // Idempotent: already opted in, no PIN change requested.
        newPinHash = currentPinHash;
      }
    } else {
      // Opting out.
      if (currentlyOptedIn && currentPinHash !== null) {
        if (!currentPin) {
          throw unprocessableEntity("currentPin is required to opt out.", instance);
        }
        const currentPinOk = await this.hashService.verify(currentPinHash, currentPin);
        if (!currentPinOk) {
          throw unprocessableEntity("currentPin is incorrect.", instance);
        }
      }
      newPinHash = null;
    }

    const updated = await updateRestrictedSettings(db, {
      userId,
      optIn: body.optIn,
      pinHash: newPinHash,
      updatedAtMs: nowMs,
    });

    return {
      optIn: updated.restricted_opt_in,
      hasPin: updated.restricted_pin_hash !== null,
      unlockedUntilMs: updated.restricted_unlocked_until_ms,
    };
  }
}
