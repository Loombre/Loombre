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
//
// Item 1 (an upstream media server-study Wave A, radiogroup sweep): used to hand-roll
// role="tablist"/role="tab" markup — consolidated onto the shared
// ui/SegmentedControl, which owns the WAI-ARIA radiogroup + roving-
// tabindex + arrow-key behavior once. SeasonPillTabs.module.css's own
// `.track`/`.pill` (composed from SegmentedControl.module.css, with the
// mobile horizontal-scroll-strip override layered on top) are threaded
// through unchanged via className/segmentClassName — CSS Modules
// `composes` puts every class in the same className string regardless of
// which component rendered the element, so the `.track .pill` compound
// selector still resolves against SegmentedControl's own DOM structure.

import type { components } from "@loombre/sdk";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import styles from "./SeasonPillTabs.module.css";

type Season = components["schemas"]["Season"];

export interface SeasonPillTabsProps {
  seasons: Season[];
  selectedSeasonId: string;
  onSelect: (seasonId: string) => void;
}

export function SeasonPillTabs({ seasons, selectedSeasonId, onSelect }: SeasonPillTabsProps): React.JSX.Element {
  return (
    <SegmentedControl
      options={seasons.map((season) => ({ value: season.id, label: `Season ${season.seasonNumber}` }))}
      value={selectedSeasonId}
      onChange={onSelect}
      className={styles.track}
      segmentClassName={styles.pill}
      aria-label="Seasons"
    />
  );
}
