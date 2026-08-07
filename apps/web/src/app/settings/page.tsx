// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/page.tsx
//
// Wave 2 lane L1 (Phosphor Settings IA, design/phosphor/README.md
// "Screens -> Settings" + "Screens -> Mobile -> Settings hub"): bare
// /settings — the hub/default-tab host. All real behavior lives in
// components/settings/SettingsShell.tsx (see its header for the full
// responsive/role-gating design) — this route just supplies
// `initialSection: null`, vs. every /settings/<key> sibling route which
// supplies its own key.
//
// D-6 (Wave 2, this run — IA restructure): this route is now admin-only
// end to end — SettingsShell redirects any non-admin here straight to
// /profile (components/profile/ProfileSettings.tsx), the new home for the
// personal Profile/Password/Restricted/Playback content this route held
// directly pre-Wave-2, and briefly as the "Account" tab/hub-section under
// L1's original unified design. "System Settings" (the sidebar's SYSTEM
// group — components/shell/nav-items.ts) is the only nav path here now.

import { AppShell } from "../../components/shell/AppShell.js";
import { SettingsShell } from "../../components/settings/SettingsShell.js";

export default function SettingsPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection={null} />
    </AppShell>
  );
}
