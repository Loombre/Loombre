// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/PosterCell.tsx
//
// One cell of the virtualized browse grid (and reused by SearchPanel's
// grouped results). Renders as a real <a href> for accessibility/middle-
// click/new-tab, but intercepts a plain left-click to run the navigation
// inside a View Transition (P2.10 poster->hero shared element — see
// lib/view-transition.ts) instead of a bare Link push. `tabIndex`/`cellRef`/
// `onFocus` implement the parent grid's roving-tabindex keyboard nav
// (VirtualPosterGrid owns the arrow-key logic; this component is just the
// focus target).

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageSrcSet, buildImageUrl, defaultImageSizes } from "../../lib/image-url.js";
import { posterTransitionName, runViewTransition } from "../../lib/view-transition.js";
import styles from "./PosterCell.module.css";

export interface PosterCellProps {
  serverUrl: string;
  accessToken: string;
  entityType: string;
  entityId: string;
  href: string;
  title: string;
  subtitle?: string | undefined;
  blurhash: string | null;
  tabIndex: number;
  cellRef: (el: HTMLAnchorElement | null) => void;
  onFocus: () => void;
  /** P2.11 now-playing pulse — see PosterCard.tsx's prop of the same name
   *  (same recipe, this component's own CSS module per its header). */
  nowPlaying?: boolean | undefined;
}

export function PosterCell({
  serverUrl,
  accessToken,
  entityType,
  entityId,
  href,
  title,
  subtitle,
  blurhash,
  tabIndex,
  cellRef,
  onFocus,
  nowPlaying,
}: PosterCellProps): React.JSX.Element {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const placeholderUri = useMemo(() => (blurhash ? blurhashToDataUri(blurhash) : null), [blurhash]);

  const src = buildImageUrl({ serverUrl, accessToken, entityType, entityId, kind: "poster", width: 320 });
  const srcSet = buildImageSrcSet({ serverUrl, accessToken, entityType, entityId, kind: "poster" });

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    runViewTransition(() => router.push(href));
  }

  return (
    <a
      ref={cellRef}
      href={href}
      className={styles.tile}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={handleClick}
      aria-label={subtitle ? `${title}, ${subtitle}` : title}
    >
      <div
        className={styles.imageWrap}
        style={{ viewTransitionName: posterTransitionName(entityId) }}
        data-now-playing={nowPlaying ?? false}
      >
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
        {/* S7 poster signature: in-artwork title, additional to the
            below-caption title span below (dc:274-284 renders both). */}
        <span className={styles.artTitle} aria-hidden="true">
          {title}
        </span>
      </div>
      <span className={styles.title}>{title}</span>
      {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
    </a>
  );
}
