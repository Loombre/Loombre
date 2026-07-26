// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/ui/Toggle.tsx
//
// A boolean pill switch — new shared primitive (STATE.md Addendum A, lane
// S2's admin settings page needs it for boolean-schema entries; no such
// control existed in this design system before). Built under the existing
// tokens (--radius-pill, motion tokens, accent color) rather than a new
// pattern: a real <input type="checkbox" role="switch"> under the hood
// (native keyboard/AT support) with the pill visual layered via CSS —
// same "real control, custom paint" approach Input.tsx's TextInput takes.

import type { InputHTMLAttributes } from "react";
import styles from "./Toggle.module.css";

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}

export function Toggle({ checked, onChange, label, disabled, className, ...rest }: ToggleProps): React.JSX.Element {
  return (
    <label className={[styles.wrap, className].filter(Boolean).join(" ")} data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={styles.input}
        {...rest}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {label && <span className={styles.label}>{label}</span>}
    </label>
  );
}
