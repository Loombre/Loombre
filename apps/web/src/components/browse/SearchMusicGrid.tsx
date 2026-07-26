// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/browse/SearchMusicGrid.tsx
//
// Phosphor H5 search retheme (design/phosphor/dc:340-351, "MUSIC"): 110px
// square album grid, horizontal scroll. The contract's SearchResult
// doesn't have a dedicated "music" itemType — it's real artist/album/track
// results grouped under one heading (SearchPanel.tsx's existing grouping,
// kept) — so ground truth needed a real per-subtype rendering rather than
// literally forcing every result to look like the prototype's
// album-shaped fixture:
//   - album/track tiles: real artwork (poster kind — a track's own image,
//     not its parent album's, so a re-tagged single still shows its own
//     cover) + the real artist NAME as the subtitle (the prototype's
//     `a.artist` field). Album/Track only carry `artistId`, not a name —
//     same gap Wave-2 lane L9 hit for the Home "New in Music" rail
//     ("Album has no inline artist name") and solved the same way: a
//     deduped per-artist GET /artists/{id} lookup (`artistNames` prop,
//     built once by SearchPanel for every distinct id across this result
//     page — never one fetch per tile).
//   - artist tiles: the artist's OWN genres as the subtitle when it has
//     any (real Artist.genres), otherwise no subtitle — never a fabricated
//     "Artist" label standing in for missing data.
//
// Mobile (dc:1694-1705's `mobSAlbums` block): switches from the horizontal
// square grid to a vertical list of wide rows (44x44 square thumb, title
// + "artist · meta" combined onto one line, no chevron — the fixture never
// draws one here). Both trees render, CSS-swapped at 767.98px (same
// convention as SearchMovieRow.tsx).

import type { components } from "@loombre/sdk";
import { buildImageUrl } from "../../lib/image-url.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import styles from "./SearchMusicGrid.module.css";

type SearchResult = components["schemas"]["SearchResult"];
type Artist = components["schemas"]["Artist"];
type Album = components["schemas"]["Album"];
type Track = components["schemas"]["Track"];

function hrefFor(result: SearchResult): string {
  return `/items/${result.itemType}/${result.item.id}`;
}

function subtitleFor(result: SearchResult, artistNames: ReadonlyMap<string, string>): string | undefined {
  if (result.itemType === "artist") {
    const artist = result.item as Artist;
    return artist.genres.length > 0 ? artist.genres.join(" / ") : undefined;
  }
  if (result.itemType === "album") {
    return artistNames.get((result.item as Album).artistId);
  }
  if (result.itemType === "track") {
    return artistNames.get((result.item as Track).artistId);
  }
  return undefined;
}

export function SearchMusicGrid({
  results,
  artistNames,
  serverUrl,
  accessToken,
  activeId,
}: {
  results: SearchResult[];
  artistNames: ReadonlyMap<string, string>;
  serverUrl: string;
  accessToken: string;
  activeId?: string | undefined;
}): React.JSX.Element {
  return (
    <>
      <div className={styles.row} role="list">
        {results.map((result) => {
          const posterImage = result.item.images?.find((img) => img.kind === "poster");
          const placeholderUri = posterImage?.blurhash ? blurhashToDataUri(posterImage.blurhash) : null;
          const src = buildImageUrl({
            serverUrl,
            accessToken,
            entityType: result.itemType,
            entityId: result.item.id,
            kind: "poster",
            width: 220,
          });
          const subtitle = subtitleFor(result, artistNames);
          return (
            <a
              key={result.item.id}
              href={hrefFor(result)}
              className={styles.cell}
              role="listitem"
              data-search-id={result.item.id}
              data-search-active={result.item.id === activeId}
            >
              <span className={styles.art}>
                {placeholderUri && <img className={styles.artPlaceholder} src={placeholderUri} alt="" aria-hidden="true" />}
                <img className={styles.artImage} src={src} alt="" loading="lazy" />
              </span>
              <span className={styles.title}>{result.item.title}</span>
              {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
            </a>
          );
        })}
      </div>
      <div className={styles.mobileList} role="list">
        {results.map((result) => {
          const posterImage = result.item.images?.find((img) => img.kind === "poster");
          const placeholderUri = posterImage?.blurhash ? blurhashToDataUri(posterImage.blurhash) : null;
          const src = buildImageUrl({
            serverUrl,
            accessToken,
            entityType: result.itemType,
            entityId: result.item.id,
            kind: "poster",
            width: 88,
          });
          const subtitle = subtitleFor(result, artistNames);
          const metaLine = [subtitle, result.item.year ? String(result.item.year) : null].filter(Boolean).join(" · ");
          return (
            <a
              key={result.item.id}
              href={hrefFor(result)}
              className={styles.mobileRow}
              role="listitem"
              data-search-id={result.item.id}
              data-search-active={result.item.id === activeId}
            >
              <span className={styles.mobileArt}>
                {placeholderUri && <img className={styles.mobileArtPlaceholder} src={placeholderUri} alt="" aria-hidden="true" />}
                <img className={styles.mobileArtImage} src={src} alt="" loading="lazy" />
              </span>
              <span className={styles.mobileInfo}>
                <span className={styles.mobileTitle}>{result.item.title}</span>
                {metaLine && <span className={styles.mobileMeta}>{metaLine}</span>}
              </span>
            </a>
          );
        })}
      </div>
    </>
  );
}
