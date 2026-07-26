// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/home/PosterCard.tsx
//
// Real card affordance for every simple Home rail (Continue Watching,
// Recently Added, New in Music — the Featured banner has its own richer
// FeaturedBanner.tsx). Gap-closure finding (L5): the pre-Phosphor version
// of this component had NO href at all — a plain non-interactive <div>.
// Rewritten as a real <a>, the same click-intercept-for-a-View-Transition
// pattern as components/browse/PosterCell.tsx (this app's established
// "real poster tile" convention, including the poster->detail shared-
// element transition via lib/view-transition.ts).
//
// Continue Watching's PLAY glyph (Interactions & behavior: "continue-
// watching cards open detail; their play button opens the resume prompt
// instead") is a NESTED <button> — not a second <a>, which the HTML
// content model disallows nesting inside the outer link — that stops
// propagation and navigates programmatically to a SEPARATE destination
// (/watch/{id}[?type=...], which VideoPlayer.tsx gates through its own
// resume-prompt flow with zero extra wiring needed here).
//
// Missing-artwork fallback (README "Assets"): gradient + oversized initial
// ONLY when the item genuinely has no image of the wanted kind — never
// shown for items that DO have real art (checked via `images`, not by
// waiting for an <img> to 404).

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { components } from "@loombre/sdk";
import { Play } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageSrcSet, buildImageUrl, defaultImageSizes } from "../../lib/image-url.js";
import { backdropImage, posterImage } from "../../lib/item-lookup.js";
import { posterTransitionName, runViewTransition } from "../../lib/view-transition.js";
import { ProgressBar } from "../ui/ProgressBar.js";
import styles from "./PosterCard.module.css";

type ImageDescriptor = components["schemas"]["ImageDescriptor"];

export type PosterCardAspect = "2/3" | "16/9" | "1/1";

export interface PosterCardProps {
  href: string;
  serverUrl: string;
  accessToken: string;
  entityType: string;
  entityId: string;
  title: string;
  subtitle?: string | undefined;
  images: ImageDescriptor[];
  /** Missing-artwork fallback letter (first letter of `title`, uppercased). */
  initial: string;
  aspectRatio?: PosterCardAspect;
  progressPercent?: number;
  /** Continue Watching's PLAY destination, e.g. `/watch/{id}?type=movie` —
   *  distinct from `href` (which opens detail). Rendered as a nested play
   *  button only when supplied. */
  playHref?: string;
  /** P2.11 "Home rows subtle now-playing pulse" — fed by lib/now-playing.ts's
   *  useNowPlayingItemIds(). Compositor-only (opacity of a static-box-shadow
   *  pseudo-element, see PosterCard.module.css); collapses under
   *  prefers-reduced-motion instead of just speeding up (P2.10). */
  nowPlaying?: boolean;
}

function resolveImage(images: ImageDescriptor[], aspectRatio: PosterCardAspect): ImageDescriptor | null {
  if (aspectRatio === "16/9") return backdropImage(images) ?? posterImage(images);
  return posterImage(images);
}

/** Poster tile: blurhash LQIP crossfades to the loaded <img> (P2.10 — never
 *  a pop-in), hover lift is transform/box-shadow ONLY (compositor-friendly,
 *  no width/height/top/left/margin animation). Real <a href> — the whole
 *  card opens detail; `playHref` (Continue Watching only) is a nested,
 *  separately-actionable play button. */
export function PosterCard({
  href,
  serverUrl,
  accessToken,
  entityType,
  entityId,
  title,
  subtitle,
  images,
  initial,
  aspectRatio = "2/3",
  progressPercent,
  playHref,
  nowPlaying,
}: PosterCardProps): React.JSX.Element {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const image = useMemo(() => resolveImage(images, aspectRatio), [images, aspectRatio]);
  const placeholderUri = useMemo(() => (image?.blurhash ? blurhashToDataUri(image.blurhash) : null), [image]);

  const kind = image?.kind ?? "poster";
  const src = buildImageUrl({ serverUrl, accessToken, entityType, entityId, kind, width: 320 });
  const srcSet = buildImageSrcSet({ serverUrl, accessToken, entityType, entityId, kind });

  function handleCardClick(event: React.MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    runViewTransition(() => router.push(href));
  }

  function handlePlayClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    if (playHref) router.push(playHref);
  }

  return (
    <a
      href={href}
      className={styles.tile}
      data-aspect={aspectRatio}
      onClick={handleCardClick}
      aria-label={subtitle ? `${title}, ${subtitle}` : title}
    >
      <div
        className={styles.imageWrap}
        style={{ viewTransitionName: aspectRatio === "2/3" ? posterTransitionName(entityId) : undefined }}
        data-now-playing={nowPlaying ?? false}
      >
        {image ? (
          <>
            {placeholderUri && (
              <img className={styles.placeholder} data-loaded={loaded} src={placeholderUri} alt="" aria-hidden="true" />
            )}
            <img
              className={styles.image}
              data-loaded={loaded}
              src={src}
              srcSet={srcSet}
              sizes={defaultImageSizes()}
              alt=""
              loading="lazy"
              onLoad={() => setLoaded(true)}
            />
          </>
        ) : (
          <div className={styles.artFallback}>
            <span className={styles.artInitial} aria-hidden="true">
              {initial}
            </span>
          </div>
        )}
        {progressPercent !== undefined && (
          <div className={styles.progressOverlay}>
            <ProgressBar percent={progressPercent} />
          </div>
        )}
        {playHref && (
          <button type="button" className={styles.playButton} aria-label={`Play ${title}`} onClick={handlePlayClick}>
            <Icon icon={Play} aria-hidden />
          </button>
        )}
        {/* S7 poster signature: in-artwork title, additional to the
            below-caption title span (dc renders both on every 2:3/1:1
            poster). Skipped for 16/9 (Continue Watching), which has its
            own title+epcode+progress overlay already — see this file's
            module CSS header. */}
        {aspectRatio !== "16/9" && (
          <span className={styles.artTitle} aria-hidden="true">
            {title}
          </span>
        )}
      </div>
      <span className={styles.title}>{title}</span>
      {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
    </a>
  );
}
