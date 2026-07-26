// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/users/page.tsx
//
// Wave 2 lane L1 (Settings IA unification): Users & Profiles management
// moved to /settings/users (components/settings/sections/UsersSection.tsx)
// — same real endpoints, restyled per design/phosphor/README.md's
// prototype. This route stays live as a redirect-only stub (same pattern
// app/admin/page.tsx already uses for /admin -> /admin/jobs) so any
// existing bookmark/link to /admin/users keeps working, per this lane's
// brief: "map existing capability into the prototype's tab structure
// WITHOUT breaking existing routes."

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminUsersRedirectPage(): null {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/users");
  }, [router]);
  return null;
}
