// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/QualitySelector.tsx
//
// Wave C2 (docs/PLAYBACK.md §9.1.9) — the ONE new piece of player UI the
// multi-variant model ships, and deliberately the whole of it: "Manual
// quality selection is a client-side affordance over the same mechanism: a
// player-UI selector listing `hls.levels` and setting `hls.nextLevel` (pin)
// or `-1` (auto). No server surface — a manual pin is just a `v{K}` request
// stream like any other."
//
// So this component fetches nothing, knows no session id, and has no
// endpoint. It moves `nextLevel`; hls.js then requests `v{K}/...`; the
// server reads the path as a switch signal and hands the session's existing
// admission slot to that rung (LD-16). Every one of those steps already
// existed before this file.
//
// INDICES ARE hls.js's, NOT the display order. hls.js sorts variants by
// bandwidth ASCENDING, and `nextLevel` indexes into that list. A quality
// menu reads best-first, so the two orders are reversed relative to each
// other — reporting a display position would pin the wrong variant (and,
// because a switch is a full server-side pipeline handoff, pay real CPU to
// do it).
//
// Built on ui/SegmentedControl (the Wave A radiogroup sweep): mutually
// exclusive options, role="radiogroup"/role="radio" + aria-checked, one
// segment in the tab order at a time, arrow keys moving focus AND
// selection, Home/End to the ends. A quality picker is exactly a radio
// group, and re-implementing that keyboard contract here would be a second
// copy to drift.

import { SegmentedControl } from "../ui/SegmentedControl.js";
import styles from "./QualitySelector.module.css";

/** The subset of hls.js's `Level` this UI reads. Declared structurally so
 *  this component never imports hls.js — the whole player keeps hls.js
 *  behind VideoPlayer's single dynamic import. */
export interface QualityLevel {
  /** The variant's `RESOLUTION` height, or 0 when the master declared none
   *  (an audio-only session's single variant). */
  height: number;
  /** The variant's `BANDWIDTH`, in bits/s. */
  bitrate: number;
}

const AUTO_VALUE = "auto";

/** How a viewer recognises a variant: by height. A master with no
 *  RESOLUTION (audio-only) has no height to show, so it falls back to the
 *  bitrate rather than rendering a bare "0p". */
export function describeLevel(level: QualityLevel): string {
  if (level.height > 0) return `${level.height}p`;
  return `${Math.round(level.bitrate / 1000)} kbps`;
}

export interface QualitySelectorProps {
  /** hls.js's own `hls.levels`, in ITS order (ascending bandwidth). */
  levels: QualityLevel[];
  /** hls.js's `hls.currentLevel` — the level actually playing right now,
   *  whether it was pinned or chosen by ABR. */
  currentLevel: number;
  /** True while `hls.autoLevelEnabled` (i.e. `nextLevel === -1`). */
  autoMode: boolean;
  /** Receives an hls.js level INDEX, or -1 for auto. The caller assigns it
   *  to `hls.nextLevel` — no other side effect exists. */
  onSelect: (level: number) => void;
}

export function QualitySelector({ levels, currentLevel, autoMode, onSelect }: QualitySelectorProps): React.JSX.Element | null {
  // Nothing to choose between: a direct-play session (no hls.js at all), or
  // a single-variant master — which is exactly what a ladder-empty HLS
  // session renders (§9.1.1). Showing a one-option "picker" would be a
  // control that cannot do anything.
  if (levels.length < 2) return null;

  // Highest first, which is how a quality menu reads. The `value` carries
  // the hls.js index so the display order can never leak into what gets
  // pinned.
  const options = [
    { value: AUTO_VALUE, label: "Auto" },
    ...levels
      .map((level, index) => ({ value: String(index), label: describeLevel(level) }))
      .reverse(),
  ];

  const current = levels[currentLevel];

  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Quality</span>
      <SegmentedControl
        aria-label="Quality"
        options={options}
        value={autoMode ? AUTO_VALUE : String(currentLevel)}
        onChange={(value) => onSelect(value === AUTO_VALUE ? -1 : Number(value))}
      />
      {/* Auto is not a black box: while ABR is driving, say which variant
          it actually settled on. Omitted when a level is pinned, where the
          checked segment already says it. */}
      {autoMode && current !== undefined && <span className={styles.note}>Currently {describeLevel(current)}</span>}
    </div>
  );
}
