// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/settings/devices/page.tsx
//
// Dedicated route for DevicesSection (components/devices/DevicesSection.tsx)
// — GET/DELETE /devices existed since Phase 1 with no reachable UI anywhere
// in apps/web (77-agent review finding, feature-no-ui). See that
// component's header for the full writeup.
//
// NOT wired into components/settings/section-registry.ts's SETTINGS_SECTIONS
// or rendered through components/settings/SettingsShell.tsx — both files
// are owned by a concurrent lane and out of scope here. This route works
// standalone (AppShell chrome + its own back link) for any user who
// navigates to /settings/devices directly; it does not yet appear as a tab
// or hub row.
//
// D-6 (Wave 2, this run — IA restructure): the back link below now points
// at /profile, not /settings/account — the user-scoped Profile/Password/
// Playback/Restricted content this "own devices" surface is conceptually a
// sibling of moved there (components/profile/ProfileSettings.tsx); this is
// the one link-sweep update this file needed, its own device-management
// content is unrelated and untouched.
//
// TODO (owner/next lane, not a file this task may touch): D-6 moved every
// user-scoped settings surface OUT of section-registry.ts's
// SETTINGS_SECTIONS (now admin-only end to end — see its header), so the
// pre-D-6 version of this TODO ("register a 'devices' SETTINGS_SECTIONS
// entry") no longer fits; this page's natural home now is alongside
// /profile instead — a real nav entry point from there (and/or folding this
// route into ProfileSettings.tsx's own card list) is still open. This route
// keeps working standalone via direct URL either way. ProfileSettings.tsx's
// ChangePasswordSection states plainly that a password change signs other
// devices out itself (G10/F3) — this route remains the place to
// review/revoke individual sessions any other time.

import Link from "next/link";
import { AppShell } from "../../../components/shell/AppShell.js";
import { SettingsPageLayout } from "../../../components/settings/SettingsPageLayout.js";
import { DevicesSection } from "../../../components/devices/DevicesSection.js";
import styles from "./page.module.css";

export default function SettingsDevicesPage(): React.JSX.Element {
  return (
    <AppShell>
      {/* W7/D-4: this standalone route (see header above) still gets the
          same shared width/centering primitive every other settings/admin
          page now uses — see SettingsPageLayout.tsx's header. */}
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
