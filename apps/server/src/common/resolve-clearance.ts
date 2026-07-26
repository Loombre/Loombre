// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/resolve-clearance.ts
//
// The five-gate model (docs/PLAN.md §6.4), collapsed to ONE pure,
// unit-tested function per the task spec. No I/O: every input is already
// resolved (from DB rows, env config, and the clock) by the caller
// (viewer-context.provider.ts). Restricted content leaves the server only
// when ALL FIVE gates pass:
//
//   1. Server capability   — LOOMBRE_RESTRICTED_ENABLED, off by default.
//   2. Age eligibility     — users.birth_date yields age >= majority (18,
//                             instance-configurable UPWARD only); no birth
//                             date = ineligible, never an admin override.
//   3. User opt-in         — user_settings.restricted_opt_in AND a PIN is
//                             set (both self-service only, docs/PLAN.md
//                             §6.4 gate 3 — no admin path).
//   4. Library permission  — an explicit library_permissions grant on a
//                             restricted library (default-deny).
//   5. Session unlock      — user_settings.restricted_unlocked_until_ms is
//                             set AND strictly in the future *right now*;
//                             re-verified server-side on every request,
//                             never trusted from the access-token claim.

export interface ClearanceInputs {
  /** Gate 1: instance admin has enabled the restricted-content capability. */
  capabilityEnabled: boolean;
  /** Gate 2: users.birth_date, `YYYY-MM-DD` or null (never set = ineligible). */
  birthDate: string | null;
  /** The request clock, epoch ms — every gate is evaluated against this. */
  nowMs: number;
  /** Instance majority-age floor in years (D13: hard floor 18, upward only). */
  majorityAgeYears: number;
  /** Gate 3a: user_settings.restricted_opt_in. */
  optIn: boolean;
  /** Gate 3b: user_settings.restricted_pin_hash is set. */
  hasPin: boolean;
  /** Gate 4: at least one library_permissions grant on a restricted library. */
  hasRestrictedLibraryPermission: boolean;
  /** Gate 5: user_settings.restricted_unlocked_until_ms, or null if never
   *  unlocked / already locked. */
  unlockedUntilMs: number | null;
}

export interface ClearanceGates {
  g1: boolean;
  g2: boolean;
  g3: boolean;
  g4: boolean;
  g5: boolean;
}

export interface ClearanceResult {
  gates: ClearanceGates;
  /** True iff EVERY gate in `gates` is true — the sole input the
   *  restricted-content query guard (packages/db) and the AuthGuard's
   *  advisory token claim are allowed to consult. */
  restrictedCleared: boolean;
}

/**
 * Whole years elapsed from `birthDateIso` (`YYYY-MM-DD`) to `nowMs`,
 * accounting for whether this year's birthday has been reached yet. Pure
 * date-component arithmetic — never constructs a `Date` from `birthDateIso`
 * with an implicit time zone (CLAUDE.md invariant 5: milliseconds/UTC
 * everywhere, no ambient-timezone surprises for a DATE-only column).
 */
export function computeAgeYears(birthDateIso: string, nowMs: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDateIso);
  if (!match) {
    throw new Error(`computeAgeYears: malformed date '${birthDateIso}', expected YYYY-MM-DD`);
  }
  const birthYear = Number(match[1]);
  const birthMonth = Number(match[2]); // 1-12
  const birthDay = Number(match[3]);

  const now = new Date(nowMs);
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1; // 1-12
  const nowDay = now.getUTCDate();

  let age = nowYear - birthYear;
  const birthdayReachedThisYear =
    nowMonth > birthMonth || (nowMonth === birthMonth && nowDay >= birthDay);
  if (!birthdayReachedThisYear) {
    age -= 1;
  }
  return age;
}

export function resolveClearance(inputs: ClearanceInputs): ClearanceResult {
  const g1 = inputs.capabilityEnabled;

  const g2 =
    inputs.birthDate !== null &&
    computeAgeYears(inputs.birthDate, inputs.nowMs) >= inputs.majorityAgeYears;

  const g3 = inputs.optIn && inputs.hasPin;

  const g4 = inputs.hasRestrictedLibraryPermission;

  const g5 = inputs.unlockedUntilMs !== null && inputs.unlockedUntilMs > inputs.nowMs;

  const gates: ClearanceGates = { g1, g2, g3, g4, g5 };
  const restrictedCleared = g1 && g2 && g3 && g4 && g5;

  return { gates, restrictedCleared };
}
