// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/users-me.controller.ts
//
// PUT /users/me/restricted (task spec, docs/PLAN.md §6.4 gate 3): SELF
// opt-in + PIN management. There is no admin path here by construction —
// the route has no user-id param, it always acts on the caller from the
// AuthGuard-attached `req.user`.

import { Body, Controller, Put, Req } from "@nestjs/common";
import { getUserSettings, updateRestrictedSettings } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { HashService } from "../common/hash.service.js";

interface RestrictedSettingsUpdateBody {
  optIn?: unknown;
  pin?: unknown;
  currentPin?: unknown;
}

interface RestrictedSettingsResponse {
  optIn: boolean;
  hasPin: boolean;
  unlockedUntilMs: number | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

@Controller("users/me")
export class UsersMeController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly hashService: HashService,
  ) {}

  @Put("restricted")
  async putRestricted(
    @Body() rawBody: RestrictedSettingsUpdateBody | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<RestrictedSettingsResponse> {
    const body = rawBody ?? {};
    const instance = req.originalUrl;
    const userId = req.user!.userId; // AuthGuard guarantees this on any non-public route.

    if (typeof body.optIn !== "boolean") {
      throw unprocessableEntity("optIn (boolean) is required.", instance);
    }

    const db = this.dbProvider.db;
    const nowMs = clockNowMs();
    const current = await getUserSettings(db, userId);
    const currentlyOptedIn = current?.restricted_opt_in ?? false;
    const currentPinHash = current?.restricted_pin_hash ?? null;

    const pin = isNonEmptyString(body.pin) ? body.pin : undefined;
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
