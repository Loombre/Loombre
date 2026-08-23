// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/mobile-header.ts
//
// Pure route -> mobile-header-state resolver (Wave 1 W1a, README "Mobile" —
// "a large-title header (31px, -.02em) with subtitle, a back chevron with
// contextual label"). Kept as a standalone pure function (no hooks) so it
// is unit-testable the same way nav-items.ts's predicates are, and so
// MobileHeader.tsx stays a thin render of whatever this returns.
//
// Two modes, matching the iOS large-title-vs-back-button pattern the
// README describes:
//   - "title": the current route IS one of the mobile tab bar's own tabs
//     (or Browse-without-a-shortcut) — show the large title (+ optional
//     subtitle), no back control.
//   - "back": the route is a level BELOW a tab (item detail, admin/*) —
//     show a back chevron whose LABEL names the owning tab it pops to
//     (README "back chevron on mobile pops detail -> tab"), not simply
//     "Back". This is the shell-chrome-level control; in-page back links
//     that already exist (episode -> series, track -> album, in
//     app/items/[itemType]/[id]/page.tsx) are unrelated and untouched —
//     this chevron always resolves to the TAB the detail page hangs off
//     of, however many levels deep the in-page nav went.
//
// Subtitle is deliberately left unset everywhere below: the README doesn't
// specify subtitle COPY in prose (only that a subtitle slot exists), and
// the prototype's own subtitle text is fixture content (U9 forbids
// shipping fixture strings) — MobileHeaderState.subtitle stays a real,
// wired field so a later lane can set one once it has real per-screen data
// (e.g. a result count), but inventing text now to fill the slot would be
// exactly the fixture-string mistake U9 exists to catch. Logged in this
// lane's freeze report as a deliberate deferral, not an oversight.
//
// browser-shell-browse-F5 (2026-08-20/21 QA): /watchlist and /people/[id]
// (README route table: both NEW, landed with W2 L3) used to fall through
// to the generic Home-back default below with this comment claiming
// "there is nothing routable to map them to today" — stale the moment W2
// L3 actually landed both routes. Watchlist has its own LIBRARY_NAV_ITEMS
// entry (nav-items.ts) and is reached straight from the sidebar, same
// "top-level destination, not one level below anything" shape /profile
// already gets title-mode for — titled below rather than backed. Person
// detail has no owning tab (same as artist/album/track under
// ITEM_DETAIL_RE — Home is the least-wrong back target for all of them);
// unlike those, it isn't under /items/ at all, so it needs its own
// pathname check rather than falling inside ITEM_DETAIL_RE. Neither gets a
// LIT tab either way — mobile's 6-tab bar (tab-items.ts) has no Watchlist
// or Person slot, so "no tab lit" on these two routes is correct, not part
// of this fix; only the empty TITLE was the actual defect.
//
// Wave 2 lane L1 (Settings IA): every `/settings/<key>` drill-down route
// (section-registry.ts) maps back to the owning "Settings" tab, titled
// with that section's own label — the exact same "back chevron pops to
// the owning tab" shape /admin/system used pre-IA. This REPLACED the former
// dedicated `/admin/settings` -> "Advanced Server" special case (that page
// is now a redirect stub to /settings/advanced; the real "Advanced Server"
// content lives at /settings/advanced and is covered by this new branch
// instead) — /admin/settings itself falls through to the generic /admin/*
// default below for the brief instant before its redirect fires, same as
// any other unmapped /admin/* route.
//
// D-5 (Wave 2, this run): /admin/system merged into the Dashboard
// (app/admin/page.tsx now absorbs everything that page had) and became a
// redirect-only stub — its dedicated "System" mobile-header case is REMOVED
// below; that pathname now falls through to the same generic /admin/*
// "Dashboard" label every other redirect stub under /admin/* already gets,
// for the brief instant before its own redirect fires.
//
// D-6 (Wave 2, this run — IA restructure): a NEW `/profile` title-mode case
// below, for the route every user's self-service settings moved to
// (components/profile/ProfileSettings.tsx) — section-registry.ts's
// SETTINGS_SECTIONS no longer has an "account" key, so `/settings/account`
// (now a redirect-only stub to /profile, same posture as the /admin/*
// stubs above) no longer matches the settingsSection branch either; it
// falls through to the generic unmapped-route case at the bottom for the
// brief instant before its own redirect fires.
//
// LD-8 (owner directive, Settings-Plugins consolidation): a NEW
// `/settings/plugins/<id>` case, one level BELOW the "plugins" tab (a
// plugin detail, not a section — same "item detail hangs off its owning
// tab" shape the ITEM_DETAIL_RE cases below already use) — this route
// doesn't match the settingsSection branch above (that's an exact-href
// match, and this pathname carries a trailing id), so without its own
// case it would fall all the way through to the generic Home-back default
// at the bottom. Checked BEFORE the settingsSection branch's exact match
// so a bare `/settings/plugins` still resolves there unaffected.

import { SETTINGS_SECTIONS } from "../settings/section-registry.js";

