// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/home/page.tsx
//
// Route entry only. Next type-checks a `page.tsx` as a ROUTE module and
// rejects every export that isn't `default` or a route segment config, so
// Home's actual component tree — and the named export the unit tests reach
// for — lives in ./HomeContent.tsx (see that file's header for the screen's
// design ground truth, featured-pool derivation and data-omissions ledger).

import { AppShell } from "../../components/shell/AppShell.js";
import { HomeContent } from "./HomeContent.js";

export default function HomePage(): React.JSX.Element {
  return (
    <AppShell>
      <HomeContent />
    </AppShell>
  );
}
