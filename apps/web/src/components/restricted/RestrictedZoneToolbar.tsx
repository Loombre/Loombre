// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/RestrictedZoneToolbar.tsx
//
// The zone's OWN query toolbar (design/phosphor/README.md "Interactions ->
// Restricted content"): "Search this zone… field, genre pills derived from
// the zone's titles [...], 4K/HDR toggle chips, and the same cycling sort
// as Browse [...]. Active genre/filter chips fill amber (#E0A548 with dark
// text), not accent [...]. A mono readout reads N OF TOTAL · SORT ·
// ZONE-ONLY INDEX; an empty result shows a dashed empty state with a CLEAR
// SEARCH & FILTERS reset. On mobile the toolbar is a 44px search row + one
// horizontally scrolling pill row (genres · divider · filters · sort)".
//
// ALL state here is owned by the caller (app/restricted/page.tsx) via
// lib/restricted-zone-toolbar.ts's pure ZoneToolbarState — this component
// never touches components/browse/** state (U10 hard line: zone state
// never touches the general library's search/filter state). The single
// row below (search field aside) is deliberately ONE flex row with
// horizontal scroll at every width, not a desktop-only wrapped layout —
// that is simultaneously the literal mobile spec and a perfectly
// reasonable desktop presentation, so one markup shape serves both (U2).

import { SearchField } from "../ui/Input.js";
import {
  ZONE_SORT_LABELS,
  cycleZoneSort,
  zoneReadout,
  type ZoneToolbarState,
} from "../../lib/restricted-zone-toolbar.js";
import styles from "./RestrictedZoneToolbar.module.css";

export interface RestrictedZoneToolbarProps {
  state: ZoneToolbarState;
  onChange: (next: ZoneToolbarState) => void;
  genres: string[];
  filteredCount: number;
  totalCount: number;
}

export function RestrictedZoneToolbar({
  state,
  onChange,
  genres,
  filteredCount,
  totalCount,
}: RestrictedZoneToolbarProps): React.JSX.Element {
  function setGenre(genre: string | null): void {
    onChange({ ...state, genre });
  }

  function toggle4k(): void {
    onChange({ ...state, only4k: !state.only4k });
  }

  function toggleHdr(): void {
    onChange({ ...state, onlyHdr: !state.onlyHdr });
  }

  function advanceSort(): void {
    onChange({ ...state, sort: cycleZoneSort(state.sort) });
  }

  return (
    <div className={styles.toolbar}>
      <div className={styles.searchRow}>
        <SearchField
          placeholder="Search this zone…"
          value={state.search}
          onChange={(e) => onChange({ ...state, search: e.target.value })}
          aria-label="Search this zone"
        />
      </div>

      <div className={styles.pillRow}>
        <button type="button" className={styles.pill} data-active={state.genre === null} onClick={() => setGenre(null)}>
          All
        </button>
        {genres.map((genre) => (
          <button
            key={genre}
            type="button"
            className={styles.pill}
            data-active={state.genre === genre}
            onClick={() => setGenre(state.genre === genre ? null : genre)}
          >
            {genre}
          </button>
        ))}

        <span className={styles.divider} aria-hidden="true" />

        <button type="button" className={styles.pill} data-active={state.only4k} aria-pressed={state.only4k} onClick={toggle4k}>
          4K
        </button>
        <button type="button" className={styles.pill} data-active={state.onlyHdr} aria-pressed={state.onlyHdr} onClick={toggleHdr}>
          HDR
        </button>

        <span className={styles.divider} aria-hidden="true" />

        <button type="button" className={styles.sortChip} onClick={advanceSort} aria-label={`Sort: ${ZONE_SORT_LABELS[state.sort]}. Tap to change.`}>
          {ZONE_SORT_LABELS[state.sort]}
        </button>
      </div>

      <div className={styles.readout}>{zoneReadout(filteredCount, totalCount, state.sort)}</div>
    </div>
  );
}
