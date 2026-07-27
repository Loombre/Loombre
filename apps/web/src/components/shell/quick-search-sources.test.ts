// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { PALETTE_SCREENS, filterPaletteActions, filterPaletteScreens } from "./quick-search-sources.js";

describe("filterPaletteScreens", () => {
  it("returns nothing for an empty/whitespace query", () => {
    expect(filterPaletteScreens("", true)).toEqual([]);
    expect(filterPaletteScreens("   ", true)).toEqual([]);
  });

  it("fuzzy (substring, case-insensitive) matches a screen label", () => {
    const matches = filterPaletteScreens("HoM", false);
    expect(matches.map((m) => m.key)).toEqual(["home"]);
  });

  it("excludes admin-only screens for a non-admin viewer", () => {
    const matches = filterPaletteScreens("settings", false);
    // "Settings" (personal, /settings) matches; "Admin Settings" is admin-only.
    expect(matches.map((m) => m.key)).toEqual(["settings"]);
  });

  it("includes admin-only screens for an admin viewer", () => {
    const matches = filterPaletteScreens("settings", true);
    expect(matches.map((m) => m.key).sort()).toEqual(["admin-settings", "settings"].sort());
  });

  it("every admin screen points at a real, existing /admin/* route", () => {
    const adminScreens = PALETTE_SCREENS.filter((s) => s.adminOnly);
    expect(adminScreens.length).toBeGreaterThan(0);
    for (const screen of adminScreens) {
      expect(screen.href.startsWith("/admin")).toBe(true);
    }
  });

  it("matches the Watchlist screen (W2 L3 landed /watchlist)", () => {
    const matches = filterPaletteScreens("watchlist", false);
    expect(matches).toEqual([{ key: "watchlist", label: "Watchlist", href: "/watchlist" }]);
  });

  it("hides the Restricted screen for a viewer with no zone entitlement, even as admin", () => {
    expect(filterPaletteScreens("restricted", false)).toEqual([]);
    expect(filterPaletteScreens("restricted", true)).toEqual([]);
    // Same fail-closed default when the entitlement flag isn't passed at all.
    expect(filterPaletteScreens("restricted", false, false)).toEqual([]);
  });

  it("matches the Restricted screen (W2 L8 landed /restricted) once the caller confirms zone entitlement", () => {
    const matches = filterPaletteScreens("restricted", false, true);
    expect(matches).toEqual([{ key: "restricted", label: "Restricted", href: "/restricted", restrictedOnly: true }]);
  });
});

describe("filterPaletteActions", () => {
  const actions = [
    { key: "lock-restricted", label: "Lock restricted content", onSelect: () => {} },
    { key: "sign-out", label: "Sign out", onSelect: () => {} },
  ];

  it("returns nothing for an empty query", () => {
    expect(filterPaletteActions("", actions)).toEqual([]);
  });

  it("fuzzy-matches an action label", () => {
    const matches = filterPaletteActions("sign", actions);
    expect(matches.map((a) => a.key)).toEqual(["sign-out"]);
  });

  it("matches mid-word substrings, not just prefixes", () => {
    const matches = filterPaletteActions("restrict", actions);
    expect(matches.map((a) => a.key)).toEqual(["lock-restricted"]);
  });
});
