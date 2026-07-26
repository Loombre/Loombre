// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/LibraryPills.tsx
//
// Real library filter (the one filter param the contract actually supports
// — GET /movies etc. take `libraryId`; see app/browse/page.tsx's header for
// why this is the only true server-side filter/sort control here).

"use client";

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
    <div className={styles.track} role="tablist" aria-label="Libraries">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === activeId}
          data-active={option.id === activeId}
          className={styles.segment}
          onClick={() => onSelect(option.id)}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}
