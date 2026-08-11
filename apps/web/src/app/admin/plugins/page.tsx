// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/plugins/page.tsx
//
// LD-8 (owner directive, Settings-Plugins consolidation): the admin
// Plugins list + "Register a plugin" flow MOVED to Settings -> Plugins
// (components/settings/sections/RegisteredPluginsPanel.tsx, rendered on
// /settings/plugins alongside metadata provider keys) — the admin
// Dashboard's separate "Plugins" tab is retired (components/admin/
// AdminNav.tsx no longer links here). This route stays live as a
// redirect-only stub — same pattern app/admin/libraries/page.tsx already
// uses for /admin/libraries -> /settings/libraries — so any existing
// bookmark/link to /admin/plugins keeps working.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminPluginsRedirectPage(): null {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/plugins");
  }, [router]);
  return null;
}
