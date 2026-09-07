// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/VersionPicker.tsx
//
// The player's Version popover — one row per media_files row of the item
// (lib/version-options.ts builds them), same visual grammar as
// TrackPickers (shared stylesheet, same button-list pattern) because it
// answers the same question as Audio/Subtitles: "which underlying stream
// am I getting". Unlike those it is NOT a client-side switch: picking a
// version is a real session change (new file -> new plan), which the
// caller performs by navigating (see versionSwitchHref).

import type { VersionOption } from "../../lib/version-options.js";
import styles from "./TrackPickers.module.css";

export interface VersionPickerProps {
  versions: VersionOption[];
  onSelect: (mediaFileId: string) => void;
}

export function VersionPicker({ versions, onSelect }: VersionPickerProps): React.JSX.Element {
  return (
    <div className={styles.group} role="group" aria-label="Version">
      <span className={styles.groupLabel}>Version</span>
      {versions.map((version) => (
        <button
          key={version.id}
          type="button"
          className={styles.option}
          data-active={version.isCurrent}
          aria-current={version.isCurrent ? "true" : undefined}
          onClick={() => {
            if (!version.isCurrent) onSelect(version.id);
          }}
        >
          <span>
            {version.label}
            {version.isDefault ? " (default)" : ""}
          </span>
          {version.detail && <span className={styles.optionMeta}>{version.detail}</span>}
        </button>
      ))}
    </div>
  );
}
