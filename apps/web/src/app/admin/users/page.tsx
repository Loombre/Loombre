// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/admin/users/page.tsx
//
// Wave 2 lane L1 (Settings IA unification): Users & Profiles management
// moved to /settings/users (components/settings/sections/UsersSection.tsx)
// — same real endpoints, restyled per design/phosphor/README.md's
// prototype. This route stays live as a redirect-only stub so any
// existing bookmark/link to /admin/users keeps working, per this lane's
// brief: "map existing capability into the prototype's tab structure
// WITHOUT breaking existing routes."
//
// browser-admin-F1 (P1): server-side `redirect()`, never a mount-time
// effect — see ../libraries/page.tsx's header for the deferred-mount
// defect that ate the old `useEffect(() => router.replace(...))`. Pinned
// by ../redirect-stubs.test.ts.

import { redirect } from "next/navigation";

export default function AdminUsersRedirectPage(): never {
  redirect("/settings/users");
}
