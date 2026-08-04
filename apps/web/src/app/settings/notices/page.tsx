// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/notices/page.tsx
//
// Admin broadcast notifications run, Lane B: dedicated route for the
// "Notices" section (section-registry.ts) — mirrors
// app/settings/server/page.tsx exactly (see
// components/settings/SettingsShell.tsx's header for the full responsive
// design this shares with every other /settings/<key> route).

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsShell } from "../../../components/settings/SettingsShell.js";

export default function SettingsNoticesPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection="notices" />
    </AppShell>
  );
}
