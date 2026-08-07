// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/ui/Select.tsx
//
// W5 (owner screenshot, Playback preferences): the preferred audio/subtitle
// language pickers were plain browser-native <select> elements — square
// corners, OS chrome, clashing with every other pill-shaped control in the
// Phosphor kit. This is the ONE reusable styled select the kit gets.
//
// Deliberately a REAL <select>, visually restyled (appearance: none + a
// custom chevron), not a styled-trigger-plus-custom-listbox rebuild: native
// semantics (keyboard, screen reader, OS autofill/search-as-you-type, touch
// scroll-wheel on mobile) come for free, and the review brief names this the
// preferred shape precisely because a custom listbox only "counts" with full
// keyboard/SR parity re-implemented by hand. The one thing native selects
// don't give up control of is the OPEN dropdown's own chrome (that's the
// OS's, cross-browser, unstyleable) — matches the review brief's accepted
// trade-off.

import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import styles from "./Select.module.css";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  /** Rendered as <option> children, in order — no caller-supplied JSX
   *  children (this wraps the element to always pair it with the chevron
   *  overlay, so the option list is the only thing left to hand in). */
  options: readonly SelectOption[];
}

export function Select({ className, options, ...rest }: SelectProps): React.JSX.Element {
  return (
    <div className={styles.wrapper}>
      <select className={[styles.select, className].filter(Boolean).join(" ")} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {/* Decorative only — the native control already announces its own
          open/closed affordance to assistive tech; this chevron is a purely
          visual stand-in for the OS's default one, hidden from the
          accessibility tree so it's never a second, redundant "expand"
          announcement. `pointer-events: none` (Select.module.css) keeps it
          from stealing the click a sighted mouse user aims at the control
          underneath. */}
      <span className={styles.chevron} aria-hidden="true">
        <Icon icon={ChevronDown} size="dense" />
      </span>
    </div>
  );
}
