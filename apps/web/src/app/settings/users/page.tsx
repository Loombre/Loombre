// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/users/page.tsx
//
// Wave 2 lane L1 (Settings IA): dedicated route for the "Users & Profiles"
// section (section-registry.ts, README tab 3) — replaces the pre-IA
// apps/web/src/app/admin/users/page.tsx, which is now a redirect-only stub
// to this route. See components/settings/SettingsShell.tsx's header for
// the full design.

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsShell } from "../../../components/settings/SettingsShell.js";

export default function SettingsUsersPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection="users" />
    </AppShell>
  );
}
