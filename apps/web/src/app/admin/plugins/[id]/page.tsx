// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/admin/plugins/[id]/page.tsx
//
// LD-8 (owner directive, Settings-Plugins consolidation): the admin Plugin
// detail page MOVED to /settings/plugins/[id] (see that route's own header
// for the full content inventory) — the admin Dashboard's separate
// "Plugins" tab is retired (components/admin/AdminNav.tsx no longer links
// here). This route stays live as a redirect-only stub, preserving the id
// segment, so any existing bookmark/link to /admin/plugins/<id> keeps
// working.
//
// browser-admin-F1 (P1): server-side `redirect()`, never a mount-time
// effect — see ../../libraries/page.tsx's header for the deferred-mount
// defect that ate the old `useEffect(() => router.replace(...))`. That
// rewrite also retired the ./AdminPluginDetailRedirect.tsx split (it
// existed only so a client component could be rendered with a plain `id`
// prop in a test): an async server component awaits `params` directly and
// ../../redirect-stubs.test.ts calls it directly.

import { redirect } from "next/navigation";

export default async function AdminPluginDetailRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<never> {
  const { id } = await params;
  redirect(`/settings/plugins/${encodeURIComponent(id)}`);
}
