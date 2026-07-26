// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/page.tsx
//
// Wave 2 lane L1 (Phosphor Settings IA, design/phosphor/README.md
// "Screens -> Settings" + "Screens -> Mobile -> Settings hub"): the
// unified Settings entry point for every user. All real behavior lives in
// components/settings/SettingsShell.tsx (see its header for the full
// responsive/role-gating design) — this route just supplies
// `initialSection: null`, meaning "the hub/default-tab host", vs. every
// /settings/<key> sibling route which supplies its own key.
//
// Pre-Wave-2 this file held the personal Profile/Restricted/Playback
// content directly (now components/settings/sections/AccountSection.tsx,
// reused unchanged) and rendered its own `<h1>Settings</h1>` unconditionally
// — the mobile large-title header ALSO reads "Settings" for this exact
// route (mobile-header.ts), so that was a real duplicate-title bug this
// lane's brief called out. SettingsShell now owns exactly when a heading
// renders in-page vs. is left to the shell chrome.

import { AppShell } from "../../components/shell/AppShell.js";
import { SettingsShell } from "../../components/settings/SettingsShell.js";

export default function SettingsPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection={null} />
    </AppShell>
  );
}
