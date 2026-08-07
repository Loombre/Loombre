// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/quick-search-sources.ts
//
// Wave 2 L7 (⌘K polish, README "Interactions → Keyboard": "⌘K / Ctrl+K
// opens a command palette (fuzzy screen + action jump)"). Ground truth
// before writing this: QuickSearch.tsx today searches ONLY catalog items +
// people (GET /search + GET /people via SearchPanel) and has no ⌘K
// keybinding at all — the prototype's own palette (buildPal() in the
// bundle's support script) additionally lists static screens and a
// handful of admin actions, filtered by the same case-insensitive
// substring match GET /search itself doesn't do. This file is that
// static/instant half — screens filter with zero network round-trip, so
// they can render before the debounced catalog search even fires.
//
// Screens are every route that ACTUALLY EXISTS today (nav-items.ts +
// tab-items.ts's shipped set + AdminNav.tsx's sections). W2 L3/L8 have
// since landed Watchlist and Restricted — Watchlist is a plain screen entry
// now; Restricted is gated by the SAME hasRestrictedZoneEntitlement
// predicate (lib/restricted-zone-count.js) every other zone entry point
// renders behind (Sidebar's RestrictedNavEntry, the Browse chip, the
// mobile tab, UserMenu), via PaletteScreen.restrictedOnly +
// filterPaletteScreens' isRestrictedEntitled param — defaulted to false so
// a caller that hasn't threaded the real entitlement yet never leaks the
// zone's existence to an unentitled viewer. Still no Person entry (that
// route doesn't exist yet). Admin screens are gated by the SAME isAdmin
// the shell already threads to Sidebar/AdminNav, not a new capability
// check invented for this file.
//
// D-5/D-6 (Wave 2, this run — IA restructure): "admin-system" is REMOVED —
// /admin/system merged into the Dashboard (app/admin/page.tsx now absorbs
// everything that page had) and is a redirect-only stub, nothing left to
// palette-jump to that "Dashboard" doesn't already cover. "settings" is now
// admin-only (System Settings retains only server-scoped sections — see
// section-registry.ts's header) and relabeled to match the sidebar's own
// renamed entry (nav-items.ts); a NEW "profile" entry, visible to every
// user, covers the user-scoped self-service surface that moved OUT of
// Settings to /profile (components/profile/ProfileSettings.tsx).
//
// W3-R (opus review, LOW): "admin-settings" is ALSO removed — it pointed at
// /admin/settings, a redirect-only stub into this same "settings" entry's
// /settings destination, so the two rows were two palette jumps to the
// identical screen. "settings" (System Settings) is the one entry left.
//
// Actions are intentionally NOT the prototype's scan-trigger/fix-match
// set (those need per-library ids + duplicate app/admin/libraries/
// page.tsx's own scan-enqueue logic just to populate a palette) — kept to
// the two actions already available as a live hook/store call from
// anywhere in the shell tree (RestrictedProvider's lock()/
// openUnlockModal(), auth-store's logout()), mirroring the prototype's own
// user-menu items rather than duplicating admin business logic into a
// search box. Logged as a lane-decided scope boundary in the freeze
// report, not silently narrowed.

export interface PaletteScreen {
  key: string;
  label: string;
  href: string;
  adminOnly?: boolean;
  /** Gated the same way Sidebar's RestrictedNavEntry/Browse chip/mobile
   *  tab/UserMenu row are — see filterPaletteScreens' isRestrictedEntitled
   *  param. */
  restrictedOnly?: boolean;
}

export interface PaletteAction {
  key: string;
  label: string;
  onSelect: () => void;
}

export const PALETTE_SCREENS: PaletteScreen[] = [
  { key: "home", label: "Home", href: "/home" },
  { key: "browse", label: "Browse", href: "/browse" },
  { key: "watchlist", label: "Watchlist", href: "/watchlist" },
  { key: "restricted", label: "Restricted", href: "/restricted", restrictedOnly: true },
  { key: "search", label: "Search", href: "/search" },
  { key: "profile", label: "Profile settings", href: "/profile" },
  { key: "settings", label: "System Settings", href: "/settings", adminOnly: true },
  { key: "admin-dashboard", label: "Dashboard", href: "/admin", adminOnly: true },
  { key: "admin-jobs", label: "Jobs", href: "/admin/jobs", adminOnly: true },
  { key: "admin-sessions", label: "Sessions", href: "/admin/sessions", adminOnly: true },
  { key: "admin-libraries", label: "Libraries", href: "/admin/libraries", adminOnly: true },
  { key: "admin-users", label: "Users", href: "/admin/users", adminOnly: true },
  { key: "admin-plugins", label: "Plugins", href: "/admin/plugins", adminOnly: true },
];

/** Combined cap across screens+actions (mirrors the prototype's own
 *  buildPal() slicing its rows to a small fixed count) — this is instant,
 *  local-only matching, so nothing here needs pagination, just a sane
 *  render ceiling next to the catalog SearchPanel results below it. */
export const PALETTE_RESULT_LIMIT = 6;

function matches(label: string, query: string): boolean {
  return label.toLowerCase().includes(query);
}

/** `isRestrictedEntitled` defaults to false (rather than being required) so
 *  a call site that hasn't threaded the real hasRestrictedZoneEntitlement
 *  value yet fails closed — never shows the Restricted screen — instead of
 *  a type error forcing a guess. */
export function filterPaletteScreens(query: string, isAdmin: boolean, isRestrictedEntitled = false): PaletteScreen[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return PALETTE_SCREENS.filter(
    (screen) => (!screen.adminOnly || isAdmin) && (!screen.restrictedOnly || isRestrictedEntitled) && matches(screen.label, q),
  );
}

export function filterPaletteActions(query: string, actions: PaletteAction[]): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return actions.filter((action) => matches(action.label, q));
}
