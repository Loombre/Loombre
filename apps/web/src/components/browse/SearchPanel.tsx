// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/SearchPanel.tsx
//
// Shared grouped-results renderer for both the Topbar quick-search popover
// (components/shell/QuickSearch.tsx) and the full /search page — one place
// owns the GET /search + GET /people calls, grouping, and keyboard nav so
// the two surfaces can't drift.
//
// Grouping: GET /search's SearchResult.itemType is movie/series/artist/
// album/track (the contract's discriminated union) — grouped here into
// Movies / Series / Music (artist+album+track together, since the contract
// doesn't distinguish "music" as its own itemType). People is a SEPARATE
// call (GET /people?q=) since /search does not return people at all
// (P1.17: people is real but its own dedicated leak-checked list surface,
// never joined into cross-type search).
//
// Phosphor H5 retheme (design/phosphor/dc:313-377, "SEARCH") — per-type
// result layouts replacing the old one-size-fits-all ResultRow:
//   - Movies: SearchMovieRow.tsx (124px 2:3 poster grid, reuses PosterCell)
//   - Series: SearchSeriesRow.tsx (88x50 thumb rows + chevron)
//   - Music (artist/album/track): SearchMusicGrid.tsx (110px square grid) —
//     album/track subtitles need the credited ARTIST NAME, which neither
//     schema carries inline (only artistId) — `artistNames` below is a
//     deduped GET /artists/{id} lookup over just the distinct ids this
//     result page actually needs (same pattern Wave-2 lane L9 used for the
//     Home "New in Music" rail), fetched in parallel with rendering so it
//     never blocks the as-you-type result paint.
//   - People: SearchPersonGrid.tsx (64px shared Avatar + name + real
//     credit count — Person has no role/credit-type field to show
//     "roles" with, see that file's header).
//   - Empty query: SearchEmptyState.tsx (real localStorage recents +
//     ghost "SEARCH EVERYTHING" treatment, lib/recent-searches.ts).
//
// Keyboard nav (moveActive/activateFocused, the SearchPanelHandle contract
// both callers depend on) no longer walks a flat array of <a> DOM refs —
// with four structurally different result shapes there is no longer one
// generic "row" to ref. Instead it walks a flat array of {id, href} built
// straight from the same grouped data every render, and `activateFocused`
// navigates directly (router.push) rather than synthesizing a click.
// `data-search-active` on the corresponding tile/row (threaded into each
// of the four result components as an `activeId` comparison) is the
// visible highlight; `moveActive` still scrolls it into view via a
// `data-search-id` attribute + a container ref query, so keyboard users
// never lose track of the highlighted result off-screen.
//
// searchReadout ("N RESULTS · M MS · FTS + TRIGRAM"): the result count and
// "FTS + TRIGRAM" are both real (packages/db/src/query/search.ts genuinely
// unions a websearch_to_tsquery full-text branch with pg_trgm-indexed
// person/tag substring branches — grep that file's own header). "M MS" is
// a REAL measurement (performance.now() around the fetch), not the
// prototype's length-derived fake latency formula.
//
// Pagination (`paginated` prop, /search page only): both GET /search and
// GET /people are cursor-paginated, so this component always tracks a
// nextCursor for each even though the topbar popover never surfaces a
// "Load more" control for it — a bounded preview is the right call there.
// One cursor covers all three catalog groups (Movies/Series/Music) since
// GET /search itself is one ranked, cross-type page; People is a fully
// separate cursor off GET /people. Not routed through useCursorFeed: that
// hook is a single fetchPage->{items,nextCursor} feed, and this component
// already runs two feeds in lockstep behind one shared elapsedMs/
// recentQueries/artistNames bookkeeping that a second hook instance would
// have to duplicate or fight with.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { components } from "@loombre/sdk";
import { apiGet } from "../../lib/api-client.js";
import { addRecentSearch, getRecentSearches } from "../../lib/recent-searches.js";
import { runViewTransition } from "../../lib/view-transition.js";
import { SearchMovieRow } from "./SearchMovieRow.js";
import { SearchSeriesRow } from "./SearchSeriesRow.js";
import { SearchMusicGrid } from "./SearchMusicGrid.js";
import { SearchPersonGrid } from "./SearchPersonGrid.js";
import { SearchEmptyState } from "./SearchEmptyState.js";
import styles from "./SearchPanel.module.css";

type SearchResult = components["schemas"]["SearchResult"];
type Person = components["schemas"]["Person"];
type Album = components["schemas"]["Album"];
type Track = components["schemas"]["Track"];

