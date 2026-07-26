// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/tab-items.ts
//
// Mobile bottom tab bar config (Wave 1 W1a, README "Mobile" — "A 6-tab
// bottom bar — Home, Movies, TV Shows, Search, Restricted, Settings").
// Data, not JSX, mirroring nav-items.ts's own pattern exactly so the
// Restricted tab (README screen table: /restricted is NEW, lands with
// W2 L8 per STATE.md's wave-plan gap closure) is a new array entry when
// its route exists, not surgery on MobileTabBar.tsx's render logic.
//
// Movies/TV Shows are the SAME /browse?library=<id> shortcuts the sidebar
// uses — isBrowseWithLibrary and resolveShortcutHref are imported from
// nav-items.ts rather than re-derived here (this lane's brief: "reuse
// nav-items data; do not duplicate the library-id resolution").
//
// "Exactly one tab lit at a time" (README "Interactions... Restricted
// zone"): while the /restricted overlay is open on top of whatever tab was
// active, every OTHER tab's lit state must suppress. TabActiveContext adds
// `zoneOverlayOpen` for exactly this — always `false` today (no zone, no
// overlay, nothing can suppress), and every isActive check below already
// ANDs against it, so W2 L8 wires a real boolean through and the Restricted
// tab's own isActive (which is the mirror: lit ONLY while the overlay is
// open) without touching any predicate here.

import type { PhosphorIconName } from "../icon/phosphor-paths.js";
import { isBrowseWithLibrary, type NavActiveContext } from "./nav-items.js";

export interface TabActiveContext extends NavActiveContext {
  /** True while the Restricted zone renders as a full-screen overlay atop
   *  the current tab (W2 L8 wires this from RestrictedProvider/zone state;
   *  the zone doesn't exist yet, so this is always false until then). */
  zoneOverlayOpen: boolean;
}

export interface TabItemConfig {
  key: string;
  label: string;
  /** Wave 2 L7 (U7): all 5 shipped tabs have a Phosphor custom-glyph match
   *  (the tab bar's own 5-of-8 subset — see components/icon/phosphor-paths.ts). */
  icon: PhosphorIconName;
  href: string;
  isActive: (ctx: TabActiveContext) => boolean;
}

// W2 L8: the Restricted tab's slot is filled in below (icon Lock — lucide,
// same posture as every other tab's icon today; U7's custom glyph set is
// W2 L7's own scope and swaps this import later with no shape change
// here). Order matches the README's literal tab order.
export const TAB_ITEMS: TabItemConfig[] = [
  {
    key: "home",
    label: "Home",
    icon: "home",
    href: "/home",
    isActive: (ctx) => ctx.pathname === "/home" && !ctx.zoneOverlayOpen,
  },
  {
    key: "movies",
    label: "Movies",
    icon: "film",
    href: "/browse",
    isActive: (ctx) => isBrowseWithLibrary(ctx, ctx.moviesLibraryId) && !ctx.zoneOverlayOpen,
  },
  {
    key: "tv",
    label: "TV Shows",
    icon: "tv",
    href: "/browse",
    isActive: (ctx) => isBrowseWithLibrary(ctx, ctx.tvLibraryId) && !ctx.zoneOverlayOpen,
  },
  {
    key: "search",
    label: "Search",
    icon: "search",
    href: "/search",
    isActive: (ctx) => ctx.pathname.startsWith("/search") && !ctx.zoneOverlayOpen,
  },
  {
    key: "restricted",
    label: "Restricted",
    icon: "lock", // Phosphor custom glyph (W2 L7) — landing reconciliation of L8's lucide Lock
    href: "/restricted",
    // The mirror of every other tab's predicate above: lit ONLY while the
    // zone overlay is open (never suppressed by itself — there is no
    // "&& !ctx.zoneOverlayOpen" here on purpose).
    isActive: (ctx) => ctx.zoneOverlayOpen,
  },
  {
    key: "settings",
    label: "Settings",
    icon: "settings",
    href: "/settings",
    isActive: (ctx) => ctx.pathname === "/settings" && !ctx.zoneOverlayOpen,
  },
];
