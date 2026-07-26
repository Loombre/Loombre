// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/advanced/page.tsx
//
// Wave 2 lane L1 (Settings IA): dedicated route for the "Advanced Server"
// section (section-registry.ts, README tab 7 — the schema-driven
// registry) — replaces the pre-IA apps/web/src/app/admin/settings/page.tsx,
// which is now a redirect-only stub to this route. See
// components/settings/SettingsShell.tsx's header for the full design.

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsShell } from "../../../components/settings/SettingsShell.js";

export default function SettingsAdvancedPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection="advanced" />
    </AppShell>
  );
}
