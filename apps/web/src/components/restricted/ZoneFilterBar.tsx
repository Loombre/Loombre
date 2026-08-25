// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZoneFilterBar.tsx
//
// STATE.md Stash run (S9): /restricted/browse's filter bar — performers/
// studios/genres pickers, rating, duration bands, resolution, year, all
// combinable (matches packages/db/src/query/restricted-browse.ts's own
// AND-combined filter params 1:1). A disclosure panel behind a single
// "Filters" toggle (mobile: same panel, full-width — one responsive tree,
// CSS-only reflow, no separate mobile branch) rather than always-visible
// controls: the zone's filter surface is wide (7 independent facets) and
// would otherwise dominate the toolbar on every viewport.
//
// browser-restricted-settings-F7 (QA 2026-08-20/21): the panel used to
// FLOAT (position:absolute, z-index 20; a position:fixed bottom sheet
// under 768px) and had exactly one way to close — the toggle. Floating
// over the results meant that when the filters emptied the grid, the
// panel's rect covered RestrictedZoneEmptyState's "Clear search &
// filters" remedy and swallowed the click. It is now a true disclosure:
// it sits IN FLOW under the toggle row and pushes the results down (see
// ZoneControls.module.css `.filterPanel`), so it can never cover the
// remedy at any viewport, and it dismisses on Escape or an outside press
// like every other popover here (components/settings/RowMenu.tsx,
// components/shell/UserMenu.tsx). Reopen follow-up (2026-08-24): the
// outside press dismisses on its completed CLICK, never at pointerdown —
// an in-flow panel collapsing at pointerdown reflows the page while the
// press is still in flight, so the remedy below it jumped up under the
// held pointer and the click retargeted to the shell (the same
// user-visible symptom back through a new mechanism).
//
// Picker OPTIONS come from the caller (already-fetched performer/studio/
// genre lists — see app/restricted/browse/page.tsx for where those come
// from, including the genre list's GET /tags?kind=genre reuse, since there
// is no dedicated "list zone genres" endpoint and the general tags read
// already returns restricted-class rows to a cleared viewer).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { useEscapeKey } from "../ui/overlay-hooks.js";
import {
  ZONE_RESOLUTION_BANDS,
  type ZoneBrowseFilters,
  type ZoneResolutionBand,
} from "../../lib/zone-browse-filters.js";
import styles from "./ZoneControls.module.css";

export interface ZoneFilterOption {
  id: string;
  name: string;
}

