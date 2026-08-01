// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/ChapterList.tsx
//
// STATE.md Stash run (S7/K9) — the chapter list SURFACE (shared content
// between PlayerControls' desktop popover and mobile BottomSheet, same
// split TrackPickers' content would need if it grew one — see
// PlayerControls.tsx for the breakpoint wiring). Deliberately its own file
// rather than folded into TrackPickers: chapters aren't a track/session
// concept (no PlaybackSession field backs them, no direct-play/HLS
// gating), just an ordered (title, startMs) list fetched once per item.

import { defaultFormatTime } from "./Scrubber.js";
import styles from "./ChapterList.module.css";

export interface ChapterListEntry {
  title: string;
  startMs: number;
}

export interface ChapterListProps {
  chapters: ChapterListEntry[];
  positionMs: number;
  onSelect: (startMs: number) => void;
}

/** The chapter currently playing: the LAST entry whose startMs has already
 *  passed (chapters arrive startMs-ascending from the API) — the same
 *  "which chapter am I in" rule every mainstream player highlights by.
 *  -1 (nothing highlighted) before the first chapter's own startMs. */
export function activeChapterIndex(chapters: ChapterListEntry[], positionMs: number): number {
  let active = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if ((chapters[i]?.startMs ?? Number.POSITIVE_INFINITY) <= positionMs) active = i;
    else break;
  }
  return active;
}

export function ChapterList({ chapters, positionMs, onSelect }: ChapterListProps): React.JSX.Element {
  const activeIndex = activeChapterIndex(chapters, positionMs);
  return (
    <ol className={styles.list}>
      {chapters.map((chapter, i) => (
        <li key={i}>
          <button
            type="button"
            className={styles.entry}
            data-active={i === activeIndex}
            onClick={() => onSelect(chapter.startMs)}
          >
            <span className={styles.time}>{defaultFormatTime(chapter.startMs)}</span>
            <span className={styles.title}>{chapter.title}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
