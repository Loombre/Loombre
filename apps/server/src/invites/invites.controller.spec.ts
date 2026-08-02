// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/invites/invites.controller.spec.ts
//
// Pure-function unit test for composeClaimUrl (M9) — the non-null
// composition branch this worktree's always-null MailConfigService stub
// can never itself produce live (see mail-config.service.ts's header).
// apps/server/test/invites.e2e.spec.ts exercises the null branch (and,
// via a spied MailConfigService, the non-null branch too) end to end over
// real HTTP; this file is the fast, dependency-free proof of the
// composition rule itself.

import { describe, expect, it } from "vitest";
import { composeClaimUrl } from "./invites.controller.js";

describe("composeClaimUrl (M9)", () => {
  it("returns null when publicUrl is null", () => {
    expect(composeClaimUrl(null, "raw-token-value")).toBeNull();
  });

  it("composes `${publicUrl}/claim/${token}` when publicUrl is set", () => {
    expect(composeClaimUrl("https://loombre.example", "raw-token-value")).toBe(
      "https://loombre.example/claim/raw-token-value",
    );
  });

  it("does not add or strip a trailing slash — publicUrl is stored without one (M9 registry convention)", () => {
    expect(composeClaimUrl("https://loombre.example", "tok")).toBe("https://loombre.example/claim/tok");
  });
});
