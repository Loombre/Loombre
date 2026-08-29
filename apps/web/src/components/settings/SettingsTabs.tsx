// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/SettingsTabs.tsx
//
// Desktop tab column. I5/UD-8 (UIFIX-2026-08-29) superseded the README's
// "Settings. 200px pill tab list" line this file used to cite: the column
// is now fluid — width: clamp(168px, 18vw, 200px) — and each tab is a
// --radius-md row on the --control-height floor (a tab label can wrap
// inside a 168px column; a pill is for things that cannot wrap).
// Real navigation — each tab is a Link to its section's
// own route (section-registry.ts); clicking a tab is a normal client-side
// route change to /settings/<key> (or bare /settings for "account"), which
// is what lets a deep link to any single section ALSO render inside the
// full tab chrome on desktop (SettingsShell.tsx renders this alongside the
// active section regardless of which /settings* route served the page).

import Link from "next/link";
import { SETTINGS_SECTIONS, type SettingsSectionKey } from "./section-registry.js";
import styles from "./SettingsTabs.module.css";

export function SettingsTabs({ active }: { active: SettingsSectionKey }): React.JSX.Element {
  return (
    <nav className={styles.tabs} aria-label="Settings sections">
      {SETTINGS_SECTIONS.map((section) => (
        <Link key={section.key} href={section.href} className={styles.tab} data-active={section.key === active}>
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
