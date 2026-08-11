// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/admin/layout.tsx
//
// Phase 4 deliverable D: the /admin section shell. Wraps every /admin/*
// route in the normal AppShell (same nav rail/topbar as the rest of the
// app — P2.20 glass chrome) PLUS an admin-only route guard (useAdminGuard,
// apps/web/src/lib/use-admin-guard.ts): a non-admin (or an admin whose
// token hasn't resolved yet) never sees admin content flash on screen,
// even for a frame — `isAdmin` starts `null` ("checking") and only flips
// to `true` after a real GET /users/me confirms isAdmin === true; anything
// else redirects to /home. This is UX, not the security boundary (every
// actual admin endpoint independently 403s a non-admin token server-side —
// apps/server/src/catalog/*.controller.ts's requireAdmin — so a
// client-side bypass of this guard could see loading skeletons at worst,
// never real data).

import type { ReactNode } from "react";
import { AppShell } from "../../components/shell/AppShell.js";
import { AdminNav } from "../../components/admin/AdminNav.js";
import { SettingsPageLayout } from "../../components/settings/SettingsPageLayout.js";
import { useAdminGuard } from "../../lib/use-admin-guard.js";
import styles from "./layout.module.css";

export default function AdminLayout({ children }: { children: ReactNode }): React.JSX.Element | null {
  // opus-review LD wave, Finding 6: was a hand-rolled duplicate of the SAME
  // GET /users/me -> redirect-non-admin-away guard SettingsShell.tsx and
  // PluginDetailScreen.tsx each carried independently — now the shared
  // useAdminGuard hook. /admin/* redirects to /home (not /profile — see
  // that hook's header for why the two differ), and keeps AppShell mounted
  // throughout the check (below) rather than blanking the whole viewport.
  const { isAdmin } = useAdminGuard("/home");

  return (
    <AppShell>
      {isAdmin === true ? (
        // W7/D-4: SettingsPageLayout owns the readable-max-width +
        // centered-in-<main> contract every /admin/* page shares (heading,
        // AdminNav, and whichever page body <main> is currently rendering
        // all sit inside the SAME centered column) — see that file's
        // header for the left-hugging/dead-right-margin defect this
        // replaced (layout.module.css's `.page` used to cap width with no
        // `margin: auto`, so it hugged <main>'s left edge instead).
        <SettingsPageLayout>
          <div className={styles.page}>
            <h1 className={styles.heading}>Admin</h1>
            <AdminNav />
            {children}
          </div>
        </SettingsPageLayout>
      ) : null}
    </AppShell>
  );
}
