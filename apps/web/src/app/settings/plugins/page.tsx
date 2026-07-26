// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/plugins/page.tsx
//
// Wave 2 lane L1 (Settings IA): dedicated route for the "Plugins" section
// (section-registry.ts, README tab 6 — metadata provider API keys; NOT the
// unrelated Loombre Plugin Protocol admin surface at /admin/plugins, see
// components/admin/AdminNav.tsx's header for the logged naming collision).
// See components/settings/SettingsShell.tsx's header for the full design.

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsShell } from "../../../components/settings/SettingsShell.js";

export default function SettingsPluginsPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection="plugins" />
    </AppShell>
  );
}
