// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/current-password-rate-limiter.service.ts
//
// G4 (STATE.md "Current-password re-auth on self-changes"): per-USER rate
// limiter for `currentPassword` re-authentication attempts on BOTH
// PATCH /users/me (catalog/users.controller.ts's updateMe) and
// PUT /users/me/restricted (session/users-me.controller.ts's putRestricted)
// — same "login-class, hand-rolled KeyedRateLimiter, deliberately excluded
// from the @RateLimit decorator union" posture as
// session/auth-rate-limiter.service.ts's login/refresh/unlock trio (a
// re-auth prompt must not become a password-guessing oracle, F1).
// `.attempt(userId)` is called ONLY when re-auth is actually required,
// BEFORE the argon2id compare (apps/server/src/common/
// require-current-password.ts).
//
// LIVES IN common/, NOT alongside its three siblings in
// auth-rate-limiter.service.ts, for a structural reason: its two call
// sites span BOTH catalog/ and session/ — dependency-cruiser's D2
// module-boundary rule (catalog and session may only share IDs, never
// import one another) makes it impossible for a single service reachable
// from both to live in session/. Exact same relocation rationale as
// common/rate-limiter.ts's own header (that file's own P4.15 sweep, "common/
// is the established escape valve for exactly this kind of cross-cutting
// infra") — applied here to a second primitive for the identical
// structural reason, rather than moving the whole (session-only-consumed)
// AuthRateLimiterService itself, which stays put unchanged.
//
// Registry-driven (packages/shared/src/settings-registry.ts's
// rateLimit.currentPassword, env LOOMBRE_RATE_CURRENT_PASSWORD,
// requiresRestart:false) — same construction/onChange/onApplicationBootstrap
// shape as AuthRateLimiterService, including its documented lifecycle
// hazard fix (constructor-time SettingsService reads can throw before
// SettingsService's own onApplicationBootstrap has populated its cache;
// safeEffectiveNumber() below never throws, and onApplicationBootstrap()
// here re-applies the real effective policy once that cache is guaranteed
// loaded — see that file's header for the full empirical writeup).

import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { KeyedRateLimiter, type TokenBucketOptions } from "./rate-limiter.js";
import { SettingsService } from "../settings/settings.service.js";

const ONE_MINUTE_MS = 60_000;
const DEFAULT_CAPACITY = 10;
const SETTINGS_KEY = "rateLimit.currentPassword";

function safeEffectiveNumber(settingsService: SettingsService, key: string, fallback: number): number {
  try {
    const effective = settingsService.getEffective(key);
    return effective !== undefined ? (effective.value as number) : fallback;
  } catch {
    return fallback;
  }
}

function policy(settingsService: SettingsService): TokenBucketOptions {
  const capacity = safeEffectiveNumber(settingsService, SETTINGS_KEY, DEFAULT_CAPACITY);
  return { capacity, refillMs: ONE_MINUTE_MS / capacity };
}

@Injectable()
export class CurrentPasswordRateLimiterService implements OnApplicationBootstrap {
  /** PATCH /users/me + PUT /users/me/restricted currentPassword re-auth
   *  attempts — per-USER (default 10/min, rateLimit.currentPassword). */
  readonly currentPassword: KeyedRateLimiter;

  constructor(private readonly settingsService: SettingsService) {
    this.currentPassword = new KeyedRateLimiter(policy(settingsService));

    settingsService.onChange((event) => {
      if (event.key === SETTINGS_KEY) {
        this.currentPassword.updatePolicy(policy(this.settingsService));
      }
    });
  }

  onApplicationBootstrap(): void {
    this.currentPassword.updatePolicy(policy(this.settingsService));
  }
}
