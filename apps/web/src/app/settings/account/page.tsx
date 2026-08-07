// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/account/page.tsx
//
// D-6 (Wave 2, this run — IA restructure): the "Account" section that used
// to render here MOVED to its own route, /profile
// (components/profile/ProfileSettings.tsx) — user-scoped self-service
// content no longer lives anywhere under the now admin-only /settings
// surface (components/settings/section-registry.ts's header). This route
// stays live as a redirect-only stub — same pattern app/admin/libraries/
// page.tsx already uses for /admin/libraries -> /settings/libraries — so
// any existing bookmark/link to /settings/account keeps working.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SettingsAccountRedirectPage(): null {
  const router = useRouter();
  useEffect(() => {
    router.replace("/profile");
  }, [router]);
  return null;
}
