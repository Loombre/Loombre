// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/home/HomeContent.tsx
//
// Home's whole component tree, split out of ./page.tsx so it can be unit-
// tested directly (./page.test.tsx) without going through AppShell/
// auth-store redirect logic. Next's App Router type-checks `page.tsx` as a
// ROUTE module — the only exports it accepts are `default` plus the route
// segment config (metadata/revalidate/...), so a second named export there
// is a hard type error. Same sibling-module shape as
// app/login/ServerIndicator.tsx.
//
// Phosphor W2 lane L9 (gap-closure lane, dispatched mid-wave — L5 found
// Home unowned: no featured banner existed, and the rail cards had NO
// click affordance at all). Rebuilds Home per design/phosphor/README.md
// §Screens -> Home, both breakpoints as ONE component tree (U2): Featured
// banner -> Continue Watching -> Recently Added -> [WATCHLIST SLOT] ->
// New in Music.
//
// FEATURED POOL (README: "candidates must be titles that appear in none
// of those rails ... a real query constraint, not a preference
// ordering"): built from data ALREADY fetched for the rails below
// (continue-watching + recently-added) plus a small over-fetch of
// /movies + /series (sort=added) as the raw candidate set — see
// lib/featured-pool.ts (exclusion Set-difference + recency cap) and
// lib/featured-fields.ts (per-candidate view model, real fields only).
//
// WATCHLIST SEAM (Wave 2 lane L3 owns the Watchlist rail + toggle state):
// WATCHLIST_IDS_SEAM below is the one-line addition point for L3's real
// watchlist ids once that lane lands (see lib/featured-pool.ts's
// buildExclusionSet header) — this lane deliberately does NOT build a
// watchlist rail or read/write watchlist state itself. The section order
// below leaves an explicit, commented slot between Recently Added and New
// in Music for L3 to render its <WatchlistRail /> into.
//
// DATA OMISSIONS LEDGER (U9 — real gaps, not invented around; restated in
// this lane's freeze report):
//   - Continue Watching's caption shows POSITION only, never "· device" —
//     Progress (packages/contract/openapi.yaml) carries no device column
//     anywhere in the system (re-confirmed here; first found by Wave 2
//     lane L5 building ResumePrompt.tsx).
//   - The featured pool's "most-recently-added-UNWATCHED" ordering is the
//     best the available data supports: list endpoints have no per-item
//     watched flag, only continue-watching MEMBERSHIP is knowable (see
//     lib/featured-pool.ts's header).
//   - Server-side featured-pool computation (for cross-device
//     consistency) is a real README ask this lane can't do client-side —
//     logged as a follow-up, not this lane's to build. Until it exists the
//     exclusion is scoped to what each rail actually SHOWS (see
//     RECENTLY_ADDED_VISIBLE_CARDS below and lib/featured-pool.ts's header,
//     browser-shell-browse-F8): excluding Recently Added's whole fetch made
//     the banner structurally unreachable on any library smaller than the
//     candidate over-fetch.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { components } from "@loombre/sdk";
import { FeaturedBanner } from "../../components/home/FeaturedBanner.js";
import { Row } from "../../components/home/Row.js";
import { PosterCard } from "../../components/home/PosterCard.js";
import { WatchlistPosterCard } from "../../components/watchlist/WatchlistPosterCard.js";
import { Skeleton } from "../../components/skeleton/Skeleton.js";
import { Button } from "../../components/ui/Button.js";
import { apiDelete, apiGet, LoombreApiError } from "../../lib/api-client.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { useNowPlayingItemIds } from "../../lib/now-playing.js";
import { useWatchlistChangeSignal } from "../../lib/watchlist-sync.js";
import { buildExclusionSet, selectFeaturedPool, visibleRailIds, type FeaturedPoolCandidate } from "../../lib/featured-pool.js";
import { buildMovieCandidate, buildSeriesCandidate, initialLetter, type FeaturedCandidate } from "../../lib/featured-fields.js";
import styles from "./page.module.css";

