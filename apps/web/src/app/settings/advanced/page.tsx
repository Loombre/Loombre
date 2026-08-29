// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/advanced/page.tsx
//
// Wave 2 lane L1 (Settings IA): the dedicated route for the "Advanced
// Server" section (section-registry.ts, README tab 7 — the schema-driven
// registry).
//
// UIFIX-2026-08-29 Lane K, UD-2 (advanced-only): this route no longer goes
// through SettingsShell. Every other /settings/<key> route still does and
// still gets SettingsTabs + SettingsPageLayout; Advanced is the one section
// that folds the tab column into its own page title (SectionSwitcher) and
// needs the full content width for three panes, which
// SettingsPageLayout's readable-width cap would take away. SettingsShell
// itself is untouched — its renderSection("advanced") branch still mounts
// the same component, admin guard included, so nothing there had to move.

import { AppShell } from "../../../components/shell/AppShell.js";
import { AdvancedSection } from "../../../components/settings/sections/AdvancedSection.js";

export default function SettingsAdvancedPage(): React.JSX.Element {
  return (
    <AppShell>
      <AdvancedSection />
    </AppShell>
  );
}
