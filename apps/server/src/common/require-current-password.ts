// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/require-current-password.ts
//
// G3 (STATE.md "Current-password re-auth on self-changes"): the shared
// re-auth check for PATCH /users/me (catalog/users.controller.ts's
// updateMe, when the body carries a `password` and/or `email` member) and
// PUT /users/me/restricted (session/users-me.controller.ts's putRestricted,
// ALWAYS). Lives in common/ for the same D2 cross-module reason as
// require-live-admin.ts — both controllers call this; neither may import
// the other's module (catalog and session only share IDs).
//
// Order, load-bearing (F1: "counted by the standing per-user rate
// limiter... a re-auth prompt must not become a password-guessing
// oracle"):
//   1. Presence/shape (422, free — no rate-limit budget spent on a
//      malformed request, target-agnostic detail per F2/G3).
//   2. Rate-limit attempt (429, BEFORE the compare — an attacker must pay
//      the limiter's price for every guess, not just every VALID-shaped
//      guess that reaches argon2id). A trip logs RATE_LIMITED ({user,
//      op:"current-password"}) — same anomaly-log posture every OTHER
//      rate limiter in this system already has (login/refresh/unlock).
//   3. argon2id compare against the caller's OWN stored password hash
//      (same HashService the login path uses; no dummy-hash constant-time
//      padding needed — this is an ALREADY-authenticated route, unlike
//      login's unauthenticated-identifier lookup). A mismatch logs
//      CURRENT_PASSWORD_FAILURE ({user: userId} only — PIN_FAILURE
//      precedent, restricted.controller.ts) and throws
//      CurrentPasswordInvalidException (403) — the SAME detail string
//      regardless of which endpoint or which target field prompted the
//      check (F2: E8 holds through this feature).
//
// A missing user row (should be unreachable — the caller is
// AuthGuard-authenticated against this exact userId) fails the compare
// rather than throwing separately, so this function's only two outcomes
// are "resolves" (proceed) or "throws" (422/429/403) — no third silent
// path a caller could forget to handle.

import { getUserById } from "@loombre/db";
import type { LoombreDb } from "./db.provider.js";
import type { HashService } from "./hash.service.js";
import type { AnomalyLogService } from "./anomaly-log.service.js";
import type { CurrentPasswordRateLimiterService } from "./current-password-rate-limiter.service.js";
import { unprocessableEntity } from "../gateway/problem.exception.js";
import { tooManyRequests } from "./rate-limit.exception.js";
import { CurrentPasswordInvalidException } from "../gateway/current-password-invalid.exception.js";

export interface RequireCurrentPasswordDeps {
  db: LoombreDb;
  userId: string;
  /** The raw `currentPassword` body member (unknown — not yet type-checked). */
  currentPasswordValue: unknown;
  instance: string;
  hashService: HashService;
  rateLimiter: CurrentPasswordRateLimiterService;
  anomalyLog: AnomalyLogService;
}

/** Resolves when re-authentication succeeds; throws (422/429/403) otherwise. */
export async function requireCurrentPassword(deps: RequireCurrentPasswordDeps): Promise<void> {
  const { db, userId, currentPasswordValue, instance, hashService, rateLimiter, anomalyLog } = deps;

  if (typeof currentPasswordValue !== "string" || currentPasswordValue.length === 0) {
    throw unprocessableEntity("currentPassword is required.", instance);
  }

  const limit = rateLimiter.currentPassword.attempt(userId);
  if (!limit.allowed) {
    anomalyLog.log("RATE_LIMITED", { user: userId, op: "current-password" });
    throw tooManyRequests("Too many current-password attempts. Try again later.", instance, limit.retryAfterMs);
  }

  const user = await getUserById(db, userId);
  const ok = user !== undefined && (await hashService.verify(user.password_hash, currentPasswordValue));
  if (!ok) {
    anomalyLog.log("CURRENT_PASSWORD_FAILURE", { user: userId });
    throw new CurrentPasswordInvalidException(instance);
  }
}
