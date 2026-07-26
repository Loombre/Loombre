// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/RestrictedZoneEmptyState.tsx
//
// The zone toolbar's "no results" state (design/phosphor/README.md: "an
// empty result shows a dashed empty state with a CLEAR SEARCH & FILTERS
// reset"). Dashed-border recipe matches the established app convention
// (components/browse/VirtualPosterGrid.module.css's own `.empty`).

import styles from "./RestrictedZoneEmptyState.module.css";

export function RestrictedZoneEmptyState({ onClear }: { onClear: () => void }): React.JSX.Element {
  return (
    <div className={styles.empty}>
      <p className={styles.message}>No items match your search and filters.</p>
      <button type="button" className={styles.clear} onClick={onClear}>
        Clear search &amp; filters
      </button>
    </div>
  );
}
