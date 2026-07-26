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
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
  }, [query, onResultCount]);

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
      {people.length > 0 && (
        <div className={styles.group}>
          <h3 className={styles.groupHeading}>PEOPLE</h3>
          <SearchPersonGrid people={people} activeId={activeId} />
        </div>
      )}
    </div>
  );
}
