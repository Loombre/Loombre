// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/music/AlbumArt.tsx
//
// Phosphor H2 album art tile (design/phosphor/dc:529-531): real artwork via
// the same image-url/blurhash path every other poster in this app uses,
// falling back to a gradient + oversized initial letter on a decode error
// — the exact recipe components/detail/DetailPoster.tsx already
// established for the movie-detail poster (that file's header: "the
// prototype's oversized-initial-letter treatment is the MISSING-artwork
// fallback... triggered by the <img>'s onError"). Not reused directly:
// DetailPoster is explicitly scoped to its own 218px 2:3 movie poster (its
// header says building the fallback generically was out of that lane's
// scope) and this tile is square, a different size at each breakpoint, and
// carries the vinyl-ring overlay DetailPoster has no concept of — so this
// is its own small component in this lane's own directory, same recipe,
// not a shared one three lanes now have to agree on.
//
// The vinyl ring is always rendered (a static decorative disc) — only its
// ROTATION is conditional on `spinning` (real "is THIS album's audio
// actually playing" state from the caller, not just "loaded"), per the fix
// brief: "ONLY while audio for this album is actually playing". Compositor
// transform only (rotate), disabled under prefers-reduced-motion (CSS
// media query — no JS branch). `showVinyl` is false for the mobile 118px
// tile (design/phosphor/dc:1724 — the mobile fixture is a plain square,
// no ring).

import { useMemo, useState } from "react";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { buildImageUrl } from "../../lib/image-url.js";
import styles from "./AlbumArt.module.css";

export interface AlbumArtProps {
  serverUrl: string;
  accessToken: string;
  albumId: string;
  title: string;
  blurhash: string | null;
  dominantColor: string | null;
  size: number;
  spinning: boolean;
  showVinyl?: boolean;
}

export function AlbumArt({
  serverUrl,
  accessToken,
  albumId,
  title,
  blurhash,
  dominantColor,
  size,
  spinning,
  showVinyl = true,
}: AlbumArtProps): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const placeholderUri = useMemo(() => (blurhash ? blurhashToDataUri(blurhash) : null), [blurhash]);
  const src = buildImageUrl({ serverUrl, accessToken, entityType: "album", entityId: albumId, kind: "poster", width: size * 2 });
  const initial = title.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className={styles.art}
      data-fallback={failed}
      style={{ width: size, height: size, "--art-glow": dominantColor ?? undefined } as React.CSSProperties}
    >
      {failed ? (
        <span className={styles.initial} aria-hidden="true" style={{ fontSize: size * 0.6 }}>
          {initial}
        </span>
      ) : (
        <>
          {placeholderUri && <img className={styles.placeholder} src={placeholderUri} alt="" aria-hidden="true" />}
          <img className={styles.image} src={src} alt="" onError={() => setFailed(true)} />
        </>
      )}
      {showVinyl && (
        <div className={styles.vinylWrap} aria-hidden="true">
          <div className={styles.vinylRing} data-spinning={spinning}>
            <div className={styles.vinylHole} />
          </div>
        </div>
      )}
    </div>
  );
}
