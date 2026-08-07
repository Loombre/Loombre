// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { resolveTabItem, TAB_ITEMS, type TabActiveContext } from "./tab-items.js";

const MOVIES_ID = "11111111-1111-1111-1111-111111111111";
const TV_ID = "22222222-2222-2222-2222-222222222222";

function ctx(overrides: Partial<TabActiveContext>): TabActiveContext {
  return {
    pathname: "/home",
    activeLibraryId: null,
    moviesLibraryId: MOVIES_ID,
    tvLibraryId: TV_ID,
    zoneOverlayOpen: false,
    ...overrides,
  };
}

describe("TAB_ITEMS", () => {
  it("ships all 6 README tabs, Restricted included (Wave 2, lane L8)", () => {
    expect(TAB_ITEMS.map((t) => t.key)).toEqual(["home", "movies", "tv", "search", "restricted", "settings"]);
  });

  it("lights exactly one tab for each of its own routes", () => {
    const cases: Array<[TabActiveContext, string]> = [
      [ctx({ pathname: "/home" }), "home"],
      [ctx({ pathname: "/browse", activeLibraryId: MOVIES_ID }), "movies"],
      [ctx({ pathname: "/browse", activeLibraryId: TV_ID }), "tv"],
      [ctx({ pathname: "/search" }), "search"],
      [ctx({ pathname: "/settings" }), "settings"],
    ];

    for (const [c, expectedKey] of cases) {
      const active = TAB_ITEMS.filter((t) => t.isActive(c)).map((t) => t.key);
      expect(active).toEqual([expectedKey]);
    }
  });

  it("lights no tab on /browse when neither shortcut library is active", () => {
    const active = TAB_ITEMS.filter((t) => t.isActive(ctx({ pathname: "/browse", activeLibraryId: "other" })));
    expect(active).toEqual([]);
  });

  it("suppresses every tab's active state while the zone overlay is open (README 'exactly one tab lit at a time'), EXCEPT the Restricted tab itself", () => {
    const withZoneOpen = ctx({ pathname: "/home", zoneOverlayOpen: true });
    const active = TAB_ITEMS.filter((t) => t.isActive(withZoneOpen)).map((t) => t.key);
    expect(active).toEqual(["restricted"]);
  });

  it("Restricted tab is dark while the zone overlay is closed, regardless of pathname", () => {
    const active = TAB_ITEMS.find((t) => t.key === "restricted")!;
    expect(active.isActive(ctx({ pathname: "/restricted", zoneOverlayOpen: false }))).toBe(false);
    expect(active.isActive(ctx({ pathname: "/home", zoneOverlayOpen: false }))).toBe(false);
  });
});

describe("resolveTabItem (W3-R, D-6 role-aware settings slot)", () => {
  const settingsItem = TAB_ITEMS.find((t) => t.key === "settings")!;

  it("keeps the Settings label and /settings href for an admin", () => {
    expect(resolveTabItem(settingsItem, true)).toEqual({ label: "Settings", href: "/settings" });
  });

  it("swaps to Profile -> /profile for a non-admin", () => {
    expect(resolveTabItem(settingsItem, false)).toEqual({ label: "Profile", href: "/profile" });
  });

  it("leaves every other tab's label/href untouched regardless of admin status", () => {
    for (const item of TAB_ITEMS) {
      if (item.key === "settings") continue;
      expect(resolveTabItem(item, true)).toEqual({ label: item.label, href: item.href });
      expect(resolveTabItem(item, false)).toEqual({ label: item.label, href: item.href });
    }
  });
});
