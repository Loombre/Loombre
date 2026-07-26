// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/TrackRow.tsx
//
// P2 work item 1 ("no UI path starts music"): clicking a track row plays it
// immediately — queue = the whole album, starting from this track — rather
// than navigating to the track's detail page (that page is still reachable
// via search results, see components/browse/SearchPanel.tsx). `albumTracks`
// must be in the same order the caller rendered them in (AlbumDetail sorts
// by trackNumber before mapping); `index` is this track's position in that
// exact array, so play/next/prev walk the album in listed order.
//
// Phosphor H2 retheme (design/phosphor/dc:546-561, "TRACKS"): mono
// track-index + mono length either side of the title (S2), a 3-bar
// animated equalizer swapping in for the index on the CURRENTLY-PLAYING
// row (real MusicPlayerProvider state — `current.itemId === track.id &&
// isPlaying`, not just "loaded"), title color shifts to accent while
// playing. Ground truth: the prototype never renders a trailing play icon
// on this row (hover-highlight + click-anywhere-to-play is the whole
// affordance) — the pre-Phosphor persistent play glyph is removed to
// match; ListRow.module.css's `.playIcon` class stays defined for
// VersionRow.tsx, its other consumer, unaffected by this file no longer
// referencing it.

"use client";

import type { components } from "@loombre/sdk";
import { useMusicPlayer } from "../music/MusicPlayerProvider.js";
import { tracksToPlayableQueue } from "../../lib/play-queue.js";
import { defaultFormatTime } from "../player/Scrubber.js";
import styles from "./ListRow.module.css";

type Track = components["schemas"]["Track"];

export function TrackRow({
  track,
  albumTracks,
  index,
}: {
  track: Track;
  albumTracks: Track[];
  index: number;
}): React.JSX.Element {
  const musicPlayer = useMusicPlayer();
  const isCurrent = musicPlayer.current?.itemId === track.id;
  const isPlayingNow = isCurrent && musicPlayer.isPlaying;
  const length = track.durationMs !== null && track.durationMs !== undefined ? defaultFormatTime(track.durationMs) : null;

  function handlePlay(): void {
    musicPlayer.playQueue(tracksToPlayableQueue(albumTracks), index);
  }

  return (
    <button type="button" onClick={handlePlay} className={styles.row} aria-label={`Play ${track.title}`}>
      {isPlayingNow ? (
        <span className={styles.eq} aria-hidden="true">
          <span className={styles.eqBar} />
          <span className={styles.eqBar} />
          <span className={styles.eqBar} />
        </span>
      ) : (
        <span className={styles.number}>{track.trackNumber ? String(track.trackNumber).padStart(2, "0") : "–"}</span>
      )}
      <span className={`${styles.title} ${styles.trackTitle}`} data-playing={isCurrent}>
        {track.title}
      </span>
      <span className={styles.trackLength}>{length ?? "–:–"}</span>
    </button>
  );
}
