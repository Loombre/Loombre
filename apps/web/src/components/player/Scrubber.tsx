// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/Scrubber.tsx
//
// Pill scrubber with buffered ranges + hover time preview (P2.7/P2.9/P2.10
// task spec). Shared by the video player's control bar AND the music mini
// player (components/music/MiniPlayerBar.tsx) — both are this lane's, so
// sharing it is coordination-free. Pointer-driven (not native <input
// type="range">) so buffered-range rendering + a floating time-preview
// tooltip can sit on the same track; drag physics are simple linear
// pointer-position math (motion lib is reserved for scrubber PHYSICS per
// P2.10 — this is a direct 1:1 drag, no spring/inertia needed, so plain
// pointer events keep it inside the JS budget).

import { useCallback, useRef, useState } from "react";
import styles from "./Scrubber.module.css";

export interface BufferedRange {
  startMs: number;
  endMs: number;
}

/** The one field the track needs to draw a tick (S7/K9 chapter markers) —
 *  deliberately narrower than the SDK's ChapterMarker (no title/source):
 *  this component only ever positions a mark, never renders label text on
 *  the track itself (PlayerControls' chapter list surfaces the title). */
export interface ChapterTick {
  startMs: number;
}

export interface ScrubberProps {
  positionMs: number;
  durationMs: number | null;
  buffered?: BufferedRange[];
  /** S7/K9: chapter marker ticks drawn on the rail. Omitted/empty renders
   *  no ticks at all — zero chapters means zero UI (mission spec), same as
   *  every other optional overlay this track draws. */
  chapters?: ChapterTick[];
  onSeek: (ms: number) => void;
  formatTime?: (ms: number) => string;
}

/** One arrow-key press, in ms — deliberately the same amount
 *  PlayerControls' skip buttons ("Back/Forward 10 seconds") and
 *  VideoPlayer's window-level arrow shortcut move (d3-aq1). */
const KEYBOARD_STEP_MS = 10_000;

export function defaultFormatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function Scrubber({
  positionMs,
  durationMs,
  buffered = [],
  chapters = [],
  onSeek,
  formatTime = defaultFormatTime,
}: ScrubberProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // V8 (docs/PLAYBACK.md §9.1.9 "Scrubber commits ONE seek on pointerup"):
  // dragging updates this PREVIEW position only — the played bar, handle
  // and aria values track it live — and exactly one onSeek fires on
  // release. The pre-V8 per-pointermove commit issued dozens of seeks (and
  // heartbeat flushes) per drag; under the hard-seek model each one could
  // be a server round-trip.
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const duration = durationMs ?? 0;
  const shownMs = dragMs ?? positionMs;
  const playedPercent = duration > 0 ? Math.min(100, (shownMs / duration) * 100) : 0;

  const msAtClientX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || duration <= 0) return 0;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration],
  );

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (duration <= 0) return;
    (event.target as Element).setPointerCapture(event.pointerId);
    setDragging(true);
    setDragMs(msAtClientX(event.clientX));
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect) setHoverX(Math.min(rect.width, Math.max(0, event.clientX - rect.left)));
    if (dragging) setDragMs(msAtClientX(event.clientX));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragging) {
      onSeek(msAtClientX(event.clientX));
      setDragging(false);
      setDragMs(null);
    }
  }

  function handlePointerCancel(): void {
    // A cancelled drag (capture lost, touch interrupted) commits nothing —
    // the preview snaps back to the real position.
    setDragging(false);
    setDragMs(null);
  }

  // d3-aq1 (verify/browser-player-F4): the rail OWNS the arrow keys while it
  // is the focused control. Before this, one ArrowRight moved 15 s — this
  // handler's own step AND VideoPlayer's window-level keydown shortcut
  // (which only skips INPUT/TEXTAREA) both fired off the same keypress, i.e.
  // two competing seeks, two POST /seek. Stopping propagation for the keys
  // handled here — and ONLY those: an unhandled key must still reach the
  // player's Space/f/m shortcuts — leaves exactly one seek per keypress.
  //
  // The step is the SAME ±10 s PlayerControls' skip buttons and that window
  // shortcut use (LD-12(b): "keyboard and click must always agree on the
  // actual amount"); the pre-fix ±5 s here meant focusing the rail silently
  // changed how far an arrow key moved.
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // Nothing to seek within: no duration means no target to compute, so the
    // key was NOT handled here and must keep bubbling.
    if (duration <= 0) return;
    if (event.key === "ArrowRight") onSeek(Math.min(duration, positionMs + KEYBOARD_STEP_MS));
    else if (event.key === "ArrowLeft") onSeek(Math.max(0, positionMs - KEYBOARD_STEP_MS));
    else return;
    event.stopPropagation();
  }

  const hoverMs = hoverX !== null && trackRef.current ? (hoverX / trackRef.current.getBoundingClientRect().width) * duration : null;

  return (
    <div
      ref={trackRef}
      className={styles.track}
      data-dragging={dragging}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={shownMs}
      aria-valuetext={formatTime(shownMs)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={() => setHoverX(null)}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.rail}>
        {buffered.map((range, i) =>
          duration > 0 ? (
            <div
              key={i}
              className={styles.buffered}
              style={{
                left: `${(range.startMs / duration) * 100}%`,
                width: `${((range.endMs - range.startMs) / duration) * 100}%`,
              }}
            />
          ) : null,
        )}
        <div className={styles.played} style={{ width: `${playedPercent}%` }} />
        {duration > 0 &&
          chapters
            // A marker AT 0 or AT the very end has nothing meaningful to
            // divide (no preceding/following segment to mark the boundary
            // of) — real fixtures (seed.mjs's "Opening" at startMs 0) would
            // otherwise draw a tick flush against the track's own rounded
            // end-cap, reading as a stray pixel rather than a chapter mark.
            .filter((c) => c.startMs > 0 && c.startMs < duration)
            .map((c, i) => <div key={i} className={styles.chapterTick} style={{ left: `${(c.startMs / duration) * 100}%` }} />)}
      </div>
      <div className={styles.handle} style={{ left: `${playedPercent}%` }} />
      {hoverX !== null && hoverMs !== null && (
        <div className={styles.hoverPreview} style={{ left: hoverX }}>
          {formatTime(hoverMs)}
        </div>
      )}
    </div>
  );
}
