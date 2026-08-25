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

import { useState } from "react";
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
  // d3-aq2 (verify-A/browser-player-F8): the viewer's own last choice, held
  // here because a pin is a REQUEST (`hls.nextLevel`) and `currentLevel` is
  // an OUTCOME — hls.js moves it only when it actually switches, which is
  // seconds later while playing and NEVER while paused. Checking
  // `currentLevel` therefore left a click with no visible effect at all:
  // aria-checked and the roving tabindex stayed on the old segment while
  // focus sat on the new one, and the "Currently X" note disappeared the
  // moment `autoMode` flipped — a dock showing no selection whatsoever.
  //
  // Declared before the early return below: hook order is unconditional.
  const [requestedValue, setRequestedValue] = useState<string | null>(null);

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

  // What hls.js has actually settled on — the pre-d3-aq2 checked value, and
  // still the answer whenever no request of the viewer's is outstanding.
  const settledValue = autoMode ? AUTO_VALUE : String(currentLevel);
  // A request stops being "outstanding" when hls.js reports it (the switch
  // landed), and is DROPPED when the player goes back to ABR on its own —
  // a recovery re-attach builds a fresh hls.js in auto mode, and a stale
  // pin must never keep claiming a level nobody is requesting any more.
  const pendingValue =
    requestedValue !== null && requestedValue !== settledValue && !(autoMode && requestedValue !== AUTO_VALUE) ? requestedValue : null;
  const checkedValue = pendingValue ?? settledValue;

  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Quality</span>
      <SegmentedControl
        aria-label="Quality"
        options={options}
        value={checkedValue}
        onChange={(value) => {
          setRequestedValue(value);
          onSelect(value === AUTO_VALUE ? -1 : Number(value));
        }}
      />
      {/* Neither Auto nor a not-yet-honoured pin is a black box: say which
          variant is playing RIGHT NOW whenever the checked segment doesn't
          already say it (ABR driving, or a pin hls.js hasn't switched to
          yet). Omitted once the checked segment IS the playing level. */}
      {current !== undefined && checkedValue !== String(currentLevel) && <span className={styles.note}>Currently {describeLevel(current)}</span>}
    </div>
  );
}
