// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/items/[itemType]/[id]/page.tsx
//
// Route entry only. Next type-checks a `page.tsx` as a ROUTE module and
// rejects every export that isn't `default` or a route segment config, so
// the per-type detail screens — and the named exports the unit tests reach
// for — live in ./DetailScreens.tsx (see that file's header for which item
// types are directly routable and why "season" is not).

"use client";

import { use } from "react";
import { AppShell } from "../../../../components/shell/AppShell.js";
import { DetailContent } from "./DetailScreens.js";

export default function ItemDetailPage({
  params,
}: {
  params: Promise<{ itemType: string; id: string }>;
}): React.JSX.Element {
  const { itemType, id } = use(params);
  return (
    <AppShell>
      <DetailContent itemType={itemType} id={id} />
    </AppShell>
  );
}
