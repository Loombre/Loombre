// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/admin/libraries/page.tsx
//
// Wave 2 lane L1 (Settings IA unification): Libraries management moved to
// /settings/libraries (components/settings/sections/LibrariesSection.tsx)
// — same real endpoints, restyled per design/phosphor/README.md's
// prototype. This route stays live as a redirect-only stub so any
// existing bookmark/link to /admin/libraries keeps working, per this
// lane's brief: "map existing capability into the prototype's tab
// structure WITHOUT breaking existing routes."
//
// browser-admin-F1 (P1): this WAS a client component doing
// `useEffect(() => router.replace(...))`, and it silently dropped the
// redirect on 6 of 7 hard loads — every /admin/* stub mounts as a
// DEFERRED child of ../layout.tsx (which renders {children} only after
// useAdminGuard's async GET /users/me flips `isAdmin` to true), and the
// replace() fired from that late mount fetched the target's RSC payload
// but never committed the navigation, leaving the user on an empty admin
// shell. A server-side `redirect()` is issued during the page's own
// render — a real 307 on a hard load, a router-followed redirect on a
// client navigation — so no mount timing can drop it. Pinned by
// ../redirect-stubs.test.ts.

import { redirect } from "next/navigation";

export default function AdminLibrariesRedirectPage(): never {
  redirect("/settings/libraries");
}
