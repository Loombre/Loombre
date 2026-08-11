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
//
// Item 1 (Wave A, radiogroup sweep): used to hand-roll
// role="tablist"/role="tab" markup — consolidated onto the shared
// ui/SegmentedControl, which owns the WAI-ARIA radiogroup + roving-
// tabindex + arrow-key behavior once. ZoneControls.module.css's
// `.sortTrack`/`.sortSegment` (composed from SegmentedControl.module.css,
// warning tone layered on top) are threaded through unchanged via
// className/segmentClassName.

import { SegmentedControl } from "../ui/SegmentedControl.js";
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
    <SegmentedControl
      options={ZONE_SORT_OPTIONS.map((option) => ({ value: option.value as string, label: option.label }))}
      value={active}
      onChange={(value) => onChange(value as ZoneSort)}
      className={styles.sortTrack}
      segmentClassName={styles.sortSegment}
      aria-label="Sort"
    />
  );
}
