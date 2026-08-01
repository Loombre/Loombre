// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/restricted/browse/page.tsx
//
// STATE.md Stash run (S9/K4): the zone's real, server-side keyset browse —
// SUPERSEDES the old /restricted page's full-fetch-then-client-filter
// design. Filter/sort state lives in the URL (lib/zone-browse-filters.ts —
// shareable within a session, meaningless outside the gate); density
// (poster wall <-> detailed rows) is a personal, localStorage-only
// preference (lib/zone-density-prefs.ts). Entitlement/lock gating mirrors
// app/restricted/page.tsx exactly: not-entitled redirects to /home,
// locked renders the same RestrictedGate.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "../../../components/shell/AppShell.js";
import { RestrictedGate } from "../../../components/restricted/RestrictedGate.js";
import { RestrictedZoneEmptyState } from "../../../components/restricted/RestrictedZoneEmptyState.js";
import { ZoneBrowseGrid } from "../../../components/restricted/ZoneBrowseGrid.js";
import { ZoneSortControl } from "../../../components/restricted/ZoneSortControl.js";
import { ZoneDensityToggle } from "../../../components/restricted/ZoneDensityToggle.js";
import { ZoneFilterBar, type ZoneFilterOption } from "../../../components/restricted/ZoneFilterBar.js";
import { useRestricted } from "../../../components/restricted/RestrictedProvider.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../../lib/restricted-zone-count.js";
import { useCursorFeed, type CursorPage } from "../../../components/browse/useCursorFeed.js";
import {
  clearZoneFilters,
  durationMinutesToMs,
  hasActiveZoneFilters,
  parseZoneBrowseFilters,
  zoneBrowseFiltersToSearchParams,
  type ZoneBrowseFilters,
  type ZoneSort,
} from "../../../lib/zone-browse-filters.js";
import { getZoneDensity, setZoneDensity, type ZoneDensity } from "../../../lib/zone-density-prefs.js";
import { apiGet } from "../../../lib/api-client.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import type { components, OperationFor } from "@loombre/sdk";
import styles from "./page.module.css";

type RestrictedBrowseItem = components["schemas"]["RestrictedBrowseItem"];
type BrowseQuery = NonNullable<OperationFor<"/restricted/browse", "get">["parameters"]["query"]>;

const PAGE_LIMIT = 60;

function toBrowseQuery(filters: ZoneBrowseFilters, cursor: string | null): BrowseQuery {
  const durationMinMs = durationMinutesToMs(filters.durationMinMinutes);
  const durationMaxMs = durationMinutesToMs(filters.durationMaxMinutes);
  return {
    limit: PAGE_LIMIT,
    sort: filters.sort,
    ...(cursor ? { cursor } : {}),
    ...(filters.order !== undefined ? { order: filters.order } : {}),
    ...(filters.performerIds.length > 0 ? { performerIds: filters.performerIds.join(",") } : {}),
    ...(filters.studioTagIds.length > 0 ? { studioTagIds: filters.studioTagIds.join(",") } : {}),
    ...(filters.tagIds.length > 0 ? { tagIds: filters.tagIds.join(",") } : {}),
    ...(filters.ratingMin !== undefined ? { ratingMin: filters.ratingMin } : {}),
    ...(filters.ratingMax !== undefined ? { ratingMax: filters.ratingMax } : {}),
    ...(durationMinMs !== undefined ? { durationMinMs } : {}),
    ...(durationMaxMs !== undefined ? { durationMaxMs } : {}),
    ...(filters.resolution.length > 0 ? { resolution: filters.resolution.join(",") } : {}),
    ...(filters.yearMin !== undefined ? { yearMin: filters.yearMin } : {}),
    ...(filters.yearMax !== undefined ? { yearMax: filters.yearMax } : {}),
  };
}

async function fetchBrowsePage(filters: ZoneBrowseFilters, cursor: string | null): Promise<CursorPage<RestrictedBrowseItem>> {
  const page = await apiGet("/restricted/browse", { params: { query: toBrowseQuery(filters, cursor) } });
  return { items: page.items, nextCursor: page.nextCursor };
}

async function fetchZoneGenreOptions(): Promise<ZoneFilterOption[]> {
  // No dedicated "list zone genres" endpoint (K14/S9 froze the surface
  // list without one) — GET /tags?kind=genre already returns
  // restricted-class rows to a cleared viewer (the SAME content_class +
  // credited-on-a-visible-item guard every other /tags read uses), so
  // filtering the general list to contentClass="restricted" client-side
  // is a real, guarded reuse, not a new leak surface.
  const page = await apiGet("/tags", { params: { query: { kind: "genre", limit: 200 } } });
  return page.items.filter((t) => t.contentClass === "restricted").map((t) => ({ id: t.id, name: t.name }));
}

