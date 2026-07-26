// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import styles from "./SegmentedControl.module.css";

export interface SegmentedControlProps {
  options: string[];
  defaultValue?: string;
  onChange?: (value: string) => void;
}

export function SegmentedControl({ options, defaultValue, onChange }: SegmentedControlProps): React.JSX.Element {
  const [active, setActive] = useState(defaultValue ?? options[0]);
  return (
    <div className={styles.track} role="tablist">
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
