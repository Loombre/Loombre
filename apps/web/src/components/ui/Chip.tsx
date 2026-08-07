// SPDX-License-Identifier: AGPL-3.0-only
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Chip.module.css";

export function Chip({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className={styles.chip}>{children}</span>;
}

// W15 (owner screenshot, Settings > Advanced Server): the registry's
// category filter pills were a bespoke, ad hoc button forked straight into
// RegistryFilterBar.module.css — no shared shape with anything else in the
// app, which is how they ended up at inconsistent heights (an optional
// leading icon made ITS pills taller than label-only ones; nothing pinned a
// shared height across a flex-wrap row's independently-stretched lines) and
// a count that was a bare, unstyled span rather than a real badge. This is
// the ONE interactive chip primitive for "a row of selectable filter
// pills, each with an optional leading glyph and a trailing count" —
// RegistryFilterBar is the first caller, but nothing here is registry-
// specific, so a future filter row (library kind, plugin status, etc.)
// extends this instead of forking its own again.
export interface FilterChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Selected/active visual state. Reuses SegmentedControl's amber-fill
   *  treatment (D-2's `[data-active="true"]` rule) verbatim via
   *  `[data-active]` here, so a selected chip and a selected segment read
   *  as the exact same "this is the active choice" language everywhere. */
  active?: boolean;
  /** Optional leading glyph (e.g. the registry's env-only Lock icon).
   *  Omitted, not `undefined`, by a caller with nothing to show —
   *  exactOptionalPropertyTypes (tsconfig.base.json) forbids the latter —
   *  so a label-only chip never reserves layout space for an icon it
   *  doesn't have, which is what let icon-bearing chips grow taller than
   *  their siblings in the first place. */
  icon?: ReactNode;
  /** Trailing count, rendered as ONE small muted pill inside the chip —
   *  never a caller's own bare number — so every chip's count reads
   *  identically regardless of call site. */
  count?: number;
}

export function FilterChip({ active, icon, count, children, className, ...rest }: FilterChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-active={active || undefined}
      className={[styles.filterChip, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {icon && <span className={styles.filterChipIcon}>{icon}</span>}
      <span className={styles.filterChipLabel}>{children}</span>
      {count !== undefined && <span className={styles.filterChipCount}>{count}</span>}
    </button>
  );
}

export function Tag({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className={styles.tag}>{children}</span>;
}

export function Badge({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className={styles.badge}>{children}</span>;
}
