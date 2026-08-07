// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/admin/settings/RegistryFilterBar.tsx
//
// Phosphor (design/phosphor/README.md §Screens → Settings tab 7 "Advanced
// Server": "a filter field, category pills with counts"; §Interactions →
// "Registry editing"). STATE.md Phosphor Wave-2 lane L6 scope item 1
// (desktop fidelity) + item 3 (mobile: same filter/pills, working narrow —
// U2 "one responsive tree", never a second mobile-only implementation).
//
// Two independent pieces of UI state live in the parent (AdminSettingsPage):
//   - `query` — free-text filter. Non-empty, it searches EVERY category's
//     keys at once (lib/settings-schema-widget.ts#filterEntriesByQuery
//     against key + description) — matches the prototype's regList
//     behavior exactly: a live query overrides category scoping rather
//     than combining with it. Clearing the query reverts to whatever
//     category was last selected.
//   - `activeCategory` — which single category's keys are visible when
//     there is no query. Kept even while a query is typed (so clearing it
//     returns to the same category, not a reset to the first one).
//
// Pill counts are `categorySummaries()` output — derived from the CURRENT
// schema entries every render, never cached/stored (STATE.md U9: "user and
// restricted-profile count... must be derived, not stored" is the named
// precedent this follows for every other derivable count in the app). The
// padlock glyph on a pill marks a category where EVERY key is scope
// 'env-only' (no UI-editable key exists in it at all).
//
// W15 (owner screenshot, Settings > Advanced Server): the category pills
// used to be a bespoke button forked straight into this file's own
// module.css — inconsistent heights (an icon-bearing pill grew taller than
// a label-only one) and an unstyled bare-number count. They now render
// through ui/Chip.tsx's FilterChip, the ONE interactive-chip primitive,
// so every pill in the row shares one height/padding/active recipe and the
// count reads as a real badge. The tab semantics (role, aria-selected)
// stay HERE, forwarded through via FilterChip's ...rest passthrough —
// FilterChip itself is agnostic to being inside a tablist.

import { Lock, Search } from "lucide-react";
import { Icon } from "../../icon/Icon.js";
import { FilterChip } from "../../ui/Chip.js";
import type { RegistryCategorySummary } from "../../../lib/settings-schema-widget.js";
import styles from "./RegistryFilterBar.module.css";

export interface RegistryFilterBarProps {
  categories: RegistryCategorySummary[];
  categoryLabels: Record<string, string>;
  activeCategory: string | null;
  onSelectCategory: (category: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

export function RegistryFilterBar({
  categories,
  categoryLabels,
  activeCategory,
  onSelectCategory,
  query,
  onQueryChange,
}: RegistryFilterBarProps): React.JSX.Element {
  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        <div className={styles.searchField}>
          <Icon icon={Search} size="dense" className={styles.searchIcon ?? ""} aria-hidden />
          <input
            type="text"
            inputMode="search"
            className={styles.searchInput}
            placeholder="Filter advanced keys…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            aria-label="Filter advanced keys"
          />
        </div>
        <div className={styles.pillRow} role="tablist" aria-label="Registry category">
          {categories.map((c) => (
            <FilterChip
              key={c.category}
              role="tab"
              aria-selected={activeCategory === c.category}
              active={activeCategory === c.category}
              count={c.count}
              onClick={() => onSelectCategory(c.category)}
              {...(c.allEnvOnly ? { icon: <Icon icon={Lock} size="dense" aria-hidden /> } : {})}
            >
              {categoryLabels[c.category] ?? c.category}
            </FilterChip>
          ))}
        </div>
      </div>
      <p className={styles.hint}>
        Environment pins win over the database · Stored values are kept, not lost · No setting can lock you out
      </p>
    </div>
  );
}
