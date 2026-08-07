// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/nav-items.ts
//
// Phosphor sidebar nav config (Wave 0, README "Suggested implementation
// order" step 2). Data, not JSX: adding Watchlist/Restricted in Wave 2
// (STATE.md kickoff ground truth — both routes don't exist yet, deferred
// with them) is pushing two more entries into LIBRARY_ITEMS, not touching
// Sidebar.tsx's render logic or isActive plumbing.
//
// Watchlist entry: WIRED (Wave 2, lane L3 — /watchlist route). Placed
// between Search and Settings, matching the README shell spec's LIBRARY
// group order ("Home, Browse, Movies + count, TV Shows + count, Watchlist +
// count, Restricted + PIN badge/count, Search"); Restricted itself is
// lane L8's scope, not added here. The count is threaded as a prop exactly
// like moviesItemCount/tvItemCount (see Sidebar.tsx) — DERIVED from a
// bounded GET /watchlist page (packages/contract has no dedicated
// aggregate-count endpoint for this list, unlike restricted/count's
// purpose-built RestrictedCount; see lib/watchlist-sync.ts's header for why
// a bounded page is the honest "derived, not stored" choice here).
//
// Movies/TV Shows are library SHORTCUTS, not routes of their own (README
// "Movies and TV Shows are library shortcuts, not separate routes — both
// open /browse with the library filter preset"). Ground-truthed against
// app/browse/page.tsx: the ONLY real filter the contract supports is
// `?library=<libraryId>` (a specific library row's id) — there is no
// aggregate "All libraries" or media-kind-level filter server-side, so
// "Movies"/"TV Shows" resolve to whichever library is mediaKind
// "movie"/"tv" AND contentClass "general" (excluding the seeded
// "Restricted" library, which is also mediaKind "movie" but
// contentClass "restricted" — that one is Wave 2's /restricted zone, not
// a Browse shortcut). Browse's own nav item lights for anything that
// ISN'T the movies/tv shortcut (i.e. music, or no library resolved yet).
//
// Item counts: WIRED (Wave 1c, "contract enablers" lane — this comment
// previously logged the deferral; that lane landed the additive
// Library.itemCount field, see Sidebar.tsx). No change needed here: this
// file is nav CONFIG (labels/icons/hrefs/isActive), not data — counts are
// resolved and rendered entirely in Sidebar.tsx off the same GET
// /libraries response it already fetches.

import type { LucideIcon } from "lucide-react";
import { Bookmark } from "lucide-react";
import type { PhosphorIconName } from "../icon/phosphor-paths.js";

export interface NavActiveContext {
  pathname: string;
  /** The `?library=` value on the current URL, only meaningful on /browse. */
  activeLibraryId: string | null;
  /** First general-content-class library of mediaKind "movie"/"tv", or
   *  null while GET /libraries hasn't resolved yet or none exists. */
  moviesLibraryId: string | null;
  tvLibraryId: string | null;
}

export interface NavItemConfig {
  key: string;
  label: string;
  /** Wave 2 L7 (U7): custom Phosphor glyph names (components/icon/
   *  phosphor-paths.ts) wherever the prototype draws one. The lone lucide
   *  exception is Watchlist's Bookmark (L3) — the prototype has no
   *  bookmark glyph in the extracted set, and U7's own rule is "lucide
   *  remains only where the prototype has no custom glyph". */
  icon: PhosphorIconName | LucideIcon;
  href: string;
  isActive: (ctx: NavActiveContext) => boolean;
}

// Exported (Wave 1, W1a): the mobile bottom tab bar's Movies/TV Shows tabs
// are the exact same library shortcuts as the sidebar's — this predicate
// and resolveShortcutHref below are the single shared implementation both
// consume (see tab-items.ts's header — "reuse nav-items data; do not
// duplicate the library-id resolution").
export const isBrowseWithLibrary = (ctx: NavActiveContext, libraryId: string | null): boolean =>
  libraryId !== null && ctx.pathname === "/browse" && ctx.activeLibraryId === libraryId;

/** Resolves a nav/tab item's actual href, appending the resolved
 *  `?library=` query for the "movies"/"tv" shortcut keys once
 *  useLibraryShortcuts() has an id (falls back to the item's bare href —
 *  `/browse` with no filter — while libraries are still loading). Shared
 *  by Sidebar and MobileTabBar so the shortcut-resolution logic exists in
 *  exactly one place. */
export function resolveShortcutHref(
  item: { key: string; href: string },
  moviesLibraryId: string | null,
  tvLibraryId: string | null,
): string {
  if (item.key === "movies" && moviesLibraryId) return `/browse?library=${moviesLibraryId}`;
  if (item.key === "tv" && tvLibraryId) return `/browse?library=${tvLibraryId}`;
  return item.href;
}

