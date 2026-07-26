// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/account/page.tsx
//
// Wave 2 lane L1 (Settings IA): dedicated route for the "Account" section
// (section-registry.ts) — reachable from the mobile hub's own row, and
// from a direct link/bookmark; on desktop it renders inside the full
// SettingsShell tab chrome exactly like every other /settings/<key> route.
// See components/settings/SettingsShell.tsx's header for the full design.

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsShell } from "../../../components/settings/SettingsShell.js";

export default function SettingsAccountPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection="account" />
    </AppShell>
  );
}
