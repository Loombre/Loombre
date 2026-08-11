// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/plugins/page.tsx
//
// Wave 2 lane L1 (Settings IA): dedicated route for the "Plugins" section
// (section-registry.ts, README tab 6 — metadata provider API keys).
// See components/settings/SettingsShell.tsx's header for the full design.
//
// LD-8 (owner directive, Settings-Plugins consolidation): this is now ALSO
// the ONE home for Loombre Plugin Protocol registration/management —
// PluginsSection.tsx composes RegisteredPluginsPanel (list + register,
// moved from the admin Dashboard's former "Plugins" tab) alongside the
// existing ProviderKeysCard. The former "NOT the unrelated LPP admin
// surface at /admin/plugins" naming-collision note is retired along with
// the collision itself — /admin/plugins is now a redirect-only stub into
// this same route, and /admin/plugins/<id> into
// /settings/plugins/<id> (app/settings/plugins/[id]/page.tsx).

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsShell } from "../../../components/settings/SettingsShell.js";

export default function SettingsPluginsPage(): React.JSX.Element {
  return (
    <AppShell>
      <SettingsShell initialSection="plugins" />
    </AppShell>
  );
}
