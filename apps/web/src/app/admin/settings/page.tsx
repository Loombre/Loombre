// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/admin/settings/page.tsx
//
// Wave 2 lane L1 (Settings IA unification): the schema-driven registry
// (STATE.md Addendum A) moved to /settings/advanced
// (components/settings/sections/AdvancedSection.tsx) and provider-key
// management split out to its own /settings/plugins tab
// (components/settings/sections/PluginsSection.tsx) — same real endpoints
// (GET/PUT /admin/settings*, GET/PUT/DELETE /admin/provider-keys/{provider}),
// restyled per design/phosphor/README.md's 8-tab prototype. This route
// stays live as a redirect-only stub so any existing bookmark/link to
// /admin/settings keeps working, per this lane's brief: "map existing
// capability into the prototype's tab structure WITHOUT breaking existing
// routes." (The API routes /admin/settings, /admin/settings/schema, etc.
// are untouched — this redirect is only about the Next.js PAGE route.)
//
// browser-admin-F1 (P1): server-side `redirect()`, never a mount-time
// effect — see ../libraries/page.tsx's header for the deferred-mount
// defect that ate the old `useEffect(() => router.replace(...))`. Pinned
// by ../redirect-stubs.test.ts.

import { redirect } from "next/navigation";

export default function AdminSettingsRedirectPage(): never {
  redirect("/settings/advanced");
}
