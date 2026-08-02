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
// TODO (owner/next lane, not a file this task may touch): register a
// "devices" entry in section-registry.ts's SETTINGS_SECTIONS (label
// "Devices", href "/settings/devices", adminOnly: false — every user, not
// just admins, needs to see their own sessions) and add a `case "devices"`
// to SettingsShell.tsx's renderSection so this gets the same tab chrome/
// back-chevron treatment as every other /settings/<key> route
// (mobile-header.ts's settingsSection branch already generalizes over
// SETTINGS_SECTIONS, so registering the entry there is sufficient — no
// mobile-header.ts change needed). AccountSection.tsx's
// ChangePasswordSection now states plainly that a password change signs
// other devices out itself (G10/F3) — this route remains the place to
// review/revoke individual sessions any other time.

import Link from "next/link";
import { AppShell } from "../../../components/shell/AppShell.js";
import { DevicesSection } from "../../../components/devices/DevicesSection.js";
import styles from "./page.module.css";

export default function SettingsDevicesPage(): React.JSX.Element {
  return (
    <AppShell>
      <div className={styles.wrap}>
        <Link href="/settings/account" className={styles.backLink}>
          ← Account
        </Link>
        <DevicesSection heading="Devices" />
      </div>
    </AppShell>
  );
}
