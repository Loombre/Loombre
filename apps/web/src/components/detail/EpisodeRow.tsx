// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/EpisodeRow.tsx
//
// Series-detail episode row (design/phosphor/README.md "Series detail":
// "episode rows: 62×38 thumbnail with progress sliver, E04 mono index,
// WATCHED accent badge, title, runtime" — one responsive row, not separate
// desktop/mobile components; sizing reflows via EpisodeRow.module.css's
// breakpoint, same U2 "one component tree" convention as the rest of this
// screen). `progress` is real Progress data (packages/contract's Progress
// schema) fetched by SeriesDetailScreen.tsx per visible episode via
// lib/progress-lookup.ts — null means "no progress row for this episode
// yet", rendered as a plain unwatched row, never fabricated.
//
// Missing-artwork fallback (S5, Phosphor W3 fidelity-audit finding): same
// onError-flip pattern as DetailPoster.tsx/SceneBanner.tsx/
// MobileSceneCard.tsx (reuse, don't invent) — the <img> is removed from
// the tree on error and an oversized translucent initial (episode.title's
// first letter) renders over a per-item-hue gradient, real dominantColor
// read straight off episode.images' own "thumb" ImageDescriptor (already
// on the `episode` prop this component receives — no new data plumbing
// needed, unlike SceneBanner/MobileSceneCard's screen-level callers).
//
// H13 (Phosphor W3 fidelity-audit finding, same file as S5): the
// inProgress&&!watched case used to render nothing beyond the progress
// sliver. Two prototype-matched additions (design/phosphor/
// "Loombre Phosphor.dc.html"'s episode-row markup, verbatim style values):
//   - an accent-outlined "RESUME mm:ss" pill (real progress.positionMs,
//     same row-level slot WATCHED/the unseen dot already occupy —
//     mutually exclusive with both, per the prototype's sc-if chain).
//   - a rgba(11,12,15,.45) hover scrim behind the play glyph (the
//     prototype wraps the glyph AND the scrim in the same opacity-faded
//     box; this repo's previous version faded the glyph alone with no
//     scrim behind it).

"use client";

import { useState } from "react";
import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { buildImageUrl } from "../../lib/image-url.js";
import { formatRuntime } from "./format.js";
import styles from "./EpisodeRow.module.css";

type Episode = components["schemas"]["Episode"];
type Progress = components["schemas"]["Progress"];

/** mm:ss (h:mm:ss past an hour) — same convention as components/player/
 *  Scrubber.tsx's defaultFormatTime, deliberately NOT imported from there:
 *  this fix lane's file grant is EpisodeRow.tsx alone, and reaching into
 *  the player's module tree would pull an unrelated component's CSS
 *  module into this bundle for the sake of one tiny pure function.
 *  Duplicated on purpose; both are ~6 lines of arithmetic, not a
 *  maintenance burden worth a cross-lane coupling. */
function formatResumeTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function EpisodeRow({
  episode,
  serverUrl,
  accessToken,
  progress,
}: {
  episode: Episode;
  serverUrl: string;
  accessToken: string;
  progress?: Progress | null;
}): React.JSX.Element {
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = buildImageUrl({
    serverUrl,
    accessToken,
    entityType: "episode",
    entityId: episode.id,
    kind: "thumb",
    width: 320,
  });
  const thumbImage = episode.images?.find((img) => img.kind === "thumb");
  const dominantColor = thumbImage?.dominantColor ?? null;
  const initial = episode.title.trim().charAt(0).toUpperCase() || "?";
  const runtime = formatRuntime(episode.runtimeMs);
  const watched = progress?.state === "played";
  const inProgress = progress?.state === "in-progress";
  const percent =
    inProgress && progress?.durationMs ? Math.min(100, Math.max(0, (progress.positionMs / progress.durationMs) * 100)) : 0;
  const indexLabel = `E${String(episode.episodeNumber).padStart(2, "0")}`;

  return (
    <a href={`/items/episode/${episode.id}`} className={styles.row}>
      <span className={styles.index}>{indexLabel}</span>
      <span
        className={styles.thumbWrap}
        style={{ "--thumb-glow": dominantColor ?? undefined } as React.CSSProperties}
        data-fallback={thumbFailed}
      >
        {thumbFailed ? (
          <span className={styles.thumbInitial} aria-hidden="true">
            {initial}
          </span>
        ) : (
          <img className={styles.thumb} src={thumb} alt="" loading="lazy" onError={() => setThumbFailed(true)} />
        )}
        <span className={styles.playScrim} aria-hidden="true">
          <Icon icon="play" size="dense" className={styles.playIcon ?? ""} aria-hidden />
        </span>
        {inProgress && (
          <span className={styles.sliverTrack} aria-hidden="true">
            <span className={styles.sliverFill} style={{ width: `${percent}%` }} />
          </span>
        )}
      </span>
      <span className={styles.info}>
        <span className={styles.title}>{episode.title}</span>
        <span className={styles.meta}>{runtime ?? "Runtime unknown"}</span>
      </span>
      {watched && <span className={styles.watchedBadge}>WATCHED</span>}
      {inProgress && !watched && progress && (
        <span className={styles.resumeBadge}>RESUME {formatResumeTime(progress.positionMs)}</span>
      )}
      {!watched && !inProgress && <span className={styles.unseenDot} aria-hidden="true" />}
    </a>
  );
}
