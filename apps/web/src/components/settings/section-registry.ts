// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/section-registry.ts
//
// Wave 2 lane L1 (Phosphor Settings IA): the single source of truth for the
// System Settings surface's section list — design/phosphor/README.md
// "Screens -> Desktop -> Settings" describes 8 admin tabs (Server,
// Libraries, Users & Profiles, Playback, Remote Access, Plugins, Advanced
// Server, About).
//
// D-6 (Wave 2, this run — IA restructure): L1 originally added a 9th
// section here, "Account", for non-admin self-service content that had no
// other home. That section is GONE — every field it held (Profile, Password,
// per-user Playback preferences, Restricted opt-in/PIN) moved to its own
// route, /profile (components/profile/ProfileSettings.tsx), reached from the
// avatar menu rather than this tab list. SETTINGS_SECTIONS is therefore now
// ENTIRELY admin-only — see the sidebar's SYSTEM group, renamed "System
// Settings" (components/shell/nav-items.ts) — and SettingsShell.tsx redirects
// any non-admin who reaches a /settings* URL straight to /profile instead of
// rendering anything here. `adminOnly` stays on every entry (rather than
// being dropped as now-redundant) so a future non-admin-visible section can
// still opt out of that redirect without a second schema change.
//
// Lane D (Optional Mail Transport run, STATE.md): a 10th section, "mail",
// for the new mail subsystem admin UI (E5/E6/M10/M11) — task spec: "new
// SettingsSectionKey 'mail' wired through section-registry.ts +
// SettingsShell.tsx renderSection + app/settings/mail/page.tsx". Placed
// after "plugins" (both are provider-adjacent write-only-credential
// surfaces) and before "advanced" (the registry fields this section ALSO
// composes for its five mail.*/network.publicUrl keys).
//
// Admin broadcast notifications run (STATE.md, Lane B): an 11th section,
// "notices", for the system-notices compose/history admin UI (N1-N6) —
// task spec: "New settings section notices (label 'Notices', adminOnly:
// true)". Placed right after "server": the flagship compose presets are
// restart/maintenance notices, operationally paired with ServerPowerCard
// on that same "server" page (a restart notice is communication ABOUT the
// action that page's Power card actually performs), so the two admin
// operational surfaces sit next to each other in the tab order.
//
// This file stays framework-free (no React) on purpose: mobile-header.ts
// (a pure, hook-free route resolver) imports SETTINGS_SECTIONS directly to
// title the mobile back-chevron chrome for every `/settings/<key>` drill-
// down route — see that file's new branch. Keeping this a plain data module
// is what makes that import safe.
//
// Route shape: "/settings" itself is the responsive hub/tab-list host
// (mobile: grouped list when no section is active; desktop: pill tabs +
// pane, defaulting to "server" — the first section, since D-6 removed the
// non-admin "account" default; see SettingsShell.tsx). Every OTHER key gets
// its own real Next.js route under /settings/<key> — this is what lets the
// existing mobile-header.ts "back chevron pops to the owning tab" pattern
// (formerly also used by /admin/system and /admin/settings) apply
// uniformly: drilling into a hub row is real navigation with a real back
// target, exactly like every other admin sub-route already works, not a
// bespoke client-side overlay invented for this one screen.
//
// adminOnly gates both the hub row/tab AND the route itself (SettingsShell
// redirects ANY non-admin hitting ANY /settings* URL to /profile now — see
// its header) — every section here is adminOnly: true since D-6 moved the
// one non-admin section, "account", out to /profile entirely.

export type SettingsSectionKey =
  | "server"
  | "notices"
  | "libraries"
  | "users"
  | "playback"
  | "remote-access"
  | "plugins"
  | "mail"
  | "advanced"
  | "about";

export interface SettingsSectionConfig {
  key: SettingsSectionKey;
  /** Tab/hub-row label. Matches the README's literal tab names except
   *  "Advanced Server" / "Users & Profiles" (kept exactly as the README
   *  spells them). */
  label: string;
  /** Always a real route — bare "/settings" for the hub/default-tab host,
   *  "/settings/<key>" for every other section (see header). */
  href: string;
  adminOnly: boolean;
}

export const SETTINGS_SECTIONS: SettingsSectionConfig[] = [
  { key: "server", label: "Server", href: "/settings/server", adminOnly: true },
  { key: "notices", label: "Notices", href: "/settings/notices", adminOnly: true },
  { key: "libraries", label: "Libraries", href: "/settings/libraries", adminOnly: true },
  { key: "users", label: "Users & Profiles", href: "/settings/users", adminOnly: true },
  { key: "playback", label: "Playback", href: "/settings/playback", adminOnly: true },
  { key: "remote-access", label: "Remote Access", href: "/settings/remote-access", adminOnly: true },
  { key: "plugins", label: "Plugins", href: "/settings/plugins", adminOnly: true },
  { key: "mail", label: "Mail", href: "/settings/mail", adminOnly: true },
  { key: "advanced", label: "Advanced Server", href: "/settings/advanced", adminOnly: true },
  { key: "about", label: "About", href: "/settings/about", adminOnly: true },
];

export function sectionByKey(key: string): SettingsSectionConfig | undefined {
  return SETTINGS_SECTIONS.find((s) => s.key === key);
}

export function sectionByHref(href: string): SettingsSectionConfig | undefined {
  return SETTINGS_SECTIONS.find((s) => s.href === href);
}

/** Tabs/hub rows visible to the current user — every section here is
 *  adminOnly (see header), so this returns the full list for an admin and
 *  an empty array otherwise. Preserves SETTINGS_SECTIONS' order. */
export function visibleSections(isAdmin: boolean): SettingsSectionConfig[] {
  return SETTINGS_SECTIONS.filter((s) => isAdmin || !s.adminOnly);
}