export interface ZoneFilterBarProps {
  filters: ZoneBrowseFilters;
  onChange: (filters: ZoneBrowseFilters) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  performers: ZoneFilterOption[];
  studios: ZoneFilterOption[];
  genres: ZoneFilterOption[];
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

function toggleBand(bands: ZoneResolutionBand[], band: ZoneResolutionBand): ZoneResolutionBand[] {
  return bands.includes(band) ? bands.filter((b) => b !== band) : [...bands, band];
}

function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function OptionChecklist({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: ZoneFilterOption[];
  selected: string[];
  onToggle: (id: string) => void;
}): React.JSX.Element {
  if (options.length === 0) return <></>;
  return (
    <fieldset className={styles.filterGroup}>
      <legend className={styles.filterLegend}>{label}</legend>
      <div className={styles.checklist}>
        {options.map((opt) => (
          <label key={opt.id} className={styles.checklistRow}>
            <input
              type="checkbox"
              checked={selected.includes(opt.id)}
              onChange={() => onToggle(opt.id)}
            />
            <span>{opt.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ZoneFilterBar({
  filters,
  onChange,
  onClear,
  hasActiveFilters,
  performers,
  studios,
  genres,
}: ZoneFilterBarProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Escape returns focus to the toggle (the keyboard user is still "at"
  // the filter bar); an outside press deliberately does not — the pointer
  // is already somewhere else and stealing focus back would fight it.
  const closeFromKeyboard = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);

  useEscapeKey(open, closeFromKeyboard);

  useEffect(() => {
    if (!open) return undefined;
    // `click`, NOT `pointerdown` (RowMenu/UserMenu dismiss their FLOATING
    // menus at press-start; those never reflow anything). This panel sits
    // in flow, so collapsing it at pointerdown reflows the page while the
    // user's press is still in flight: whatever sat below the panel — the
    // filtered-empty state's "Clear search & filters" remedy in the F7
    // repro — jumps up under the held pointer, pointerup + click retarget
    // to the shell, and the intended activation never fires. `click`
    // dispatches only once the press COMPLETES (mouse, touch tap and pen
    // alike), with layout untouched throughout, so the pressed control's
    // own handler runs first and the panel closes right after. Opening is
    // safe from self-dismissal twice over: the toggle lives inside barRef,
    // and this effect (hence the listener) attaches only after the opening
    // click has finished dispatching.
    function onClickOutside(event: Event): void {
      const bar = barRef.current;
      if (bar && !bar.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, [open]);

  return (
    <div className={styles.filterBar} ref={barRef}>
      <div className={styles.filterBarRow}>
        <button
          type="button"
          ref={toggleRef}
          className={styles.filterToggle}
          data-active={hasActiveFilters}
          aria-expanded={open}
          {...(open ? { "aria-controls": panelId } : {})}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon icon={SlidersHorizontal} size="dense" />
          Filters
        </button>
        {hasActiveFilters && (
          <button type="button" className={styles.clearFiltersInline} onClick={onClear}>
            <Icon icon={X} size="dense" />
            Clear filters
          </button>
        )}
      </div>

      {open && (
        <div className={styles.filterPanel} id={panelId}>
          <OptionChecklist
            label="Performers"
            options={performers}
            selected={filters.performerIds}
            onToggle={(id) => onChange({ ...filters, performerIds: toggleId(filters.performerIds, id) })}
          />
          <OptionChecklist
            label="Studios"
            options={studios}
            selected={filters.studioTagIds}
            onToggle={(id) => onChange({ ...filters, studioTagIds: toggleId(filters.studioTagIds, id) })}
          />
          <OptionChecklist
            label="Genres"
            options={genres}
            selected={filters.tagIds}
            onToggle={(id) => onChange({ ...filters, tagIds: toggleId(filters.tagIds, id) })}
          />

          <fieldset className={styles.filterGroup}>
            <legend className={styles.filterLegend}>Resolution</legend>
            <div className={styles.bandRow}>
              {ZONE_RESOLUTION_BANDS.map((band) => (
                <button
                  key={band}
                  type="button"
                  className={styles.bandChip}
                  data-active={filters.resolution.includes(band)}
                  onClick={() => onChange({ ...filters, resolution: toggleBand(filters.resolution, band) })}
                >
                  {band}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.filterGroup}>
            <legend className={styles.filterLegend}>Rating</legend>
            <div className={styles.rangeRow}>
              <input
                type="number"
                min={0}
                max={10}
                placeholder="Min"
                className={styles.rangeInput}
                value={filters.ratingMin ?? ""}
                onChange={(e) => onChange({ ...filters, ratingMin: numberOrUndefined(e.target.value) })}
              />
              <span className={styles.rangeSep}>–</span>
              <input
                type="number"
                min={0}
                max={10}
                placeholder="Max"
                className={styles.rangeInput}
                value={filters.ratingMax ?? ""}
                onChange={(e) => onChange({ ...filters, ratingMax: numberOrUndefined(e.target.value) })}
              />
            </div>
          </fieldset>

          <fieldset className={styles.filterGroup}>
            <legend className={styles.filterLegend}>Duration (min)</legend>
            <div className={styles.rangeRow}>
              <input
                type="number"
                min={0}
                placeholder="Min"
                className={styles.rangeInput}
                value={filters.durationMinMinutes ?? ""}
                onChange={(e) => onChange({ ...filters, durationMinMinutes: numberOrUndefined(e.target.value) })}
              />
              <span className={styles.rangeSep}>–</span>
              <input
                type="number"
                min={0}
                placeholder="Max"
                className={styles.rangeInput}
                value={filters.durationMaxMinutes ?? ""}
                onChange={(e) => onChange({ ...filters, durationMaxMinutes: numberOrUndefined(e.target.value) })}
              />
            </div>
          </fieldset>

          <fieldset className={styles.filterGroup}>
            <legend className={styles.filterLegend}>Year</legend>
            <div className={styles.rangeRow}>
              <input
                type="number"
                placeholder="Min"
                className={styles.rangeInput}
                value={filters.yearMin ?? ""}
                onChange={(e) => onChange({ ...filters, yearMin: numberOrUndefined(e.target.value) })}
              />
              <span className={styles.rangeSep}>–</span>
              <input
                type="number"
                placeholder="Max"
                className={styles.rangeInput}
                value={filters.yearMax ?? ""}
                onChange={(e) => onChange({ ...filters, yearMax: numberOrUndefined(e.target.value) })}
              />
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