type ContinueWatchingEntry = components["schemas"]["ContinueWatchingEntry"];
type WatchlistEntry = components["schemas"]["WatchlistEntry"];
type RecentlyAddedEntry = components["schemas"]["RecentlyAddedEntry"];
type Movie = components["schemas"]["Movie"];
type Series = components["schemas"]["Series"];

type ImageDescriptor = components["schemas"]["ImageDescriptor"];

function posterBlurhash(images: ImageDescriptor[] | undefined): string | null {
  return images?.find((img) => img.kind === "poster")?.blurhash ?? null;
}

// browser-casual-F4: WatchlistPosterCard is "the PosterCell shape" (its own
// header's words) — same doomed-request gap as browser-shell-browse-F3,
// same fix.
function hasPosterImage(images: ImageDescriptor[] | undefined): boolean {
  return images?.some((img) => img.kind === "poster") ?? false;
}

/** How many extra /movies + /series (each) to over-fetch as raw featured-
 *  pool candidates before exclusion — needs enough margin to survive the
 *  Set-difference against the rails' visible cards below. */
const POOL_CANDIDATE_FETCH_LIMIT = 25;
const FEATURED_POOL_MAX = 5;

/* Recently Added's VISIBLE FIRST PAGE — the only part of that rail the
   featured pool excludes (browser-shell-browse-F8, owner ruling
   2026-08-24; see lib/featured-pool.ts's header for the whole rule and
   why excluding the rail's full fetch made the banner unreachable).
   Derived from the rail's own geometry rather than picked, so a card/gap/
   sidebar change moves it instead of leaving a stale literal behind. */

/** One card of track in the rail's horizontal scroller: the 160px poster
 *  tile (components/home/PosterCard.module.css .tile) plus the scroller's
 *  --space-md gap (16px, styles/tokens.css). */
const RAIL_CARD_TRACK_PX = 160 + 16;

/** Content width of the desktop shell on a 1920px-wide display — viewport
 *  minus the 210px sidebar (components/shell/Sidebar.module.css) and
 *  .main's two --space-xl gutters (32px each, AppShell.module.css). */
const DESKTOP_CONTENT_WIDTH_PX = 1920 - 210 - 32 * 2;

/** = 10. Cards past this are behind a horizontal scroll at every desktop
 *  width the shell is built for, i.e. NOT in the same fold as the banner —
 *  which is the duplicate design/phosphor/README.md actually forbids. */
const RECENTLY_ADDED_VISIBLE_CARDS = Math.ceil(DESKTOP_CONTENT_WIDTH_PX / RAIL_CARD_TRACK_PX);

/** Bounded — Home's rail shows the most recently added handful, same
 *  posture as Continue Watching/Recently Added (L3's rail, wired into
 *  L9's page at Wave-2 landing per both lanes' documented seam). */
const WATCHLIST_RAIL_LIMIT = 20;

interface MovieCandidateRow extends FeaturedPoolCandidate {
  kind: "movie";
  movie: Movie;
}
interface SeriesCandidateRow extends FeaturedPoolCandidate {
  kind: "series";
  series: Series;
}
type PoolRow = MovieCandidateRow | SeriesCandidateRow;

