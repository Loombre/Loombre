// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/stale-accounts.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7 staleAccounts, S1 lane). Pure
// grading function over a count; the impure "count them" half is
// packages/db/src/query/admin.ts's countStaleAccountsAdmin — see that
// function's own doc comment for the ground-truthed "never logged in" /
// "passwordless" definitions this schema actually supports (zero `devices`
// rows / `must_change_password`).
//
// FALSE-GREEN HUNT: this check can only see accounts that ALREADY exist in
// `users`. It has no way to know about an account an admin is mid-creating
// via the wizard/invite flow, and — because `must_change_password` is a
// proxy, not a literal "no password" state (every `users` row always has
// SOME password_hash) — an account whose temporary password happens to be
// weak-but-already-changed reads as clean even if the admin chose a weak
// replacement; this check only ever measures "still on the admin-issued
// one", not password strength. Warn (not fail): a stale account is a
// hygiene nudge, not an active breach in progress.

import type { PostureCheckOutcome } from "./types.js";

export function gradeStaleAccounts(staleCount: number): PostureCheckOutcome {
  if (staleCount <= 0) {
    return {
      grade: "pass",
      detail: "No account is stale — every account has logged in at least once and is not still on an admin-issued temporary password.",
    };
  }

  return {
    grade: "warn",
    detail: `${staleCount} account(s) have never logged in, or are still using an admin-issued temporary password they never replaced.`,
  };
}
