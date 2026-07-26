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
 *  Settings-label-dedupe RESOLVED (W2 L1, settings-IA unification): the
 *  W1a-era collision — this entry's "Settings" (-> /settings) alongside the
 *  SYSTEM group's OWN "Settings" (-> /admin/settings, the admin registry)
 *  rendering side by side for every admin — dissolved naturally once
 *  /settings became the ONE unified Settings surface for both audiences
 *  (components/settings/SettingsShell.tsx: non-admins see their existing
 *  profile/restricted-PIN/playback-prefs content unchanged; admins get the
 *  full 8-tab admin surface — Server/Libraries/Users & Profiles/Playback/
 *  Remote Access/Plugins/Advanced Server/About — behind the SAME entry).
 *  The SYSTEM group's former "admin-settings" nav item is REMOVED below —
 *  see that group's own comment. This is now the only "Settings" label in
 *  the sidebar, for every user, admin or not. */
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
  {
    key: "settings",
    label: "Settings",
    icon: "settings",
    href: "/settings",
    isActive: (ctx) => ctx.pathname === "/settings",
  },
];

/** SYSTEM group — admin-only (matches app/admin/layout.tsx's own
 *  isAdmin-gated redirect; this is the UX mirror, not the security
 *  boundary, same posture the former NavRail's isAdmin prop already had).
 *  "Dashboard" -> /admin, which used to redirect straight to /admin/jobs
 *  (pre-Phosphor-Wave-2) — /admin now renders the real Phosphor admin
 *  dashboard itself (app/admin/page.tsx: health cards, active streams,
 *  libraries + Fix Match, job queue, event log). AdminNav's remaining
 *  sections stay reachable alongside its new "Dashboard" tab.
 *
 *  Settings-IA unification (W2 L1): the former "admin-settings" entry here
 *  (-> /admin/settings, the schema-driven registry) is REMOVED — that
 *  content, plus Libraries and Users management (formerly their own
 *  AdminNav sections), moved to /settings/advanced, /settings/libraries,
 *  and /settings/users respectively (components/settings/SettingsShell.tsx;
 *  /admin/settings, /admin/libraries, /admin/users are now thin
 *  redirect-only stubs to those new homes — the OLD URLs still work). The
 *  LIBRARY group's own "Settings" entry above is now the ONE place every
 *  user, admin or not, reaches Settings from — see that entry's comment. */
export const SYSTEM_NAV_ITEMS: NavItemConfig[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    icon: "dashboard",
    href: "/admin",
    isActive: (ctx) => ctx.pathname.startsWith("/admin") && !ctx.pathname.startsWith("/admin/system"),
  },
  {
    key: "system",
    label: "System",
    icon: "cpu",
    href: "/admin/system",
    isActive: (ctx) => ctx.pathname.startsWith("/admin/system"),
  },
];
