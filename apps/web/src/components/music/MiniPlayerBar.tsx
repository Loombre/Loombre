// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/music/MiniPlayerBar.tsx
//
// Persistent glass mini-player (P2.5) — mounted once by AppProviders above
// the route layout boundary so it survives navigation. Renders nothing when
// the queue is empty.

import { ListMusic, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";
import { Icon } from "../icon/Icon.js";
import { Scrubber, defaultFormatTime } from "../player/Scrubber.js";
import { buildImageUrl } from "../../lib/image-url.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { useMusicPlayer } from "./MusicPlayerProvider.js";
import styles from "./MiniPlayerBar.module.css";

export function MiniPlayerBar(): React.JSX.Element | null {
  const player = useMusicPlayer();
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAuthStore()
      .getAccessToken()
      .then((t) => {
        if (!cancelled) setAccessToken(t ?? "");
      });
    return () => {
      cancelled = true;
    };
  }, [player.current?.itemId]);

  const track = player.current;
  if (!track) return null;

  // browser-player-F12: player.durationMs is the provider's confirmed
  // value, only populated after the active slot's async session-creation
  // round-trip resolves (MusicPlayerProvider.tsx's loadIntoSlot) — the
  // queue ENTRY itself already knows its own durationMs synchronously the
  // instant it becomes current (QueueDrawer's "· 3:24" meta reads the same
  // field). Prefer the confirmed value once it exists; fall back to the
  // entry's advertised one instead of "–:–" while the network catches up.
  const durationMs = player.durationMs ?? track.durationMs ?? null;

  const serverUrl = getAuthStore().getSnapshot().serverUrl;
  const coverSrc = accessToken
    ? buildImageUrl({ serverUrl, accessToken, entityType: "track", entityId: track.itemId, kind: "poster", width: 88 })
    : (track.blurhash ? blurhashToDataUri(track.blurhash) : null);

  return (
    <div className={styles.bar} role="region" aria-label="Music player">
      {/* A2/C4 (UIFIX-2026-08-29): cover + meta are ONE zone, not two flat
          children — the bar is a three-zone layout (meta / transport /
          right controls) and only the wrapper can carry the flex that
          keeps the transport centred. See MiniPlayerBar.module.css. */}
      <div className={styles.metaZone}>
        <div className={styles.cover}>{coverSrc && <img src={coverSrc} alt="" />}</div>
        <div className={styles.meta}>
          <span className={styles.title}>{track.title}</span>
          {track.subtitle && <span className={styles.subtitle}>{track.subtitle}</span>}
        </div>
      </div>

      <div className={styles.transport}>
        {/* Prev/next hidden on mobile (Wave 1 W1a reflow, README item 4 —
            "reflow only, do not build a new player surface"): the mini-bar
            has to fit the 392px phone spec docked above the tab bar, and
            play/pause is the one control an iOS-style mini-player keeps —
            skip still reachable via the queue drawer this button opens. */}
        <button type="button" className={`${styles.iconButtonInline} ${styles.skipButton}`} aria-label="Previous track" onClick={player.prev}>
          <Icon icon="skipBack" size="dense" />
        </button>
        <button
          type="button"
          className={styles.iconButtonInline}
          aria-label={player.isPlaying ? "Pause" : "Play"}
          onClick={player.toggle}
        >
          <Icon icon={player.isPlaying ? "pause" : "play"} />
        </button>
        <button type="button" className={`${styles.iconButtonInline} ${styles.skipButton}`} aria-label="Next track" onClick={player.next}>
          <Icon icon="skipForward" size="dense" />
        </button>
      </div>

      <div className={styles.scrubberArea}>
        <span className={styles.time}>{defaultFormatTime(player.positionMs)}</span>
        <Scrubber positionMs={player.positionMs} durationMs={durationMs} onSeek={player.seekTo} />
        <span className={styles.time}>{durationMs !== null ? defaultFormatTime(durationMs) : "–:–"}</span>
      </div>

      <div className={styles.rightControls}>
        {/* Mute + slider hidden on mobile (same reflow note above) — volume
            is a hardware control there; the mute toggle stays reachable via
            the (also-mobile-visible) queue drawer's own controls. */}
        <button
          type="button"
          className={`${styles.iconButtonInline} ${styles.muteButton}`}
          aria-label={player.muted ? "Unmute" : "Mute"}
          onClick={player.toggleMute}
        >
          <Icon icon={player.muted || player.volume === 0 ? VolumeX : Volume2} size="dense" />
        </button>
        <input
          className={styles.volumeSlider}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={player.muted ? 0 : player.volume}
          aria-label="Volume"
          onChange={(e) => player.setVolume(Number(e.target.value))}
        />
        <button
          type="button"
          className={styles.iconButtonInline}
          aria-label="Toggle queue"
          aria-pressed={player.queueDrawerOpen}
          onClick={() => (player.queueDrawerOpen ? player.closeQueueDrawer() : player.openQueueDrawer())}
        >
          <Icon icon={ListMusic} size="dense" />
        </button>
      </div>
    </div>
  );
}
