// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/browse/SearchMovieRow.tsx
//
// Phosphor H5 search retheme, desktop (design/phosphor/dc:313-326,
// "MOVIES"): 124px 2:3 poster grid, horizontal scroll. Reuses
// PosterCell.tsx as-is (its own header already named this exact reuse:
// "reused by SearchPanel's grouped results" — true fidelity to that
// comment as of this lane, not a new pattern) instead of a second
// poster-tile implementation — same blurhash placeholder,
// view-transition-on-click, hover-lift. PosterCell's tabIndex/cellRef/
// onFocus props exist for VirtualPosterGrid's roving-tabindex arrow-key
// nav; this horizontal strip has no such requirement (a handful of search
// results, not a virtualized thousand-item grid), so each cell gets a
// plain tabIndex=0 and no-op focus plumbing.
//
// Mobile (dc:1661-1680's `mobSMovies` block): movies switch from the
// horizontal poster strip to a vertical list of wide rows — same shape as
// SearchSeriesRow's desktop row (thumb + title/meta + chevron), just with
// a portrait 2:3 thumb instead of a 16:9 one. Both trees render (CSS-
// swapped at 767.98px, the AppShell/MovieDetailScreen convention), not a
// second component — U2's "one responsive tree", same call this lane made
// for AlbumDetailScreen/MovieDetailScreen already establish.
//
// The mobile row is a next/link, not a raw <a> (d4-w3): the search overlay
// is mounted by AppShell on EVERY route, the restricted zone included, and
// RestrictedProvider re-initializes to locked on every document load — so a
// raw anchor here re-locked the zone the result was clicked from (the
// browser-restricted-settings-F1 mechanism). The DESKTOP tree needs no such
// change: PosterCell already intercepts its own click into a
// router.push inside a view transition.

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { buildImageUrl } from "../../lib/image-url.js";
import { blurhashToDataUri } from "../../lib/blurhash-canvas.js";
import { PosterCell } from "./PosterCell.js";
import styles from "./SearchMovieRow.module.css";

type SearchResult = components["schemas"]["SearchResult"];
type Movie = components["schemas"]["Movie"];

function noop(): void {
  /* PosterCell's roving-tabindex hooks — irrelevant to a plain scroll strip. */
}

export function SearchMovieRow({
  results,
  serverUrl,
  accessToken,
  activeId,
}: {
  results: SearchResult[];
  serverUrl: string;
  accessToken: string;
  activeId?: string | undefined;
}): React.JSX.Element {
  return (
    <>
      <div className={styles.row} role="list">
        {results.map((result) => {
          const movie = result.item as Movie;
          return (
            <div
              className={styles.cell}
              role="listitem"
              key={movie.id}
              data-search-id={movie.id}
              data-search-active={movie.id === activeId}
            >
              <PosterCell
                serverUrl={serverUrl}
                accessToken={accessToken}
                entityType="movie"
                entityId={movie.id}
                href={`/items/movie/${movie.id}`}
                title={movie.title}
                subtitle={movie.year ? String(movie.year) : undefined}
                blurhash={movie.images?.find((img) => img.kind === "poster")?.blurhash ?? null}
                tabIndex={0}
                cellRef={noop}
                onFocus={noop}
              />
            </div>
          );
        })}
      </div>
      <div className={styles.mobileList} role="list">
        {results.map((result) => {
          const movie = result.item as Movie;
          const posterImage = movie.images?.find((img) => img.kind === "poster");
          const placeholderUri = posterImage?.blurhash ? blurhashToDataUri(posterImage.blurhash) : null;
          const src = buildImageUrl({ serverUrl, accessToken, entityType: "movie", entityId: movie.id, kind: "poster", width: 88 });
          return (
            <Link
              key={movie.id}
              href={`/items/movie/${movie.id}`}
              className={styles.mobileRow}
              role="listitem"
              data-search-id={movie.id}
              data-search-active={movie.id === activeId}
            >
              <span className={styles.mobileThumb}>
                {placeholderUri && <img className={styles.mobileThumbPlaceholder} src={placeholderUri} alt="" aria-hidden="true" />}
                <img className={styles.mobileThumbImage} src={src} alt="" loading="lazy" />
              </span>
              <span className={styles.mobileInfo}>
                <span className={styles.mobileTitle}>{movie.title}</span>
                <span className={styles.mobileMeta}>{movie.year ? String(movie.year) : ""}</span>
              </span>
              <Icon icon={ChevronRight} size="dense" className={styles.mobileChevron ?? ""} />
            </Link>
          );
        })}
      </div>
    </>
  );
}
