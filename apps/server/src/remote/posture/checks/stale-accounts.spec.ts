// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/checks/stale-accounts.spec.ts
import { describe, expect, it } from "vitest";
import { gradeStaleAccounts } from "./stale-accounts.js";

describe("gradeStaleAccounts (R7 staleAccounts)", () => {
  it("passes when the count is zero", () => {
    const outcome = gradeStaleAccounts(0);
    expect(outcome.grade).toBe("pass");
  });

  it("warns (not fail — hygiene nudge, not an active breach) with the count in the detail", () => {
    const outcome = gradeStaleAccounts(3);
    expect(outcome.grade).toBe("warn");
    expect(outcome.detail).toContain("3");
  });

  // FALSE-GREEN HUNT: `must_change_password` is a PROXY for "lacks a
  // password of their own" (users.password_hash is NOT NULL always in this
  // schema — there is no literal passwordless state to detect). A count of
  // 0 can never distinguish "every account genuinely chose its own
  // password" from "every account happens to be on a WEAK password it
  // chose itself" — this check only ever measures the admin-issued-temp-
  // password signal, never password strength. Documented, not silently
  // assumed: a caller must not read `pass` here as "every password is
  // strong", only as "no account is still on an unreplaced admin/CLI
  // temp password and every account has logged in at least once".
  it("BLIND SPOT — a pass grade says nothing about password STRENGTH, only about the temp-password/never-logged-in proxy", () => {
    const outcome = gradeStaleAccounts(0);
    expect(outcome.detail).not.toMatch(/strong|strength/i);
  });
});
