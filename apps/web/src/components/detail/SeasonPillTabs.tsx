// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/SeasonPillTabs.tsx
//
// Series-detail season switcher (design/phosphor/README.md "Series detail":
// "season pill tabs"). Replaces the pre-Phosphor per-season <details>
// disclosure (the old SeasonSection.tsx, now unused — deleted in the same
// change, see STATE.md freeze notes) with the prototype's segmented pill
// row: every season is a pill inside one track, the active one filled
// accent-on-dark, switching is instant because SeriesDetailScreen.tsx
// fetches every season's episodes eagerly up front (bounded — see that
// file's header) rather than lazily per-tab.

import type { components } from "@loombre/sdk";
import styles from "./SeasonPillTabs.module.css";

type Season = components["schemas"]["Season"];

export interface SeasonPillTabsProps {
  seasons: Season[];
  selectedSeasonId: string;
  onSelect: (seasonId: string) => void;
}

export function SeasonPillTabs({ seasons, selectedSeasonId, onSelect }: SeasonPillTabsProps): React.JSX.Element {
  return (
    <div className={styles.track} role="tablist" aria-label="Seasons">
      {seasons.map((season) => (
        <button
          key={season.id}
          type="button"
          role="tab"
          aria-selected={season.id === selectedSeasonId}
          className={styles.pill}
          data-active={season.id === selectedSeasonId}
          onClick={() => onSelect(season.id)}
        >
          Season {season.seasonNumber}
        </button>
      ))}
    </div>
  );
}
