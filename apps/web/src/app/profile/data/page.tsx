// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/profile/data/page.tsx
//
// D-6 completion (Wave 3, this run): MOVED here, from /settings/data — this
// route is user-scoped (a signed-in user's own GET /export archive, never
// server-scoped), so it doesn't belong under the admin-branded /settings
// prefix (components/settings/section-registry.ts's header: SETTINGS_SECTIONS
// is admin-only end to end). It now sits alongside every other user-scoped
// self-service surface at /profile (app/profile/page.tsx), reached via the
// "Your data" link ProfileSettings.tsx's own links card adds. The old
// /settings/data route stays live as a redirect-only stub to here — same
// posture app/settings/account/page.tsx already uses for /settings/account
// -> /profile — so any existing bookmark/link keeps working.
//
// Nothing about this page's OWN behavior changed in the move: same
// ExportDataCard, same GET /export endpoint, same "no admin gate" posture
// (data-freedom.controller.ts's own header: "authenticated-but-not-admin —
// every signed-in user is entitled to their own data").

import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsPageLayout } from "../../../components/settings/SettingsPageLayout.js";
import { ExportDataCard } from "../../../components/data-freedom/ExportDataCard.js";
import styles from "./page.module.css";

export default function ProfileDataPage(): React.JSX.Element {
  return (
    <AppShell>
      {/* W7/D-4: this standalone route still gets the same shared
          width/centering primitive every other settings/admin page uses —
          see SettingsPageLayout.tsx's header. */}
      <SettingsPageLayout>
        <div className={styles.page}>
          <h1 className={styles.heading}>Your data</h1>
          <ExportDataCard />
        </div>
      </SettingsPageLayout>
    </AppShell>
  );
}
