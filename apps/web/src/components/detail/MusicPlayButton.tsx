// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/MusicPlayButton.tsx
//
// P2 work item 1's other two entry points: AlbumDetail's "Play" (whole
// album, queue supplied eagerly — already loaded for the track list) and
// ArtistDetail's "Play" (no top-tracks endpoint, so `buildQueue` is a lazy
// async callback that fetches on click — see lib/play-queue.ts's
// fetchArtistQueue). Visually matches PlayLink (same button recipe) but is
// a real <button> since it starts music in place rather than navigating to
// /watch.

"use client";

import { useState } from "react";
import { Icon } from "../icon/Icon.js";
import { useMusicPlayer } from "../music/MusicPlayerProvider.js";
import type { PlayableTrackInput } from "../music/MusicPlayerProvider.js";
import styles from "./PlayLink.module.css";

export function MusicPlayButton({
  queue,
  label = "Play",
}: {
  queue: PlayableTrackInput[] | (() => Promise<PlayableTrackInput[]>);
  label?: string;
}): React.JSX.Element {
  const musicPlayer = useMusicPlayer();
  const [loading, setLoading] = useState(false);

  async function handleClick(): Promise<void> {
    if (typeof queue !== "function") {
      if (queue.length > 0) musicPlayer.playQueue(queue, 0);
      return;
    }
    setLoading(true);
    try {
      const resolved = await queue();
      if (resolved.length > 0) musicPlayer.playQueue(resolved, 0);
    } finally {
      setLoading(false);
    }
  }

  const disabled = loading || (typeof queue !== "function" && queue.length === 0);

  return (
    <button type="button" className={styles.button} disabled={disabled} onClick={() => void handleClick()}>
      <Icon icon="play" size="dense" aria-hidden />
      {loading ? "Loading…" : label}
    </button>
  );
}