/** Real elapsed-position caption for Continue Watching ("render position
 *  only, omit device" — see this file's header ledger). Duplicated from
 *  components/player/Scrubber.ts's defaultFormatTime rather than imported,
 *  to keep this lane's dependency graph inside app/home/**+components/
 *  home/**+its own new lib files (this lane's brief bars touching
 *  components/player/**). */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function fetchFeaturedCandidates(excluded: ReadonlySet<string>): Promise<FeaturedCandidate[]> {
  const [moviesPage, seriesPage] = await Promise.all([
    apiGet("/movies", { params: { query: { sort: "added", order: "desc", limit: POOL_CANDIDATE_FETCH_LIMIT } } }),
    apiGet("/series", { params: { query: { sort: "added", order: "desc", limit: POOL_CANDIDATE_FETCH_LIMIT } } }),
  ]);

  const rows: PoolRow[] = [
    ...moviesPage.items.map((movie): MovieCandidateRow => ({ kind: "movie", id: movie.id, addedAtMs: movie.addedAtMs, movie })),
    ...seriesPage.items.map((series): SeriesCandidateRow => ({ kind: "series", id: series.id, addedAtMs: series.addedAtMs, series })),
  ];

  const pool = selectFeaturedPool(rows, excluded, FEATURED_POOL_MAX);

  return Promise.all(
    pool.map(async (row) => {
      if (row.kind === "movie") return buildMovieCandidate(row.movie);
      // Season COUNT has no field on Series itself (see featured-fields.ts's
      // header) — the real length of the same seasons list the item-detail
      // route already fetches, bounded to <=5 candidates by the pool cap.
      const seasons = await apiGet("/series/{id}/seasons", { params: { path: { id: row.series.id }, query: { limit: 100 } } }).catch(
        () => null,
      );
      return buildSeriesCandidate(row.series, seasons ? seasons.items.length : null);
    }),
  );
}

/** Unique-artist-name resolution for the "New in Music" rail (Album has no
 *  inline artist name — only `artistId`; see this file's header/freeze
 *  report). Deduped so a handful of recently-added albums by the same
 *  artist cost one request, not N. */
