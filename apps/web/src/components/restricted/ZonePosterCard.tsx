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

import { useMemo, useState } from "react";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageSrcSet, buildImageUrl, defaultImageSizes } from "../../lib/image-url.js";
import styles from "./ZonePosterCard.module.css";

export interface ZonePosterCardProps {
  serverUrl: string;
  accessToken: string;
  itemId: string;
  itemType: string;
  title: string;
  subtitle?: string | undefined;
  blurhash: string | null;
  href: string;
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
}: ZonePosterCardProps): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const placeholderUri = useMemo(() => (blurhash ? blurhashToDataUri(blurhash) : null), [blurhash]);

  const src = buildImageUrl({ serverUrl, accessToken, entityType: itemType, entityId: itemId, kind: "poster", width: 320 });
  const srcSet = buildImageSrcSet({ serverUrl, accessToken, entityType: itemType, entityId: itemId, kind: "poster" });

  return (
    <a href={href} className={styles.tile} aria-label={subtitle ? `${title}, ${subtitle}` : title}>
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
        {/* S7 poster signature: in-artwork title, additional to the
            below-caption title span below (dc:1187-1191 renders both). */}
        <span className={styles.artTitle} aria-hidden="true">
          {title}
        </span>
      </div>
      <span className={styles.title}>{title}</span>
      {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
    </a>
  );
}
