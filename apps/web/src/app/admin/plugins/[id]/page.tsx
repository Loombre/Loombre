// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/plugins/[id]/page.tsx
//
// LD-8 (owner directive, Settings-Plugins consolidation): the admin Plugin
// detail page MOVED to /settings/plugins/[id] (see that route's own header
// for the full content inventory) — the admin Dashboard's separate
// "Plugins" tab is retired (components/admin/AdminNav.tsx no longer links
// here). This route stays live as a redirect-only stub, preserving the id
// segment — same pattern app/admin/libraries/page.tsx already uses for the
// list-level redirect — so any existing bookmark/link to
// /admin/plugins/<id> keeps working.
//
// Route entry only (Next rejects any export beyond default/route-config on
// a page.tsx) — the actual redirect component, and the named export
// page.test.tsx reaches for, lives in ./AdminPluginDetailRedirect.tsx (same
// split app/claim/[token]/page.tsx + ClaimScreen.tsx already use).

import { use } from "react";
import { AdminPluginDetailRedirect } from "./AdminPluginDetailRedirect.js";

export default function AdminPluginDetailRedirectPage({ params }: { params: Promise<{ id: string }> }): React.JSX.Element {
  const { id } = use(params);
  return <AdminPluginDetailRedirect id={id} />;
}
