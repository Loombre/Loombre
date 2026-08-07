// SPDX-License-Identifier: AGPL-3.0-only
"use client";

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
// as a redirect-only stub — same pattern app/admin/libraries/page.tsx
// already uses for /admin/libraries -> /settings/libraries — so any
// existing bookmark/link to /admin/system keeps working.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminSystemRedirectPage(): null {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin");
  }, [router]);
  return null;
}