/** LIBRARY group. Watchlist/Restricted land here in Wave 2 (kickoff ground
 *  truth: their routes don't exist yet — no dead links this wave).
 *
 *  Settings-IA restructure (W2 L1 -> W2 D-6, this wave): L1's unified
 *  "Settings" entry (below, formerly the ONE place every user reached
 *  Settings from — see git blame for that era's comment) is REMOVED here.
 *  D-6 splits it back into two audiences with two homes: server-scoped
 *  admin configuration (Server/Notices/Libraries/Users & Profiles/
 *  Playback/Remote Access/Plugins/Mail/Advanced Server/About) is
 *  "System Settings", admin-only, in the SYSTEM group below, right after
 *  Dashboard; user-scoped self-service (Profile, Password, per-user
 *  Playback preferences, Restricted opt-in) moved OUT to /profile, reached
 *  from the avatar menu (UserMenu.tsx's new "Profile settings" row), not
 *  the sidebar at all — every user, admin or not, gets there the same way.
 *  A non-admin therefore has no "Settings"-shaped entry anywhere in this
 *  sidebar anymore; that's intentional, not a gap (components/settings/
 *  SettingsShell.tsx now redirects any non-admin who lands on /settings*
 *  by URL straight to /profile). */
export const LIBRARY_NAV_ITEMS: NavItemConfig[] = [
  {
    key: "home",
    label: "Home",
    icon: "home",
    href: "/home",
    isActive: (ctx) => ctx.pathname === "/home",
  },
  {
    key: "browse",
    label: "Browse",
    icon: "browse",
    href: "/browse",
    isActive: (ctx) =>
      ctx.pathname === "/browse" &&
      !isBrowseWithLibrary(ctx, ctx.moviesLibraryId) &&
      !isBrowseWithLibrary(ctx, ctx.tvLibraryId),
  },
  {
    key: "movies",
    label: "Movies",
    icon: "film",
    href: "/browse", // dynamic ?library= appended by Sidebar once resolved
    isActive: (ctx) => isBrowseWithLibrary(ctx, ctx.moviesLibraryId),
  },
  {
    key: "tv",
    label: "TV Shows",
    icon: "tv",
    href: "/browse",
    isActive: (ctx) => isBrowseWithLibrary(ctx, ctx.tvLibraryId),
  },
  {
    key: "watchlist",
    label: "Watchlist",
    icon: Bookmark,
    href: "/watchlist",
    isActive: (ctx) => ctx.pathname === "/watchlist",
  },
  {
    key: "search",
    label: "Search",
    icon: "search",
    href: "/search",
    isActive: (ctx) => ctx.pathname.startsWith("/search"),
  },
];

/** SYSTEM group — admin-only (matches app/admin/layout.tsx's own
 *  isAdmin-gated redirect; this is the UX mirror, not the security
 *  boundary, same posture the former NavRail's isAdmin prop already had).
 *
 *  D-5 (this wave): "Dashboard" and the former "System" entry (-> the old
 *  /admin/system page) presented overlapping information — version/OS/
 *  tier/node/uptime facts, verified hardware capabilities, update notice,
 *  provider-key notice, crash files, and the log tail all now live on the
 *  merged /admin page itself (app/admin/page.tsx's own header), so
 *  "System" is REMOVED here rather than kept as a second, now-empty
 *  destination. /admin/system is a redirect-only stub back to /admin
 *  (app/admin/system/page.tsx), same pattern as the legacy /admin/settings
 *  stub below — old bookmarks still resolve, they just land on the one
 *  merged screen. isActive no longer needs to carve out "/admin/system" as
 *  an exception (there is nothing left under that prefix to except).
 *
 *  D-6 (this wave): "System Settings" is the former unified "Settings"
 *  entry, renamed and moved here from the LIBRARY group (see that group's
 *  own comment) — admin-only, right after Dashboard, matching D-6's
 *  literal placement requirement. It still points at /settings (bare) +
 *  /settings/<key> (components/settings/SettingsShell.tsx), now retaining
 *  ONLY the server-scoped sections (Server/Notices/Libraries/Users &
 *  Profiles/Playback/Remote Access/Plugins/Mail/Advanced Server/About) —
 *  the user-scoped "Account" section moved out to /profile, which is why
 *  this label is no longer plain "Settings" (that word alone, sitting
 *  under SYSTEM, would misleadingly suggest it's the ONE settings surface
 *  again, the exact ambiguity D-6 exists to remove). /admin/settings,
 *  /admin/libraries, /admin/users stay as their existing redirect-only
 *  stubs into this same surface — untouched by this wave. */
export const SYSTEM_NAV_ITEMS: NavItemConfig[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    icon: "dashboard",
    href: "/admin",
    isActive: (ctx) => ctx.pathname.startsWith("/admin"),
  },
  {
    key: "system-settings",
    label: "System Settings",
    icon: "settings",
    href: "/settings",
    isActive: (ctx) => ctx.pathname.startsWith("/settings"),
  },
];
