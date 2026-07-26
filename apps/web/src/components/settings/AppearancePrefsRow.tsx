// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/AppearancePrefsRow.tsx
//
// Wave 2 L7 (README "Design tokens → Accent as a user preference" / "Other"
// — scanlines): a minimal, self-contained preference row — four accent
// swatches + a scanlines toggle — for sibling lane L1's settings IA to
// slot wherever it lands the personal-settings page's sections (this file
// makes no assumption about that placement: no import of app/settings/**,
// no shared classes from its page.module.css, nothing beyond this
// component's own CSS module). Reads/writes through
// lib/appearance-prefs.ts, which is the ONLY place that touches
// localStorage or the root `data-accent`/`data-scanlines` attributes — see
// that file's header for why this is client-only rather than round-
// tripping the server (the user-settings prefs mechanism genuinely has no
// slot for these two keys today; logged in this lane's freeze report).

import { useState } from "react";
import { Toggle } from "../ui/Toggle.js";
import {
  ACCENT_NAMES,
  ACCENT_HEX,
  getAppearancePrefs,
  setAppearancePrefs,
  type AccentName,
} from "../../lib/appearance-prefs.js";
import styles from "./AppearancePrefsRow.module.css";

const ACCENT_LABELS: Record<AccentName, string> = {
  amber: "Amber",
  lime: "Lime",
  mint: "Mint",
  blue: "Blue",
};

export function AppearancePrefsRow(): React.JSX.Element {
  const [prefs, setPrefs] = useState(() => getAppearancePrefs());

  function selectAccent(accent: AccentName): void {
    setPrefs(setAppearancePrefs({ accent }));
  }

  function toggleScanlines(scanlines: boolean): void {
    setPrefs(setAppearancePrefs({ scanlines }));
  }

  return (
    <div className={styles.row}>
      <div className={styles.group}>
        <span className={styles.groupLabel}>Accent</span>
        <div className={styles.swatches} role="radiogroup" aria-label="Accent color">
          {ACCENT_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={prefs.accent === name}
              aria-label={ACCENT_LABELS[name]}
              title={ACCENT_LABELS[name]}
              data-selected={prefs.accent === name}
              className={styles.swatch}
              style={{ "--swatch-color": ACCENT_HEX[name] } as React.CSSProperties}
              onClick={() => selectAccent(name)}
            />
          ))}
        </div>
      </div>

      <div className={styles.group}>
        <Toggle checked={prefs.scanlines} onChange={toggleScanlines} label="Scanlines" />
      </div>
    </div>
  );
}