function BrowseContent(): React.JSX.Element | null {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state: restrictedState } = useRestricted();
  const { count, loading: countLoading } = useRestrictedZoneCount();
  const entitled = hasRestrictedZoneEntitlement(count);

  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [density, setDensityState] = useState<ZoneDensity>("wall");
  const [performerOptions, setPerformerOptions] = useState<ZoneFilterOption[]>([]);
  const [studioOptions, setStudioOptions] = useState<ZoneFilterOption[]>([]);
  const [genreOptions, setGenreOptions] = useState<ZoneFilterOption[]>([]);

  useEffect(() => {
    setDensityState(getZoneDensity());
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  useEffect(() => {
    if (!entitled || restrictedState.locked) return;
    let cancelled = false;
    Promise.all([
      apiGet("/restricted/performers", { params: { query: { limit: 200 } } }),
      apiGet("/restricted/studios", { params: { query: { limit: 200 } } }),
      fetchZoneGenreOptions(),
    ]).then(([performers, studios, genres]) => {
      if (cancelled) return;
      setPerformerOptions(performers.items.map((p) => ({ id: p.id, name: p.name })));
      setStudioOptions(studios.items.map((s) => ({ id: s.id, name: s.name })));
      setGenreOptions(genres);
    });
    return () => {
      cancelled = true;
    };
  }, [entitled, restrictedState.locked]);

  useEffect(() => {
    if (!countLoading && !entitled) {
      router.replace("/home");
    }
  }, [countLoading, entitled, router]);

  const filters = useMemo(() => parseZoneBrowseFilters(searchParams), [searchParams]);

  const updateFilters = useCallback(
    (next: ZoneBrowseFilters) => {
      const qs = zoneBrowseFiltersToSearchParams(next).toString();
      router.replace(qs ? `/restricted/browse?${qs}` : "/restricted/browse");
    },
    [router],
  );

  const resetKey = restrictedState.locked ? null : JSON.stringify(filters);
  const { items, hasMore, loading, loadingMore, loadMoreError, loadMore } = useCursorFeed<RestrictedBrowseItem>(
    (cursor) => fetchBrowsePage(filters, cursor),
    resetKey,
  );

  function handleDensityChange(next: ZoneDensity): void {
    setDensityState(next);
    setZoneDensity(next);
  }

  if (countLoading || !entitled) {
    return null;
  }

  if (restrictedState.locked) {
    return (
      <div className={styles.page}>
        <RestrictedGate itemCount={count} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Browse</h1>

      <div className={styles.toolbar}>
        <ZoneFilterBar
          filters={filters}
          onChange={updateFilters}
          onClear={() => updateFilters(clearZoneFilters(filters))}
          hasActiveFilters={hasActiveZoneFilters(filters)}
          performers={performerOptions}
          studios={studioOptions}
          genres={genreOptions}
        />
        <div className={styles.toolbarRight}>
          <ZoneSortControl active={filters.sort} onChange={(sort: ZoneSort) => updateFilters({ ...filters, sort })} />
          <ZoneDensityToggle density={density} onChange={handleDensityChange} />
        </div>
      </div>

      {accessToken === null ? (
        <ZoneBrowseGrid
          items={[]}
          hasMore={false}
          loading
          loadingMore={false}
          onLoadMore={() => {}}
          density={density}
          serverUrl={serverUrl}
          accessToken=""
          ariaLabel="Restricted zone scenes"
        />
      ) : !loading && items.length === 0 && hasActiveZoneFilters(filters) ? (
        // README "Restricted content": "an empty result shows a dashed
        // empty state with a CLEAR SEARCH & FILTERS reset" — distinct from
        // the zone genuinely having zero scenes at all (ZoneBrowseGrid's
        // own plain emptyMessage, below), which no filter reset can fix.
        <RestrictedZoneEmptyState onClear={() => updateFilters(clearZoneFilters(filters))} />
      ) : (
        <ZoneBrowseGrid
          items={items}
          hasMore={hasMore}
          loading={loading}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          onLoadMore={loadMore}
          density={density}
          serverUrl={serverUrl}
          accessToken={accessToken}
          ariaLabel="Restricted zone scenes"
          emptyMessage="This zone has no scenes yet."
        />
      )}
    </div>
  );
}

export default function RestrictedBrowsePage(): React.JSX.Element {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <BrowseContent />
      </Suspense>
    </AppShell>
  );
}
