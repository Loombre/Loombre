// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZoneDensityToggle.tsx
//
// STATE.md Stash run (S9): net-new poster-wall <-> detailed-rows toggle
// for /restricted/browse — no precedent elsewhere in the app (design/
// phosphor README never drew this; the lane brief calls for it directly).
// Persistence: lib/zone-density-prefs.ts (localStorage, same recipe
// appearance-prefs.ts uses for accent/scanlines).

import { LayoutGrid, Rows3 } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import type { ZoneDensity } from "../../lib/zone-density-prefs.js";
import styles from "./ZoneControls.module.css";

export function ZoneDensityToggle({
  density,
  onChange,
}: {
  density: ZoneDensity;
  onChange: (density: ZoneDensity) => void;
}): React.JSX.Element {
  return (
    <div className={styles.densityTrack} role="group" aria-label="Density">
      <button
        type="button"
        className={styles.densitySegment}
        data-active={density === "wall"}
        aria-pressed={density === "wall"}
        aria-label="Poster wall"
        onClick={() => onChange("wall")}
      >
        <Icon icon={LayoutGrid} size="dense" />
      </button>
      <button
        type="button"
        className={styles.densitySegment}
        data-active={density === "rows"}
        aria-pressed={density === "rows"}
        aria-label="Detailed rows"
        onClick={() => onChange("rows")}
      >
        <Icon icon={Rows3} size="dense" />
      </button>
    </div>
  );
}
