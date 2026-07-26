// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/about/page.tsx
//
// Wave 2 lane L1 (Settings IA): dedicated route for the "About" section
// (section-registry.ts, README tab 8) — see
// components/settings/SettingsShell.tsx's header for the full design.

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsShell } from "../../../components/settings/SettingsShell.js";

export default function SettingsAboutPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection="about" />
    </AppShell>
  );
}
