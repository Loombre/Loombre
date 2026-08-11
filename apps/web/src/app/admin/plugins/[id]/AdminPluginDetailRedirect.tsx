// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/plugins/[id]/AdminPluginDetailRedirect.tsx
//
// The actual redirect component, split out of page.tsx (Next rejects any
// export beyond default/route-config on a page.tsx — same reason
// app/claim/[token]/page.tsx delegates to a sibling ClaimScreen.tsx) so
// page.test.tsx can exercise it with a plain `id` prop instead of driving
// page.tsx's `use(params)` Suspense unwrapping.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AdminPluginDetailRedirect({ id }: { id: string }): null {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/settings/plugins/${encodeURIComponent(id)}`);
  }, [router, id]);
  return null;
}
