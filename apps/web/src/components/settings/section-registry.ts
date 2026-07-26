// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/section-registry.ts
//
// Wave 2 lane L1 (Phosphor Settings IA): the single source of truth for
// the unified Settings surface's section list — design/phosphor/README.md
// "Screens -> Desktop -> Settings" describes 8 admin tabs (Server,
// Libraries, Users & Profiles, Playback, Remote Access, Plugins, Advanced
// Server, About); this registry adds a 9th, "Account", which the prototype
// never draws because its owner-only persona (Maya Reyes) has no separate
// personal-settings concern — the real app has non-admin users too, and
// their existing profile/restricted-opt-in/playback-preference capability
// (apps/web/src/app/settings/page.tsx pre-Wave-2) needed a home in the new
// IA rather than being dropped. Logged in this lane's freeze report as a
// lane-decided addition, not a prototype tab.
//
// This file stays framework-free (no React) on purpose: mobile-header.ts
// (a pure, hook-free route resolver) imports SETTINGS_SECTIONS directly to
// title the mobile back-chevron chrome for every `/settings/<key>` drill-
// down route — see that file's new branch. Keeping this a plain data module
// is what makes that import safe.
//
// Route shape: "/settings" itself is the responsive hub/tab-list host
// (mobile: grouped list when no section is active; desktop: pill tabs +
// pane, defaulting to "account"). Every OTHER key gets its own real
// Next.js route under /settings/<key> — this is what lets the existing
// mobile-header.ts "back chevron pops to the owning tab" pattern (already
// used by /admin/system and, formerly, /admin/settings) apply uniformly:
// drilling into a hub row is real navigation with a real back target,
// exactly like every other admin sub-route already works, not a bespoke
// client-side overlay invented for this one screen.
//
// adminOnly gates both the hub row/tab AND the route itself (SettingsShell
// redirects a non-admin hitting an admin-only /settings/<key> URL back to
// bare /settings) — "account" is the only section a non-admin ever sees,
// matching every non-admin's existing capability exactly (zero regression,
// per this lane's brief: "map existing capability... WITHOUT breaking
// existing routes").

export type SettingsSectionKey =
  | "account"
  | "server"
  | "libraries"
  | "users"
  | "playback"
  | "remote-access"
  | "plugins"
  | "advanced"
  | "about";

export interface SettingsSectionConfig {
  key: SettingsSectionKey;
  /** Tab/hub-row label. Matches the README's literal tab names except
   *  "Account" (this lane's addition, see header) and "Advanced Server" /
   *  "Users & Profiles" (kept exactly as the README spells them). */
  label: string;
  /** Always a real route — bare "/settings" for the hub/default-tab host,
   *  "/settings/<key>" for every other section (see header). */
  href: string;
  adminOnly: boolean;
}

export const SETTINGS_SECTIONS: SettingsSectionConfig[] = [
  { key: "account", label: "Account", href: "/settings/account", adminOnly: false },
  { key: "server", label: "Server", href: "/settings/server", adminOnly: true },
  { key: "libraries", label: "Libraries", href: "/settings/libraries", adminOnly: true },
  { key: "users", label: "Users & Profiles", href: "/settings/users", adminOnly: true },
  { key: "playback", label: "Playback", href: "/settings/playback", adminOnly: true },
  { key: "remote-access", label: "Remote Access", href: "/settings/remote-access", adminOnly: true },
  { key: "plugins", label: "Plugins", href: "/settings/plugins", adminOnly: true },
  { key: "advanced", label: "Advanced Server", href: "/settings/advanced", adminOnly: true },
  { key: "about", label: "About", href: "/settings/about", adminOnly: true },
];

export function sectionByKey(key: string): SettingsSectionConfig | undefined {
  return SETTINGS_SECTIONS.find((s) => s.key === key);
}

export function sectionByHref(href: string): SettingsSectionConfig | undefined {
  return SETTINGS_SECTIONS.find((s) => s.href === href);
}

/** Tabs/hub rows visible to the current user — "account" always, everything
 *  else only for admins (see header). Preserves SETTINGS_SECTIONS' order. */
export function visibleSections(isAdmin: boolean): SettingsSectionConfig[] {
  return SETTINGS_SECTIONS.filter((s) => isAdmin || !s.adminOnly);
}