function useArtistNames(albumEntries: RecentlyAddedEntry[]): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const artistIds = useMemo(
    () => [...new Set(albumEntries.map((e) => (e.item as { artistId?: string }).artistId).filter((id): id is string => Boolean(id)))],
    [albumEntries],
  );
  const key = artistIds.join(",");

  useEffect(() => {
    if (artistIds.length === 0) return;
    let cancelled = false;
    Promise.all(
      artistIds.map(async (id) => {
        try {
          const artist = await apiGet("/artists/{id}", { params: { path: { id } } });
          return [id, artist.title] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setNames(new Map(entries.filter((e): e is [string, string] => e[1] !== null)));
    });
    return () => {
      cancelled = true;
    };
    // `key` (the joined, deduped id list) is the real dependency — `artistIds`
    // is a fresh array identity every render otherwise.
  }, [key]);

  return names;
}

export function HomeContent(): React.JSX.Element {
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingEntry[] | null>(null);
  const [recentlyAdded, setRecentlyAdded] = useState<RecentlyAddedEntry[] | null>(null);
  const [featuredPool, setFeaturedPool] = useState<FeaturedCandidate[] | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[] | null>(null);
  // Neither rail fetch below used to have a `.catch()` — a transient 5xx/
  // network failure left `loading` (below) true forever, with no feedback
  // and no way to recover short of a full page reload (77-agent review,
  // confirmed[16]). `retryKey` re-runs the bootstrap effect on demand.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const nowPlayingIds = useNowPlayingItemIds();

  const fetchWatchlist = useCallback(() => {
    apiGet("/watchlist", { params: { query: { limit: WATCHLIST_RAIL_LIMIT } } }).then((page) => {
      setWatchlist(page.items);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setContinueWatching(null);
    setRecentlyAdded(null);
    getAuthStore()
      .getAccessToken()
      .then((token) => {
        if (!cancelled) setAccessToken(token);
      });
    apiGet("/home/continue-watching")
      .then((page) => {
        if (!cancelled) setContinueWatching(page.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof LoombreApiError ? err.message : "Failed to load Home.");
      });
    apiGet("/home/recently-added")
      .then((page) => {
        if (!cancelled) setRecentlyAdded(page.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof LoombreApiError ? err.message : "Failed to load Home.");
      });
    // Watchlist is a secondary rail (hidden entirely when empty, see the
    // render below) — degrade to an empty list on failure instead of
    // joining the two catches above, so a /watchlist-only outage doesn't
    // block the whole page behind the retry screen.
    apiGet("/watchlist", { params: { query: { limit: WATCHLIST_RAIL_LIMIT } } })
      .then((page) => {
        if (!cancelled) setWatchlist(page.items);
      })
      .catch(() => {
        if (!cancelled) setWatchlist([]);
      });
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  // Cross-device sync (README "State management": watchlist "must sync
  // across devices via the events socket") — another of this user's own
  // sessions adding/removing re-runs this rail's fetch.
  useWatchlistChangeSignal(fetchWatchlist);

  async function handleWatchlistRemove(itemId: string): Promise<void> {
    await apiDelete("/watchlist/{itemId}", { params: { path: { itemId } } });
    setWatchlist((prev) => (prev ? prev.filter((entry) => entry.item.id !== itemId) : prev));
  }

  // The two rails /home/recently-added feeds: the Recently Added poster
  // rail (movies + series) and New in Music (albums). Declared here, above
  // the featured-pool effect, because that effect's exclusion source is the
  // catalog rail's own rendered order.
  const recentlyAddedCatalog = useMemo(
    () => (recentlyAdded ?? []).filter((e) => e.itemType === "movie" || e.itemType === "series"),
    [recentlyAdded],
  );
  const recentlyAddedAlbums = useMemo(() => (recentlyAdded ?? []).filter((e) => e.itemType === "album"), [recentlyAdded]);
  const artistNames = useArtistNames(recentlyAddedAlbums);

  // Featured pool: real Set-difference against whatever's already ON SCREEN
  // in the two rails above (+ the watchlist rail) — only runs once BOTH rail
  // fetches have resolved, since the exclusion set needs their real ids.
  useEffect(() => {
    if (continueWatching === null || recentlyAdded === null || watchlist === null) return;
    let cancelled = false;
    // Continue Watching and the watchlist rail each fetch a page close to
    // what they render (the server's own continue-watching default of 20,
    // WATCHLIST_RAIL_LIMIT). Recently Added does NOT — its fetch can dwarf
    // the fold, so only its visible first page excludes
    // (browser-shell-browse-F8).
    const excluded = buildExclusionSet(
      continueWatching.map((e) => e.item.id),
      visibleRailIds(
        recentlyAddedCatalog.map((e) => e.item.id),
        RECENTLY_ADDED_VISIBLE_CARDS,
      ),
      watchlist.map((e) => e.item.id),
    );
    fetchFeaturedCandidates(excluded)
      .then((pool) => {
        if (!cancelled) setFeaturedPool(pool);
      })
      // browser-shell-browse-F7: had no .catch — the banner is optional
      // (rendered only when `featuredPool.length > 0`, see below) and this
      // effect's own deps never re-fire on their own once the two rails
      // above have resolved, so a failure here has no user-facing retry
      // path either way. Degrade to "no banner" (an empty pool already
      // renders nothing — this is the SAME outcome, not a new state) rather
      // than leaving an unhandled rejection.
      .catch(() => {
        if (!cancelled) setFeaturedPool([]);
      });
    return () => {
      cancelled = true;
    };
  }, [continueWatching, recentlyAdded, recentlyAddedCatalog, watchlist]);

  const loading = continueWatching === null || recentlyAdded === null || accessToken === null;

  return (
    <div className={styles.page}>
      {loadError ? (
        <div className={styles.loadError}>
          <p className={styles.loadErrorText}>{loadError}</p>
          <Button type="button" variant="secondary" onClick={() => setRetryKey((k) => k + 1)}>
            Retry
          </Button>
        </div>
      ) : loading ? (
        <>
          <Skeleton radius="lg" height={252} />
          <Skeleton radius="md" height={20} width={220} />
          <div style={{ display: "flex", gap: "var(--space-md)" }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} radius="md" width={160} height={240} />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Featured banner: pool is null until it resolves (a beat after
              the two rails above, since it needs their ids) — rendering
              nothing meanwhile rather than a skeleton avoids a banner-
              shaped placeholder popping in AFTER the rails below it. */}
          {featuredPool && featuredPool.length > 0 && (
            <FeaturedBanner pool={featuredPool} serverUrl={serverUrl} accessToken={accessToken} />
          )}

          <Row heading="Continue Watching" mobileHeading="KEEP WATCHING" empty="Nothing in progress — start watching something.">
            {continueWatching.map((entry) => (
              <PosterCard
                key={entry.item.id}
                serverUrl={serverUrl}
                accessToken={accessToken}
                entityType={entry.itemType}
                entityId={entry.item.id}
                href={`/items/${entry.itemType}/${entry.item.id}`}
                playHref={`/watch/${entry.item.id}?type=${entry.itemType}`}
                title={entry.item.title}
                subtitle={formatElapsed(entry.progress.positionMs)}
                images={entry.item.images ?? []}
                initial={initialLetter(entry.item.title)}
                aspectRatio="16/9"
                progressPercent={entry.progress.durationMs ? (entry.progress.positionMs / entry.progress.durationMs) * 100 : 0}
                nowPlaying={nowPlayingIds.has(entry.item.id)}
              />
            ))}
          </Row>

          <Row
            heading="Recently Added"
            mobileHeading="RECENTLY ADDED"
            action={{ label: "ALL →", href: "/browse" }}
            empty="Nothing added yet — scan a library to get started."
          >
            {recentlyAddedCatalog.map((entry) => (
              <PosterCard
                key={entry.item.id}
                serverUrl={serverUrl}
                accessToken={accessToken}
                entityType={entry.itemType}
                entityId={entry.item.id}
                href={`/items/${entry.itemType}/${entry.item.id}`}
                title={entry.item.title}
                subtitle={entry.item.year ? String(entry.item.year) : undefined}
                images={entry.item.images ?? []}
                initial={initialLetter(entry.item.title)}
                nowPlaying={nowPlayingIds.has(entry.item.id)}
              />
            ))}
          </Row>

          {/* README: "a Your Watchlist rail (hidden when empty, each card
              offering inline REMOVE)" — renders NOTHING at all when empty
              (not even the heading). L3's rail in L9's slot (Wave-2
              landing reconciliation). */}
          {(watchlist ?? []).length > 0 && (
            <Row heading="Your Watchlist" mobileHeading="WATCHLIST">
              {(watchlist ?? []).map((entry) => (
                <div key={entry.item.id} className={styles.watchlistCell}>
                  <WatchlistPosterCard
                    serverUrl={serverUrl}
                    accessToken={accessToken}
                    entityType={entry.itemType}
                    entityId={entry.item.id}
                    href={`/items/${entry.itemType}/${entry.item.id}`}
                    title={entry.item.title}
                    blurhash={posterBlurhash(entry.item.images)}
                    hasPoster={hasPosterImage(entry.item.images)}
                    onRemove={() => handleWatchlistRemove(entry.item.id)}
                  />
                </div>
              ))}
            </Row>
          )}

          <Row heading="New in Music" mobileHeading="ALBUMS" action={{ label: "LIBRARY →", href: "/browse" }} empty="No new albums yet.">
            {recentlyAddedAlbums.map((entry) => {
              const album = entry.item as { artistId?: string; year?: number | null };
              return (
                <PosterCard
                  key={entry.item.id}
                  serverUrl={serverUrl}
                  accessToken={accessToken}
                  entityType={entry.itemType}
                  entityId={entry.item.id}
                  href={`/items/${entry.itemType}/${entry.item.id}`}
                  title={entry.item.title}
                  subtitle={(album.artistId && artistNames.get(album.artistId)) || (album.year ? String(album.year) : undefined)}
                  images={entry.item.images ?? []}
                  initial={initialLetter(entry.item.title)}
                  aspectRatio="1/1"
                  nowPlaying={nowPlayingIds.has(entry.item.id)}
                />
              );
            })}
          </Row>
        </>
      )}
    </div>
  );
}
