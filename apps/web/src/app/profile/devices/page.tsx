// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/profile/devices/page.tsx
//
// D-6 completion (Wave 3, this run): MOVED here, from /settings/devices —
// this route is user-scoped (the caller's own enrolled-device list, GET
// /devices, never server-scoped), so it doesn't belong under the
// admin-branded /settings prefix (components/settings/section-registry.ts's
// header: SETTINGS_SECTIONS is admin-only end to end). It now sits alongside
// every other user-scoped self-service surface at /profile
// (app/profile/page.tsx), reached via the "Devices" link ProfileSettings.tsx's
// own links card adds. The old /settings/devices route stays live as a
// redirect-only stub to here — same posture app/settings/account/page.tsx
// already uses for /settings/account -> /profile — so any existing
// bookmark/link (including components/settings/remote-wizard/
// PathManagementCard.tsx's "Manage enrolled devices" link, updated
// alongside this move) keeps working either way.
//
// Nothing about this page's OWN behavior changed in the move: same
// DevicesSection, same GET/DELETE /devices endpoints. The back link below
// still points at /profile — this route's own parent — unchanged from
// before the move.

import Link from "next/link";
import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsPageLayout } from "../../../components/settings/SettingsPageLayout.js";
import { DevicesSection } from "../../../components/devices/DevicesSection.js";
import styles from "./page.module.css";

export default function ProfileDevicesPage(): React.JSX.Element {
  return (
    <AppShell>
      {/* W7/D-4: this standalone route still gets the same shared
          width/centering primitive every other settings/admin page uses —
          see SettingsPageLayout.tsx's header. */}
      <SettingsPageLayout>
        <div className={styles.wrap}>
          <Link href="/profile" className={styles.backLink}>
            ← Profile
          </Link>
          <DevicesSection heading="Devices" />
        </div>
      </SettingsPageLayout>
    </AppShell>
  );
}
