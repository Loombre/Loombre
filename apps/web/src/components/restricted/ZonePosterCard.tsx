// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZonePosterCard.tsx
//
// The unlocked zone grid's own poster tile (design/phosphor/README.md
// "Interactions -> Restricted content": "the gate becomes an amber-
// accented poster grid (amber card borders instead of the library's white
// hairlines)"). A dedicated component rather than reusing
// components/browse/PosterCell.tsx: that component renders NO border at
// all today (a plain hover-lift tile, see its own module header) — adding
// one would be a Browse-wide visual change outside this lane's surgical
// scope, and the general library must never visually imply a connection to
// this zone anyway. This file duplicates PosterCell's image-loading
// recipe (blurhash placeholder crossfade) rather than sharing it, so the
// amber border can be added here without touching a file Browse owns.
//
// STATE.md Stash run (S9): `tabIndex`/`cellRef`/`onFocus` (additive,
// optional) let this card double as a components/browse/VirtualPosterGrid
// `renderItem` cell for /restricted/browse's own grid — same roving-
// tabindex wiring PosterCell.tsx's identical trio implements, so the zone
// grid gets the SAME 60fps windowing + keyboard nav (S10) without a second
// grid implementation. Omitted (the original /restricted gate-grid usage,
// a plain un-virtualized list): the tile is just a normal, always-focusable
// anchor.
//
// Lane E additions (zone home rails, S9): `aspectRatio`/`progressPercent`/
// `playHref` — the SAME optional trio components/home/PosterCard.tsx uses
// for its own Continue Watching rail, added here rather than duplicating
// this whole file, so continueWatchingInZone gets the identical 16:9 +
// progress-bar + nested-play-button treatment the general Home rail has.
// The play button's hover tone is WARNING (--color-warning), not
// --color-accent — design/phosphor/README.md "the zone keeps its warning
// colour", same law this file's border/ring already follows.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageSrcSet, buildImageUrl, defaultImageSizes } from "../../lib/image-url.js";
import { ProgressBar } from "../ui/ProgressBar.js";
import styles from "./ZonePosterCard.module.css";

export type ZonePosterCardAspect = "2/3" | "16/9";

export interface ZonePosterCardProps {
  serverUrl: string;
  accessToken: string;
  itemId: string;
  itemType: string;
  title: string;
  subtitle?: string | undefined;
  blurhash: string | null;
  href: string;
  /** VirtualPosterGrid's roving-tabindex trio (CellHandlers) — all three
   *  optional so this component still works as a plain, always-tabbable
   *  anchor outside a virtualized grid. */
  tabIndex?: number | undefined;
  cellRef?: ((el: HTMLAnchorElement | null) => void) | undefined;
  onFocus?: (() => void) | undefined;
  /** Defaults to the poster grid's own "2/3" — continueWatchingInZone
   *  passes "16/9" (backdrop art, PosterCard.tsx's Continue Watching
   *  precedent). */
  aspectRatio?: ZonePosterCardAspect | undefined;
  progressPercent?: number | undefined;
  /** Continue-watching's PLAY destination (e.g. `/watch/{id}`) — distinct
   *  from `href` (opens scene detail). Renders a nested play button only
   *  when supplied, same shape as PosterCard.tsx's own `playHref`. */
  playHref?: string | undefined;
}

export function ZonePosterCard({
  serverUrl,
  accessToken,
  itemId,
  itemType,
  title,
  subtitle,
  blurhash,
  href,
  tabIndex,
  cellRef,
  onFocus,
  aspectRatio = "2/3",
  progressPercent,
  playHref,
}: ZonePosterCardProps): React.JSX.Element {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const placeholderUri = useMemo(() => (blurhash ? blurhashToDataUri(blurhash) : null), [blurhash]);

  // Unlike PosterCard.tsx's general-catalog items, a Stash-derived scene's
  // ingest pipeline (apps/worker/src/stash/apply.ts) only ever writes a
  // 'poster' image — there is no 'backdrop' kind to request here. A 16/9
  // `aspectRatio` therefore still asks for the poster image; `object-fit:
  // cover` (imageWrap's existing recipe) crops it to fill the wider frame,
  // the same honest degradation every other zone surface without backdrop
  // art already accepts, rather than requesting a kind that would 404.
  const kind = "poster";
  const src = buildImageUrl({ serverUrl, accessToken, entityType: itemType, entityId: itemId, kind, width: 320 });
  const srcSet = buildImageSrcSet({ serverUrl, accessToken, entityType: itemType, entityId: itemId, kind });

  function handlePlayClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    if (playHref) router.push(playHref);
  }

  return (
    <a
      ref={cellRef}
      href={href}
      className={styles.tile}
      data-aspect={aspectRatio}
      tabIndex={tabIndex}
      onFocus={onFocus}
      aria-label={subtitle ? `${title}, ${subtitle}` : title}
    >

      <div className={styles.imageWrap}>
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
            below-caption title span below (dc:1187-1191 renders both).
            Skipped for 16/9 (matches PosterCard.tsx: Continue Watching
            already has its own title/progress overlay). */}
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
