// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/featured-fields.ts
//
// Builds the Featured banner's per-candidate view model from real Movie/
// Series fields ONLY (design/phosphor/README.md §Screens -> Home + this
// lane's brief: "spec line (real year/rating/runtime; series: years ·
// status · N seasons from real fields — omit any field that doesn't exist
// server-side and log it, U9)"). Two real data gaps recorded here, not
// papered over:
//
//   - "years" (a RANGE, e.g. "2016-2019") has no server field at all —
//     Series (packages/contract/openapi.yaml) only carries a single start
//     `year` (CatalogItemBase), same as Movie. Rendered as that one real
//     year; no end year is fabricated.
//   - Season COUNT isn't a Series field either (no `seasonCount` on the
//     schema) — it's the real length of GET /series/{id}/seasons's page,
//     the SAME endpoint the item-detail route's SeriesDetail already calls
//     (apps/web/src/app/items/[itemType]/[id]/page.tsx), fetched once per
//     pool candidate (bounded to <=5 by featured-pool.ts's cap).
//
// The tag (eyebrow "FEATURED · <tag>"): movies get a REAL per-item genre
// (never the prototype's fixture "FROM YOUR LIBRARY" copy — this lane's
// brief: "tag from real data — e.g. genre; never a fixture"); series get
// "SERIES IN YOUR LIBRARY" verbatim, which is README PROSE (not a fixture
// binding) naming that exact category label for every series candidate —
// design copy, like "Play"/"Details"/"Continue Watching", not placeholder
// content.
//
// formatRuntime/formatRating are intentionally duplicated here (not
// imported from components/detail/format.ts) to keep this lane's
// dependency graph inside app/home/**+components/home/**+its own new lib
// files — this lane's brief bars touching detail screens, and importing
// from there would be an unnecessary cross-lane coupling for ~15 lines of
// pure formatting logic.

import type { components } from "@loombre/sdk";
import { backdropImage, posterImage } from "./item-lookup.js";

type Movie = components["schemas"]["Movie"];
type Series = components["schemas"]["Series"];
type ImageDescriptor = components["schemas"]["ImageDescriptor"];

export interface FeaturedCandidate {
  id: string;
  itemType: "movie" | "series";
  title: string;
  tag: string;
  specLine: string;
  blurb: string | null;
  images: ImageDescriptor[];
  href: string;
  playHref: string;
  initial: string;
}

function formatRuntime(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms <= 0) return null;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatRating(rating: number | null | undefined): string | null {
  if (rating === null || rating === undefined) return null;
  return rating.toFixed(1);
}

/** Missing-artwork fallback letter — exported for reuse by
 *  components/home/PosterCard.tsx's own rail cards (same convention, same
 *  file's-worth of lane ownership, no cross-lane coupling). */
export function initialLetter(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

function joinSpecLine(parts: (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

const SERIES_STATUS_LABEL: Record<NonNullable<Series["status"]>, string> = {
  continuing: "Continuing",
  ended: "Ended",
  cancelled: "Cancelled",
};

export function buildMovieCandidate(movie: Movie): FeaturedCandidate {
  const rating = formatRating(movie.communityRating);
  const specLine = joinSpecLine([movie.year ? String(movie.year) : null, rating ? `★ ${rating}` : null, formatRuntime(movie.runtimeMs)]);

  return {
    id: movie.id,
    itemType: "movie",
    title: movie.title,
    // Real per-item genre; `genres` can legitimately be empty, so "Movie"
    // (the item's own real itemType) is the fallback — a field-derived
    // value, not fixture text.
    tag: movie.genres[0]?.toUpperCase() ?? "MOVIE",
    specLine,
    blurb: movie.overview,
    images: movie.images ?? [],
    href: `/items/movie/${movie.id}`,
    playHref: `/watch/${movie.id}?type=movie`,
    initial: initialLetter(movie.title),
  };
}

export function buildSeriesCandidate(series: Series, seasonCount: number | null): FeaturedCandidate {
  const specLine = joinSpecLine([
    // Single real `year` — see this module's header for why no "years"
    // range is rendered (Series has no end-year field anywhere).
    series.year ? String(series.year) : null,
    series.status ? SERIES_STATUS_LABEL[series.status] : null,
    seasonCount !== null ? `${seasonCount} season${seasonCount === 1 ? "" : "s"}` : null,
  ]);

  return {
    id: series.id,
    itemType: "series",
    title: series.title,
    tag: "SERIES IN YOUR LIBRARY",
    specLine,
    blurb: series.overview,
    images: series.images ?? [],
    href: `/items/series/${series.id}`,
    playHref: `/watch/${series.id}?type=series`,
    initial: initialLetter(series.title),
  };
}

/** Preference order for the banner's full-bleed "scene" background:
 *  backdrop first (widescreen art fits the banner's own aspect), poster as
 *  a fallback (still real art), null when the item genuinely has neither —
 *  ONLY then does FeaturedBanner render the gradient+initial fallback. */
export function candidateSceneImage(images: ImageDescriptor[]): ImageDescriptor | null {
  return backdropImage(images) ?? posterImage(images);
}

/** The banner's 118x177 poster specifically — poster art only (a backdrop
 *  stretched into a portrait box would misrepresent the art), null falls
 *  back to the gradient+initial treatment. */
export function candidatePosterImage(images: ImageDescriptor[]): ImageDescriptor | null {
  return posterImage(images);
}
