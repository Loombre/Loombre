// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/plugins/[id]/page.tsx
//
// Route entry only (Next rejects any export beyond default/route-config on
// a page.tsx) — the actual screen, and the named export the unit test
// reaches for, lives in ./PluginDetailScreen.tsx. See that file's header
// for the full content inventory (LD-8, Settings-Plugins consolidation).

import { use } from "react";
import { PluginDetailScreen } from "./PluginDetailScreen.js";

export default function SettingsPluginDetailPage({ params }: { params: Promise<{ id: string }> }): React.JSX.Element {
  const { id } = use(params);
  return <PluginDetailScreen id={id} />;
}