export interface SearchPanelHandle {
  moveActive: (delta: number) => void;
  activateFocused: () => boolean;
}

export interface SearchPanelProps {
  query: string;
  serverUrl: string;
  accessToken: string;
  onNavigate?: (() => void) | undefined;
  onResultCount?: ((count: number) => void) | undefined;
  registerHandle?: ((handle: SearchPanelHandle | null) => void) | undefined;
  /** Only the full /search page passes this — the topbar quick-search
   *  popover (QuickSearch.tsx) never mounts this component with an empty
   *  query at all (it gates on `debouncedQuery.trim().length > 0`), so it
   *  never needs a way to set one from a recent-search pill. */
  onSelectQuery?: ((query: string) => void) | undefined;
  /** Only the full /search page passes this. GET /search and GET /people
   *  are both cursor-paginated (packages/contract/openapi.yaml) but the
   *  topbar popover deliberately wants a bounded, single-screen preview —
   *  quick-search-sources.ts's own PALETTE_RESULT_LIMIT precedent — so it
   *  never renders the "Load more" controls below even though the same
   *  fetches always request (and this component always tracks) a
   *  nextCursor. */
  paginated?: boolean | undefined;
}

interface FlatEntry {
  id: string;
  href: string;
}

function hrefFor(result: SearchResult): string {
  return `/items/${result.itemType}/${result.item.id}`;
}

