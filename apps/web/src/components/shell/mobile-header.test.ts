// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { resolveMobileHeader } from "./mobile-header.js";

const MOVIES_ID = "11111111-1111-1111-1111-111111111111";
const TV_ID = "22222222-2222-2222-2222-222222222222";

describe("resolveMobileHeader", () => {
  it("shows the Home large title with no back control", () => {
    expect(resolveMobileHeader("/home", null, null, null)).toEqual({ mode: "title", title: "Home" });
  });

  it("shows Search and Settings as title-mode tabs", () => {
    expect(resolveMobileHeader("/search", null, null, null)).toEqual({ mode: "title", title: "Search" });
    expect(resolveMobileHeader("/settings", null, null, null)).toEqual({ mode: "title", title: "Settings" });
  });

  it("titles /browse generically until a library shortcut resolves", () => {
    expect(resolveMobileHeader("/browse", null, null, null)).toEqual({ mode: "title", title: "Browse" });
  });

  it("retitles /browse to Movies / TV Shows to match the active library shortcut", () => {
    expect(resolveMobileHeader("/browse", MOVIES_ID, TV_ID, MOVIES_ID)).toEqual({ mode: "title", title: "Movies" });
    expect(resolveMobileHeader("/browse", MOVIES_ID, TV_ID, TV_ID)).toEqual({ mode: "title", title: "TV Shows" });
  });

  it("does not retitle /browse when the active library is neither shortcut", () => {
    expect(resolveMobileHeader("/browse", MOVIES_ID, TV_ID, "some-other-library")).toEqual({
      mode: "title",
      title: "Browse",
    });
  });

  it("Wave 2 (lane L8): /restricted resolves to zone-back mode (router.back(), not a fixed href)", () => {
    expect(resolveMobileHeader("/restricted", null, null, null)).toEqual({
      mode: "zone-back",
      title: "Restricted",
      backLabel: "Back",
    });
  });

  it("maps movie detail back to the Movies tab, with the resolved library id when known", () => {
    expect(resolveMobileHeader("/items/movie/abc", MOVIES_ID, TV_ID, null)).toEqual({
      mode: "back",
      title: "Movie",
      backLabel: "Movies",
      backHref: `/browse?library=${MOVIES_ID}`,
    });
  });

  it("falls back to plain /browse when the movies shortcut hasn't resolved yet", () => {
    expect(resolveMobileHeader("/items/movie/abc", null, null, null)).toEqual({
      mode: "back",
      title: "Movie",
      backLabel: "Movies",
      backHref: "/browse",
    });
  });

  it("maps series and episode detail back to the TV Shows tab", () => {
    expect(resolveMobileHeader("/items/series/abc", MOVIES_ID, TV_ID, null)).toEqual({
      mode: "back",
      title: "Series",
      backLabel: "TV Shows",
      backHref: `/browse?library=${TV_ID}`,
    });
    expect(resolveMobileHeader("/items/episode/abc", MOVIES_ID, TV_ID, null)).toEqual({
      mode: "back",
      title: "Episode",
      backLabel: "TV Shows",
      backHref: `/browse?library=${TV_ID}`,
    });
  });

  it("maps music entity detail (no dedicated tab) back to Home", () => {
    for (const kind of ["artist", "album", "track"]) {
      expect(resolveMobileHeader(`/items/${kind}/abc`, null, null, null)).toEqual({
        mode: "back",
        title: kind.charAt(0).toUpperCase() + kind.slice(1),
        backLabel: "Home",
        backHref: "/home",
      });
    }
  });

  it("maps remaining admin sub-routes back to Settings (System keeps its own screen; Dashboard/legacy redirect stubs get the generic label)", () => {
    expect(resolveMobileHeader("/admin", null, null, null)).toEqual({
      mode: "back",
      title: "Dashboard",
      backLabel: "Settings",
      backHref: "/settings",
    });
    expect(resolveMobileHeader("/admin/system", null, null, null)).toEqual({
      mode: "back",
      title: "System",
      backLabel: "Settings",
      backHref: "/settings",
    });
    // /admin/settings, /admin/users, /admin/libraries are now redirect-only
    // stubs (their content moved to /settings/<key>) — briefly rendered
    // before the client-side redirect fires, generic label same as /admin.
    expect(resolveMobileHeader("/admin/settings", null, null, null)).toEqual({
      mode: "back",
      title: "Dashboard",
      backLabel: "Settings",
      backHref: "/settings",
    });
  });

  it("titles every /settings/<key> drill-down route with that section's own label (section-registry.ts)", () => {
    expect(resolveMobileHeader("/settings/account", null, null, null)).toEqual({
      mode: "back",
      title: "Account",
      backLabel: "Settings",
      backHref: "/settings",
    });
    expect(resolveMobileHeader("/settings/libraries", null, null, null)).toEqual({
      mode: "back",
      title: "Libraries",
      backLabel: "Settings",
      backHref: "/settings",
    });
    expect(resolveMobileHeader("/settings/users", null, null, null)).toEqual({
      mode: "back",
      title: "Users & Profiles",
      backLabel: "Settings",
      backHref: "/settings",
    });
    expect(resolveMobileHeader("/settings/advanced", null, null, null)).toEqual({
      mode: "back",
      title: "Advanced Server",
      backLabel: "Settings",
      backHref: "/settings",
    });
  });

  it("falls back to a generic Home-back mapping for unmapped/NEW routes", () => {
    expect(resolveMobileHeader("/watchlist", null, null, null)).toEqual({
      mode: "back",
      title: "",
      backLabel: "Home",
      backHref: "/home",
    });
    expect(resolveMobileHeader("/people/abc", null, null, null)).toEqual({
      mode: "back",
      title: "",
      backLabel: "Home",
      backHref: "/home",
    });
  });
});
