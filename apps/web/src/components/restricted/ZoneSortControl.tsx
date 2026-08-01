// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZoneSortControl.tsx
//
// STATE.md Stash run (S9): the zone's own 5-value sort control
// (added|date|title|rating|duration — packages/contract/openapi.yaml's
// RestrictedBrowseSort), same SegmentedControl recipe components/browse/
// SortControl.tsx uses but WARNING-toned active state (design/phosphor
// README "Active genre/filter chips fill amber (#E0A548 with dark text),
// not accent — the zone keeps its warning colour"), so a dedicated CSS
// module rather than composing SortControl.module.css directly (that file
// is Browse's own, accent-toned).

import { ZONE_SORT_OPTIONS, type ZoneSort } from "../../lib/zone-browse-filters.js";
import styles from "./ZoneControls.module.css";

export function ZoneSortControl({
  active,
  onChange,
}: {
  active: ZoneSort;
  onChange: (value: ZoneSort) => void;
}): React.JSX.Element {
  return (
    <div className={styles.sortTrack} role="tablist" aria-label="Sort">
      {ZONE_SORT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === active}
          data-active={option.value === active}
          className={styles.sortSegment}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
