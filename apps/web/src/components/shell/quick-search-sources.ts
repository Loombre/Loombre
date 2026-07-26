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
// tab-items.ts's shipped set + AdminNav.tsx's seven sections) — no
// Watchlist/Restricted/Person entries yet (their routes don't exist,
// STATE.md kickoff ground truth; W2 L3/L8 land them, and can append here
// without touching QuickSearch.tsx's render logic). Admin screens are
// gated by the SAME isAdmin the shell already threads to Sidebar/AdminNav,
// not a new capability check invented for this file.
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
}

export interface PaletteAction {
  key: string;
  label: string;
  onSelect: () => void;
}

export const PALETTE_SCREENS: PaletteScreen[] = [
  { key: "home", label: "Home", href: "/home" },
  { key: "browse", label: "Browse", href: "/browse" },
  { key: "search", label: "Search", href: "/search" },
  { key: "settings", label: "Settings", href: "/settings" },
  { key: "admin-dashboard", label: "Dashboard", href: "/admin", adminOnly: true },
  { key: "admin-jobs", label: "Jobs", href: "/admin/jobs", adminOnly: true },
  { key: "admin-sessions", label: "Sessions", href: "/admin/sessions", adminOnly: true },
  { key: "admin-libraries", label: "Libraries", href: "/admin/libraries", adminOnly: true },
  { key: "admin-users", label: "Users", href: "/admin/users", adminOnly: true },
  { key: "admin-plugins", label: "Plugins", href: "/admin/plugins", adminOnly: true },
  { key: "admin-system", label: "System", href: "/admin/system", adminOnly: true },
  { key: "admin-settings", label: "Admin Settings", href: "/admin/settings", adminOnly: true },
];

/** Combined cap across screens+actions (mirrors the prototype's own
 *  buildPal() slicing its rows to a small fixed count) — this is instant,
 *  local-only matching, so nothing here needs pagination, just a sane
 *  render ceiling next to the catalog SearchPanel results below it. */
export const PALETTE_RESULT_LIMIT = 6;

function matches(label: string, query: string): boolean {
  return label.toLowerCase().includes(query);
}

export function filterPaletteScreens(query: string, isAdmin: boolean): PaletteScreen[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return PALETTE_SCREENS.filter((screen) => (!screen.adminOnly || isAdmin) && matches(screen.label, q));
}

export function filterPaletteActions(query: string, actions: PaletteAction[]): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return actions.filter((action) => matches(action.label, q));
}
