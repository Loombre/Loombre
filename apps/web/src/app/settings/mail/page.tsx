// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/mail/page.tsx
//
// Lane D (Optional Mail Transport run): dedicated route for the "Mail"
// section (section-registry.ts) — settings/plugins/page.tsx is the exact
// tab-slot precedent this file copies (same AppShell + SettingsShell
// wiring, same reason: reachable directly, deep-linkable, and covered by
// mobile-header.ts's existing settingsSection branch with no further
// changes needed there).

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsShell } from "../../../components/settings/SettingsShell.js";

export default function SettingsMailPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection="mail" />
    </AppShell>
  );
}
