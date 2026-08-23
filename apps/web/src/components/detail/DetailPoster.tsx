// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/detail/DetailPoster.tsx
//
// Movie-detail 218px 2:3 poster (design/phosphor/README.md "Movie detail":
// "218px poster w/ oversized initial + inner hairline"). Shares the browse
// grid's shared-element view-transition name (lib/view-transition.ts's
// posterTransitionName, same convention as components/browse/PosterCell.tsx)
// so navigating here from a poster card cross-fades/moves instead of
// cutting.
//
// Real poster image when one exists; the prototype's oversized-initial-
// letter treatment is the MISSING-artwork fallback per design/phosphor/
// README.md "Assets" ("keep the gradient as the missing-artwork fallback"),
// triggered by the <img>'s onError — not a permanent stand-in for real
// artwork. No other surface in this app (components/browse/PosterCell.tsx
// included) implements this fallback yet; building it generically for
// every poster in the app is out of this lane's scope, so it's scoped to
// this one component.

import { useMemo, useState } from "react";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageUrl } from "../../lib/image-url.js";
import { posterTransitionName } from "../../lib/view-transition.js";
import styles from "./DetailPoster.module.css";

export interface DetailPosterProps {
  serverUrl: string;
  accessToken: string;
  entityType: string;
  entityId: string;
  title: string;
  blurhash: string | null;
  dominantColor: string | null;
  /** browser-items-F13: default true (every pre-existing caller keeps
   *  fetching, same as before this prop existed). Pass false when the
   *  item's own `images[]` already says there's no poster to fetch (an
   *  un-scanned/no-metadata-provider item) — skips the doomed network
   *  request entirely and renders the fallback immediately, instead of
   *  firing a GET guaranteed to 404/ORB-block and waiting on its onError. */
  hasImage?: boolean;
}

export function DetailPoster({
  serverUrl,
  accessToken,
  entityType,
  entityId,
  title,
  blurhash,
  dominantColor,
  hasImage = true,
}: DetailPosterProps): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const showFallback = failed || !hasImage;
  const placeholderUri = useMemo(() => (blurhash ? blurhashToDataUri(blurhash) : null), [blurhash]);
  const src = buildImageUrl({ serverUrl, accessToken, entityType, entityId, kind: "poster", width: 440 });
  const initial = title.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className={styles.poster}
      style={{ "--poster-glow": dominantColor ?? undefined, viewTransitionName: posterTransitionName(entityId) } as React.CSSProperties}
      data-fallback={showFallback}
    >
      {showFallback ? (
        <>
          <span className={styles.initial} aria-hidden="true">
            {initial}
          </span>
          {/* Title lettering baked onto the fallback tile only — a real
              poster image already carries its own title art, so this
              would be a redundant duplicate label on top of real
              artwork. */}
          <span className={styles.fallbackTitle}>{title}</span>
        </>
      ) : (
        <>
          {placeholderUri && <img className={styles.placeholder} src={placeholderUri} alt="" aria-hidden="true" />}
          <img className={styles.image} src={src} alt="" onError={() => setFailed(true)} />
        </>
      )}
      <div className={styles.hairline} aria-hidden="true" />
    </div>
  );
}
