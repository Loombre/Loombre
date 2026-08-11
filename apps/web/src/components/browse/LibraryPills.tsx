// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/LibraryPills.tsx
//
// Real library filter (the one filter param the contract actually supports
// — GET /movies etc. take `libraryId`; see app/browse/page.tsx's header for
// why this is the only true server-side filter/sort control here).
//
// Item 1 (an upstream media server-study Wave A, radiogroup sweep): used to hand-roll
// role="tablist"/role="tab" markup — consolidated onto the shared
// ui/SegmentedControl, which owns the WAI-ARIA radiogroup + roving-
// tabindex + arrow-key behavior once instead of every implementation
// re-deriving it. LibraryPills.module.css's own `.track`/`.segment`
// (composed from SegmentedControl.module.css) are threaded through
// unchanged via className/segmentClassName.

"use client";

import { SegmentedControl } from "../ui/SegmentedControl.js";
import styles from "./LibraryPills.module.css";

export interface LibraryOption {
  id: string;
  name: string;
}

export interface LibraryPillsProps {
  options: LibraryOption[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function LibraryPills({ options, activeId, onSelect }: LibraryPillsProps): React.JSX.Element {
  return (
    <SegmentedControl
      options={options.map((option) => ({ value: option.id, label: option.name }))}
      value={activeId ?? undefined}
      onChange={onSelect}
      className={styles.track}
      segmentClassName={styles.segment}
      aria-label="Libraries"
    />
  );
}
