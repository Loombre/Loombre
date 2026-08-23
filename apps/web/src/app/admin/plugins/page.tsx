// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/admin/plugins/page.tsx
//
// LD-8 (owner directive, Settings-Plugins consolidation): the admin
// Plugins list + "Register a plugin" flow MOVED to Settings -> Plugins
// (components/settings/sections/RegisteredPluginsPanel.tsx, rendered on
// /settings/plugins alongside metadata provider keys) — the admin
// Dashboard's separate "Plugins" tab is retired (components/admin/
// AdminNav.tsx no longer links here). This route stays live as a
// redirect-only stub so any existing bookmark/link to /admin/plugins keeps
// working.
//
// browser-admin-F1 (P1): server-side `redirect()`, never a mount-time
// effect — see ../libraries/page.tsx's header for the deferred-mount
// defect that ate the old `useEffect(() => router.replace(...))`. Pinned
// by ../redirect-stubs.test.ts.

import { redirect } from "next/navigation";

export default function AdminPluginsRedirectPage(): never {
  redirect("/settings/plugins");
}
