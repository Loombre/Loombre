// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/libraries/page.tsx
//
// Wave 2 lane L1 (Settings IA unification): Libraries management moved to
// /settings/libraries (components/settings/sections/LibrariesSection.tsx)
// — same real endpoints, restyled per design/phosphor/README.md's
// prototype. This route stays live as a redirect-only stub (same pattern
// app/admin/page.tsx already uses for /admin -> /admin/jobs) so any
// existing bookmark/link to /admin/libraries keeps working, per this
// lane's brief: "map existing capability into the prototype's tab
// structure WITHOUT breaking existing routes."

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminLibrariesRedirectPage(): null {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/libraries");
  }, [router]);
  return null;
}
