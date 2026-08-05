// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/settings/remote-wizard/ChoiceCard.tsx
//
// R8's interview stage asks for "Phosphor choice cards" — no such primitive
// existed anywhere in the codebase (grepped; the closest precedent is
// AddUserSheet.tsx's role SegmentedControl, a text-pill picker, not a card).
// This is a plain radio-group of selectable cards: icon + label + optional
// description, one visually "selected" at a time. Local to this lane's
// wizard for now — promote to components/ui/ if a later feature wants the
// same shape.

import type { LucideIcon } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import styles from "./ChoiceCard.module.css";

export interface ChoiceCardOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: LucideIcon;
}

export interface ChoiceCardGroupProps<T extends string> {
  legend: string;
  options: readonly ChoiceCardOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
}

export function ChoiceCardGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
}: ChoiceCardGroupProps<T>): React.JSX.Element {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.cards} role="radiogroup" aria-label={legend}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            data-selected={value === opt.value}
            className={styles.card}
            onClick={() => onChange(opt.value)}
          >
            {opt.icon && (
              <span className={styles.cardIcon} aria-hidden="true">
                <Icon icon={opt.icon} />
              </span>
            )}
            <span className={styles.cardText}>
              <span className={styles.cardLabel}>{opt.label}</span>
              {opt.description && <span className={styles.cardDescription}>{opt.description}</span>}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
