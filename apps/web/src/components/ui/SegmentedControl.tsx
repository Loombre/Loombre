// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import styles from "./SegmentedControl.module.css";

export interface SegmentedControlProps {
  options: string[];
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** D-2 (STATE.md W2+W3): the track hugs its segments (fit-content) by
   *  default — never stretches to fill the container. Pass true only when
   *  a caller deliberately wants the track to fill available width. */
  fullWidth?: boolean;
}

export function SegmentedControl({
  options,
  defaultValue,
  onChange,
  fullWidth,
}: SegmentedControlProps): React.JSX.Element {
  const [active, setActive] = useState(defaultValue ?? options[0]);
  return (
    <div className={styles.track} data-full-width={fullWidth || undefined} role="tablist">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={option === active}
          data-active={option === active}
          className={styles.segment}
          onClick={() => {
            setActive(option);
            onChange?.(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
