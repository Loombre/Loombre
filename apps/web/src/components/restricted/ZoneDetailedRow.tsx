// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/restricted/ZoneDetailedRow.tsx
//
// STATE.md Stash run (S9): the "detailed rows" half of /restricted/browse's
// density toggle — a thumbnail + metadata row (title, year, rating,
// studio, genres, duration/resolution) instead of a bare poster, for
// scanning a large zone by facts rather than artwork alone.

import { useMemo, useState } from "react";
import type { components } from "@loombre/sdk";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageUrl } from "../../lib/image-url.js";
import styles from "./ZoneDetailedRow.module.css";

type RestrictedBrowseItem = components["schemas"]["RestrictedBrowseItem"];

function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  const totalMinutes = Math.round(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function ZoneDetailedRow({
  item,
  serverUrl,
  accessToken,
  href,
}: {
  item: RestrictedBrowseItem;
  serverUrl: string;
  accessToken: string;
  href: string;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const blurhash = item.images.find((img) => img.kind === "poster")?.blurhash ?? null;
  const placeholderUri = useMemo(() => (blurhash ? blurhashToDataUri(blurhash) : null), [blurhash]);
  const src = buildImageUrl({ serverUrl, accessToken, entityType: "movie", entityId: item.id, kind: "poster", width: 160 });
  const duration = formatDuration(item.durationMs);

  return (
    <a href={href} className={styles.row}>
      <div className={styles.thumbWrap}>
        {placeholderUri && <img className={styles.placeholder} data-loaded={loaded} src={placeholderUri} alt="" aria-hidden="true" />}
        <img className={styles.thumb} data-loaded={loaded} src={src} alt="" loading="lazy" onLoad={() => setLoaded(true)} />
      </div>
      <div className={styles.meta}>
        <span className={styles.title}>{item.title}</span>
        <span className={styles.specLine}>
          {item.year ?? "—"}
          {item.communityRating !== null && ` · ${item.communityRating.toFixed(1)}★`}
          {item.studio && ` · ${item.studio.name}`}
          {duration && ` · ${duration}`}
          {item.quality.resolution && ` · ${item.quality.resolution}`}
        </span>
        {item.genres.length > 0 && <span className={styles.genres}>{item.genres.join(", ")}</span>}
      </div>
    </a>
  );
}
