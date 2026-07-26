// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/restricted-zone-count.test.ts
//
// hasRestrictedZoneEntitlement is THE single predicate every zone entry
// point (Sidebar's RestrictedNavEntry, MobileTabBar's Restricted-tab
// filter, RestrictedZoneBrowseChip, UserMenu's Restricted zone row, and
// app/restricted/page.tsx's own not-entitled redirect) renders behind — see
// that function's own doc comment. This is deliberately a pure-logic test
// (this codebase's established pattern for React-hook-adjacent code — see
// lib/playback-session.test.ts's header for why there's no vi.mock/
// component-render harness here): proving THIS predicate is false exactly
// when the count hook reports null is the proof that "restricted-profile
// users see no zone entry/tab/chip/PIN affordance anywhere" (SCOPE item 5)
// — every one of those surfaces is a thin, otherwise-untested render of
// this same boolean.

import { describe, expect, it } from "vitest";
import { hasRestrictedZoneEntitlement } from "./restricted-zone-count.js";

describe("hasRestrictedZoneEntitlement", () => {
  it("false for null — covers BOTH still-loading and no-entitlement-at-all (404), on purpose (see the hook's own doc comment: the caller cannot and must not try to distinguish these)", () => {
    expect(hasRestrictedZoneEntitlement(null)).toBe(false);
  });

  it("true for any real count, including zero — an empty-but-entitled zone still shows its entry point", () => {
    expect(hasRestrictedZoneEntitlement(0)).toBe(true);
    expect(hasRestrictedZoneEntitlement(1)).toBe(true);
    expect(hasRestrictedZoneEntitlement(4)).toBe(true);
    expect(hasRestrictedZoneEntitlement(50_000)).toBe(true);
  });
});
