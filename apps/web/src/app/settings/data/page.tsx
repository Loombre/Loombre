// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/data/page.tsx
//
// D-6 completion (Wave 3, this run — IA restructure): the ExportDataCard
// content that used to render here MOVED to its own route, /profile/data
// (app/profile/data/page.tsx) — user-scoped self-service content (a user's
// own GET /export archive) no longer lives anywhere under the now
// admin-only /settings surface (components/settings/section-registry.ts's
// header). This route stays live as a redirect-only stub — same pattern
// app/settings/account/page.tsx already uses for /settings/account ->
// /profile — so any existing bookmark/link to /settings/data keeps working.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SettingsDataRedirectPage(): null {
  const router = useRouter();
  useEffect(() => {
    router.replace("/profile/data");
  }, [router]);
  return null;
}
