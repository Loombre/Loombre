// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/music/QueueDrawer.tsx
//
// Add/remove/reorder + jump-to for the music queue (P2.5). Reorder uses
// simple up/down buttons rather than drag-and-drop physics — P2.10 reserves
// the motion library budget for scrubber physics + shared-element polish,
// not a full DnD implementation, and up/down is fully keyboard-operable
// (accessibility win over a mouse-only drag handle) for the same JS cost.
//
// H14 fix (Phosphor Wave-3, design/phosphor/README.md "Music": "the current
// track cannot be removed"): the remove button used to have no guard at all
// — removing the entry the queue's own `currentIndex` was pointing at would
// leave the reducer's index math to sort itself out on the next tick rather
// than being an explicit rule here. `currentIndex` already comes straight
// from the real MusicPlayerProvider queue state (lib/queue.ts), so this is
// disabled (not hidden — the row keeps its layout), matching QueueDrawer's
// existing up/down-at-the-boundary convention (same
// `.rowActionButton:disabled` opacity-0.3 recipe already in
// QueueDrawer.module.css).

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { defaultFormatTime } from "../player/Scrubber.js";
import { useMusicPlayer } from "./MusicPlayerProvider.js";
import styles from "./QueueDrawer.module.css";

export function QueueDrawer(): React.JSX.Element | null {
  const player = useMusicPlayer();
  if (!player.queueDrawerOpen) return null;

  const { items, currentIndex } = player.queueState;

  return (
    <div className={styles.drawer} role="dialog" aria-label="Up next">
      <div className={styles.heading}>
        <span>Queue</span>
        <button
          type="button"
          className={styles.rowActionButton}
          aria-label="Close queue"
          onClick={player.closeQueueDrawer}
        >
          <Icon icon={X} size="dense" />
        </button>
      </div>
      {items.length === 0 ? (
        <div className={styles.empty}>Nothing queued.</div>
      ) : (
        items.map((track, index) => (
          <div key={track.entryId} className={styles.row} data-current={index === currentIndex}>
            <button type="button" className={styles.rowMain} onClick={() => player.jumpTo(track.entryId)}>
              <span className={styles.rowTitle}>{track.title}</span>
              <span className={styles.rowSubtitle}>
                {track.subtitle ?? ""}
                {track.durationMs !== null ? ` · ${defaultFormatTime(track.durationMs)}` : ""}
              </span>
            </button>
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.rowActionButton}
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => player.reorderQueue(index, index - 1)}
              >
                <Icon icon={ChevronUp} size="dense" />
              </button>
              <button
                type="button"
                className={styles.rowActionButton}
                aria-label="Move down"
                disabled={index === items.length - 1}
                onClick={() => player.reorderQueue(index, index + 1)}
              >
                <Icon icon={ChevronDown} size="dense" />
              </button>
              <button
                type="button"
                className={styles.rowActionButton}
                aria-label="Remove from queue"
                disabled={index === currentIndex}
                onClick={() => player.removeFromQueue(track.entryId)}
              >
                <Icon icon={X} size="dense" />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
