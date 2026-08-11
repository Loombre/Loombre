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
// padlock glyph on a pill marks a category that contains AT LEAST ONE key
// scoped 'env-only' — LD-9 (owner screenshot): this used to require EVERY
// key in the category to be env-only, which silently dropped the padlock
// from a mixed category like "network" (env-only http.port/
// network.corsOrigins alongside ui-scope network.publicUrl/
// network.trustProxy) even though it genuinely holds a key nobody can edit
// here. `hasEnvOnlyKey` (lib/settings-schema-widget.ts#categorySummaries)
// is the single source of that condition — never re-derived here.
//
// LD-10 (owner screenshot): the pill row itself is sorted alphabetically by
// its displayed label — the ONLY ordering rule for this row (categories
// prop arrives in registry/first-seen order from categorySummaries(), which
// every OTHER consumer, e.g. the category section list, keeps unchanged;
// this component alone re-sorts for its own display, right before mapping,
// rather than inventing a second ordering utility elsewhere).
//
// W15 (owner screenshot, Settings > Advanced Server): the category pills
// used to be a bespoke button forked straight into this file's own
// module.css — inconsistent heights (an icon-bearing pill grew taller than
// a label-only one) and an unstyled bare-number count. They now render
// through ui/Chip.tsx's FilterChip, the ONE interactive-chip primitive,
// so every pill in the row shares one height/padding/active recipe and the
// count reads as a real badge. The radio semantics (role, aria-checked,
// roving tabindex, arrow-key nav) stay HERE, forwarded through via
// FilterChip's ...rest passthrough — FilterChip itself is agnostic to
// being inside a radiogroup.
//
// Item 1 (Wave A, radiogroup sweep): used to be
// role="tablist"/role="tab" with no keyboard support beyond plain Tab —
// rebuilt on the WAI-ARIA APG Radio Group pattern (same law as
// ui/SegmentedControl.tsx, applied directly here rather than consolidated
// onto it — FilterChip's icon/count decoration is a different shape than
// a plain segment label). Keyboard movement queries the DOM by role
// rather than tracking refs per pill: FilterChip is a plain function
// component (not React.forwardRef), so a ref array isn't available here
// the way it is for SegmentedControl's own native <button>s.

import { useCallback } from "react";
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
  // LD-10: alphabetical by displayed label (case-insensitive) — the sole
  // ordering rule for this row. A fresh array (never mutates the `categories`
  // prop, whose own registry-order identity other consumers may still rely
  // on) sorted immediately before render.
  const sortedCategories = [...categories].sort((a, b) =>
    (categoryLabels[a.category] ?? a.category).localeCompare(categoryLabels[b.category] ?? b.category),
  );

  const activeIndex = Math.max(
    0,
    sortedCategories.findIndex((c) => c.category === activeCategory),
  );

  const focusAndSelect = useCallback(
    (index: number, container: HTMLElement) => {
      const target = sortedCategories[index];
      if (!target) return;
      const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
      radios[index]?.focus();
      onSelectCategory(target.category);
    },
    [sortedCategories, onSelectCategory],
  );

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const container = event.currentTarget.closest('[role="radiogroup"]');
    if (!container) return;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        focusAndSelect((index + 1) % sortedCategories.length, container as HTMLElement);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        focusAndSelect((index - 1 + sortedCategories.length) % sortedCategories.length, container as HTMLElement);
        break;
      case "Home":
        event.preventDefault();
        focusAndSelect(0, container as HTMLElement);
        break;
      case "End":
        event.preventDefault();
        focusAndSelect(sortedCategories.length - 1, container as HTMLElement);
        break;
      default:
        break;
    }
  }

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
        <div className={styles.pillRow} role="radiogroup" aria-label="Registry category">
          {sortedCategories.map((c, index) => (
            <FilterChip
              key={c.category}
              role="radio"
              aria-checked={activeCategory === c.category}
              tabIndex={index === activeIndex ? 0 : -1}
              active={activeCategory === c.category}
              count={c.count}
              onClick={() => onSelectCategory(c.category)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              {...(c.hasEnvOnlyKey ? { icon: <Icon icon={Lock} size="dense" aria-hidden /> } : {})}
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