export interface MobileHeaderState {
  // "zone-back" (Wave 2, lane L8): /restricted's own back chevron
  // (README "the Restricted tab opens the zone as an overlay view on
  // whatever tab is active [...] back chevron returns"). Distinct from
  // plain "back": every other "back" case above has a STRUCTURALLY fixed
  // owning tab (a movie's detail always pops to Movies) this pure function
  // can compute from pathname/library-id context alone; the zone's
  // "whatever tab was active" target is genuinely dynamic (session
  // history), which a pure pathname resolver has no way to know — so
  // MobileHeader.tsx renders THIS mode with router.back() instead of a
  // static Link href, rather than this function guessing a fixed
  // destination that would often be wrong.
  mode: "title" | "back" | "zone-back";
  title: string;
  subtitle?: string;
  backLabel?: string;
  backHref?: string;
}

const ITEM_DETAIL_RE = /^\/items\/([^/]+)\//;

export function resolveMobileHeader(
  pathname: string,
  moviesLibraryId: string | null,
  tvLibraryId: string | null,
  activeLibraryId: string | null,
): MobileHeaderState {
  if (pathname === "/home") {
    return { mode: "title", title: "Home" };
  }

  if (pathname.startsWith("/search")) {
    return { mode: "title", title: "Search" };
  }

  if (pathname === "/settings") {
    return { mode: "title", title: "System Settings" };
  }

  // D-6: every user's own Profile/Password/Playback/Restricted settings —
  // reached from the avatar menu, not a tab, but still a top-level
  // destination in its own right (not "one level below" anything), so it
  // gets the same title-mode treatment as /home, /search, and /settings
  // above rather than a back chevron to a tab it doesn't belong to.
  if (pathname === "/profile") {
    return { mode: "title", title: "Profile" };
  }

  // browser-shell-browse-F5: Watchlist is a top-level LIBRARY_NAV_ITEMS
  // destination (nav-items.ts), reached straight from the sidebar — same
  // "not one level below anything" shape as /profile above, not a detail
  // page that pops back to an owning tab.
  if (pathname === "/watchlist") {
    return { mode: "title", title: "Watchlist" };
  }

  if (pathname.startsWith("/restricted")) {
    return { mode: "zone-back", title: "Restricted", backLabel: "Back" };
  }

  if (pathname.startsWith("/settings/plugins/")) {
    return { mode: "back", title: "Plugin", backLabel: "Plugins", backHref: "/settings/plugins" };
  }

  const settingsSection = SETTINGS_SECTIONS.find((s) => s.href === pathname);
  if (settingsSection) {
    return { mode: "back", title: settingsSection.label, backLabel: "System Settings", backHref: "/settings" };
  }

  if (pathname === "/browse") {
    // README "The header large-title reads Movies / TV Shows to match the
    // active library" — same shortcut match the tab bar / sidebar use.
    if (moviesLibraryId !== null && activeLibraryId === moviesLibraryId) {
      return { mode: "title", title: "Movies" };
    }
    if (tvLibraryId !== null && activeLibraryId === tvLibraryId) {
      return { mode: "title", title: "TV Shows" };
    }
    return { mode: "title", title: "Browse" };
  }

  if (pathname.startsWith("/admin")) {
    // Admin has no owning mobile tab (the 6-tab design has no Dashboard
    // tab) — Settings is the least-wrong "owning tab" for whatever's left
    // under /admin/* once the settings hub took Libraries/Users/Plugins/
    // Advanced (the settingsSection branch above). /admin itself
    // (Dashboard) and every /admin/* redirect-only stub (/admin/system,
    // /admin/settings, /admin/users, /admin/libraries — briefly rendered
    // before their client-side redirect fires) all fall through to this
    // one generic label; /admin/system lost its dedicated "System" case in
    // D-5 (Wave 2, this run) when that page merged into the Dashboard.
    return { mode: "back", title: "Dashboard", backLabel: "System Settings", backHref: "/settings" };
  }

  const itemMatch = ITEM_DETAIL_RE.exec(pathname);
  if (itemMatch) {
    const kind = itemMatch[1];
    if (kind === "movie") {
      return {
        mode: "back",
        title: "Movie",
        backLabel: "Movies",
        backHref: moviesLibraryId ? `/browse?library=${moviesLibraryId}` : "/browse",
      };
    }
    if (kind === "series" || kind === "episode") {
      return {
        mode: "back",
        title: kind === "series" ? "Series" : "Episode",
        backLabel: "TV Shows",
        backHref: tvLibraryId ? `/browse?library=${tvLibraryId}` : "/browse",
      };
    }
    if (kind === "artist" || kind === "album" || kind === "track") {
      // No dedicated Music tab (README: reached via Home's album rail / the
      // now-playing bar) — Home is the owning tab.
      const title = kind.charAt(0).toUpperCase() + kind.slice(1);
      return { mode: "back", title, backLabel: "Home", backHref: "/home" };
    }
  }

  // browser-shell-browse-F5: person detail — same "no dedicated tab, Home
  // is the least-wrong back target" shape as artist/album/track just
  // above, but reached at /people/<id> rather than /items/person/<id>, so
  // it needs its own check outside ITEM_DETAIL_RE.
  if (pathname.startsWith("/people/")) {
    return { mode: "back", title: "Person", backLabel: "Home", backHref: "/home" };
  }

  // Unmapped route (a NEW screen with no owning lane yet, or anything this
  // resolver doesn't recognize) — generic back-to-Home rather than a dead
  // chevron.
  return { mode: "back", title: "", backLabel: "Home", backHref: "/home" };
}