export function SearchPanel({
  query,
  serverUrl,
  accessToken,
  onNavigate,
  onResultCount,
  registerHandle,
  onSelectQuery,
  paginated = false,
}: SearchPanelProps): React.JSX.Element {
  const router = useRouter();
  const [movies, setMovies] = useState<SearchResult[]>([]);
  const [series, setSeries] = useState<SearchResult[]>([]);
  const [music, setMusic] = useState<SearchResult[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [artistNames, setArtistNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentQueries, setRecentQueries] = useState<string[]>(() => getRecentSearches());
  // GET /search and GET /people's own nextCursor (contract: SearchResultPage
  // / PersonPage) — tracked regardless of `paginated` (cheap: just a string)
  // so the topbar popover and the full page share one fetch effect; only
  // the "Load more" controls below are gated on `paginated`.
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null);
  const [catalogHasMore, setCatalogHasMore] = useState(false);
  const [loadingMoreCatalog, setLoadingMoreCatalog] = useState(false);
  const [catalogLoadMoreError, setCatalogLoadMoreError] = useState<string | null>(null);
  const [peopleCursor, setPeopleCursor] = useState<string | null>(null);
  const [peopleHasMore, setPeopleHasMore] = useState(false);
  const [loadingMorePeople, setLoadingMorePeople] = useState(false);
  const [peopleLoadMoreError, setPeopleLoadMoreError] = useState<string | null>(null);
  const requestId = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setMovies([]);
      setSeries([]);
      setMusic([]);
      setPeople([]);
      setArtistNames(new Map());
      setElapsedMs(null);
      setCatalogCursor(null);
      setCatalogHasMore(false);
      setCatalogLoadMoreError(null);
      setPeopleCursor(null);
      setPeopleHasMore(false);
      setPeopleLoadMoreError(null);
      onResultCount?.(0);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    const startedAtMs = performance.now();
    Promise.all([
      apiGet("/search", { params: { query: { q: trimmed, limit: 20 } } }),
      apiGet("/people", { params: { query: { q: trimmed, limit: 6 } } }),
    ])
      .then(([searchPage, peoplePage]) => {
        if (requestId.current !== id) return;
        const nextMovies: SearchResult[] = [];
        const nextSeries: SearchResult[] = [];
        const nextMusic: SearchResult[] = [];
        for (const result of searchPage.items) {
          if (result.itemType === "movie") nextMovies.push(result);
          else if (result.itemType === "series") nextSeries.push(result);
          else nextMusic.push(result);
        }
        setMovies(nextMovies);
        setSeries(nextSeries);
        setMusic(nextMusic);
        setPeople(peoplePage.items);
        setCatalogCursor(searchPage.nextCursor);
        setCatalogHasMore(searchPage.nextCursor !== null);
        setCatalogLoadMoreError(null);
        setPeopleCursor(peoplePage.nextCursor);
        setPeopleHasMore(peoplePage.nextCursor !== null);
        setPeopleLoadMoreError(null);
        setElapsedMs(Math.round(performance.now() - startedAtMs));
        setActiveIndex(0);
        const total = nextMovies.length + nextSeries.length + nextMusic.length + peoplePage.items.length;
        onResultCount?.(total);
        if (total > 0) setRecentQueries(addRecentSearch(trimmed));

        // Deduped artist-name lookup for album/track subtitles (see this
        // file's header) — fetched in parallel, never blocking the result
        // paint above.
        const artistIds = new Set<string>();
        for (const result of nextMusic) {
          if (result.itemType === "album") artistIds.add((result.item as Album).artistId);
          else if (result.itemType === "track") artistIds.add((result.item as Track).artistId);
        }
        if (artistIds.size > 0) {
          Promise.all(
            Array.from(artistIds).map((artistId) =>
              apiGet("/artists/{id}", { params: { path: { id: artistId } } })
                .then((artist) => [artistId, artist.title] as const)
                .catch(() => null),
            ),
          ).then((resolved) => {
            if (requestId.current !== id) return;
            const map = new Map<string, string>();
            for (const entry of resolved) {
              if (entry) map.set(entry[0], entry[1]);
            }
            setArtistNames(map);
          });
        } else {
          setArtistNames(new Map());
        }
      })
      .catch(() => {
        if (requestId.current !== id) return;
        setMovies([]);
        setSeries([]);
        setMusic([]);
        setPeople([]);
        setArtistNames(new Map());
        setElapsedMs(null);
        setCatalogCursor(null);
        setCatalogHasMore(false);
        setPeopleCursor(null);
        setPeopleHasMore(false);
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
  }, [query, onResultCount]);

  // Page 2+ of GET /search — one cursor walks all three catalog groups at
  // once (SearchResult.itemType, the same discriminated union the initial
  // fetch above buckets), so "Load more results" appends across Movies/
  // Series/Music together rather than per-group. Guarded by the same
  // requestId this file already uses for the initial fetch, so a query
  // change mid-flight can't append a stale page onto the new query's fresh
  // results.
  async function loadMoreCatalog(): Promise<void> {
    if (loadingMoreCatalog || catalogCursor === null) return;
    const id = requestId.current;
    setLoadingMoreCatalog(true);
    setCatalogLoadMoreError(null);
    try {
      const page = await apiGet("/search", {
        params: { query: { q: query.trim(), limit: 20, cursor: catalogCursor } },
      });
      if (requestId.current !== id) return;
      const nextMovies: SearchResult[] = [];
      const nextSeries: SearchResult[] = [];
      const nextMusic: SearchResult[] = [];
      for (const result of page.items) {
        if (result.itemType === "movie") nextMovies.push(result);
        else if (result.itemType === "series") nextSeries.push(result);
        else nextMusic.push(result);
      }
      setMovies((prev) => [...prev, ...nextMovies]);
      setSeries((prev) => [...prev, ...nextSeries]);
      setMusic((prev) => [...prev, ...nextMusic]);
      setCatalogCursor(page.nextCursor);
      setCatalogHasMore(page.nextCursor !== null);

      const newArtistIds = new Set<string>();
      for (const result of nextMusic) {
        if (result.itemType === "album") newArtistIds.add((result.item as Album).artistId);
        else if (result.itemType === "track") newArtistIds.add((result.item as Track).artistId);
      }
      const missingArtistIds = Array.from(newArtistIds).filter((artistId) => !artistNames.has(artistId));
      if (missingArtistIds.length > 0) {
        const resolved = await Promise.all(
          missingArtistIds.map((artistId) =>
            apiGet("/artists/{id}", { params: { path: { id: artistId } } })
              .then((artist) => [artistId, artist.title] as const)
              .catch(() => null),
          ),
        );
        if (requestId.current !== id) return;
        setArtistNames((prev) => {
          const next = new Map(prev);
          for (const entry of resolved) {
            if (entry) next.set(entry[0], entry[1]);
          }
          return next;
        });
      }
    } catch (err) {
      if (requestId.current !== id) return;
      setCatalogLoadMoreError(err instanceof Error ? err.message : "Failed to load more.");
    } finally {
      if (requestId.current === id) setLoadingMoreCatalog(false);
    }
  }

  async function loadMorePeople(): Promise<void> {
    if (loadingMorePeople || peopleCursor === null) return;
    const id = requestId.current;
    setLoadingMorePeople(true);
    setPeopleLoadMoreError(null);
    try {
      const page = await apiGet("/people", {
        params: { query: { q: query.trim(), limit: 6, cursor: peopleCursor } },
      });
      if (requestId.current !== id) return;
      setPeople((prev) => [...prev, ...page.items]);
      setPeopleCursor(page.nextCursor);
      setPeopleHasMore(page.nextCursor !== null);
    } catch (err) {
      if (requestId.current !== id) return;
      setPeopleLoadMoreError(err instanceof Error ? err.message : "Failed to load more.");
    } finally {
      if (requestId.current === id) setLoadingMorePeople(false);
    }
  }

  const flatEntries = useMemo<FlatEntry[]>(
    () => [
      ...movies.map((r) => ({ id: r.item.id, href: hrefFor(r) })),
      ...series.map((r) => ({ id: r.item.id, href: hrefFor(r) })),
      ...music.map((r) => ({ id: r.item.id, href: hrefFor(r) })),
      ...people.map((p) => ({ id: p.id, href: `/people/${p.id}` })),
    ],
    [movies, series, music, people],
  );

  useEffect(() => {
    if (!registerHandle) return;
    registerHandle({
      moveActive: (delta) => {
        setActiveIndex((prev) => {
          if (flatEntries.length === 0) return 0;
          const next = (prev + delta + flatEntries.length) % flatEntries.length;
          const nextId = flatEntries[next]!.id;
          containerRef.current?.querySelector(`[data-search-id="${CSS.escape(nextId)}"]`)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      },
      activateFocused: () => {
        const target = flatEntries[activeIndex];
        if (!target) return false;
        onNavigate?.();
        runViewTransition(() => router.push(target.href));
        return true;
      },
    });
    return () => registerHandle(null);
  }, [registerHandle, flatEntries, activeIndex, onNavigate, router]);

  const activeId = flatEntries[activeIndex]?.id;

  if (query.trim().length === 0) {
    return <SearchEmptyState recentQueries={recentQueries} onSelectQuery={onSelectQuery ?? (() => undefined)} />;
  }

  const totalResults = movies.length + series.length + music.length + people.length;

  if (!loading && totalResults === 0) {
    return (
      <div className={styles.noResults}>
        <div className={styles.noResultsTitle}>Nothing matched</div>
        <div className={styles.noResultsHint}>TRY A SHORTER QUERY · TYPOS ARE OK FOR PEOPLE (TRIGRAM)</div>
      </div>
    );
  }

  return (
    <div className={styles.panel} ref={containerRef}>
      {!loading && elapsedMs !== null && (
        <div className={styles.readout}>
          {totalResults} RESULT{totalResults === 1 ? "" : "S"} · {elapsedMs} MS · FTS + TRIGRAM
        </div>
      )}
      {movies.length > 0 && (
        <div className={styles.group}>
          <h3 className={styles.groupHeading}>MOVIES</h3>
          <SearchMovieRow results={movies} serverUrl={serverUrl} accessToken={accessToken} activeId={activeId} />
        </div>
      )}
      {series.length > 0 && (
        <div className={styles.group}>
          <h3 className={styles.groupHeading}>SERIES</h3>
          <SearchSeriesRow results={series} serverUrl={serverUrl} accessToken={accessToken} activeId={activeId} />
        </div>
      )}
      {music.length > 0 && (
        <div className={styles.group}>
          <h3 className={styles.groupHeading}>MUSIC</h3>
          <SearchMusicGrid
            results={music}
            artistNames={artistNames}
            serverUrl={serverUrl}
            accessToken={accessToken}
            activeId={activeId}
          />
        </div>
      )}
      {/* Full /search page only (unverified[4]) — the topbar popover's
          bounded preview never shows this even when catalogHasMore is true.
          One cursor for all three catalog groups above (see loadMoreCatalog's
          header), so this sits after MUSIC rather than inside any one
          group. */}
      {paginated && catalogHasMore && (
        <div className={styles.loadMoreRow}>
          <button type="button" className={styles.loadMore} onClick={() => void loadMoreCatalog()} disabled={loadingMoreCatalog}>
            {loadingMoreCatalog ? "Loading…" : "Load more results"}
          </button>
          {catalogLoadMoreError && <div className={styles.loadMoreError}>{catalogLoadMoreError}</div>}
        </div>
      )}
      {people.length > 0 && (
        <div className={styles.group}>
          <h3 className={styles.groupHeading}>PEOPLE</h3>
          <SearchPersonGrid people={people} activeId={activeId} />
        </div>
      )}
      {paginated && peopleHasMore && (
        <div className={styles.loadMoreRow}>
          <button type="button" className={styles.loadMore} onClick={() => void loadMorePeople()} disabled={loadingMorePeople}>
            {loadingMorePeople ? "Loading…" : "Load more people"}
          </button>
          {peopleLoadMoreError && <div className={styles.loadMoreError}>{peopleLoadMoreError}</div>}
        </div>
      )}
    </div>
  );
}
