// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/SettingsTabs.tsx
//
// Desktop pill tab list (README "Settings. 200px pill tab list + a 760px
// max-width pane"). Real navigation — each tab is a Link to its section's
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
