// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/app/admin/system/page.tsx
//
// D-5 (Wave 2, this run — IA restructure, locked decision): the sidebar's
// SYSTEM section used to show both "Dashboard" and "System" presenting
// overlapping information (health/version facts on both, hardware
// capabilities only here, active streams/libraries/jobs only there). Merged
// into a single "Dashboard" entry — the six cards this page used to render
// (SystemInfoCard, CapabilitiesCard, UpdateNoticeCard, ProviderKeysNoticeCard,
// CrashFilesCard, LogsTailCard) moved to components/admin/system/*.tsx and
// are now composed directly on app/admin/page.tsx, which absorbed
// everything this page had that the Dashboard lacked. This route stays live
// as a redirect-only stub back there so any existing bookmark/link to
// /admin/system keeps working.
//
// browser-admin-F1 (P1): server-side `redirect()`, never a mount-time
// effect — see ../libraries/page.tsx's header for the deferred-mount
// defect that ate the old `useEffect(() => router.replace(...))`. Pinned
// by ../redirect-stubs.test.ts.

import { redirect } from "next/navigation";

export default function AdminSystemRedirectPage(): never {
  redirect("/admin");
}
