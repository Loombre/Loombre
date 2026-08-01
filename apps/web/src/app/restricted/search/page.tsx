// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/app/restricted/search/page.tsx
//
// STATE.md Stash run (S9): the zone's own scoped search — ?q= deep-link +
// ~250ms debounce, same recipe app/search/page.tsx established (lib/
// debounce.ts), against the zone-scoped GET /restricted/search instead of
// the general GET /search — a SEPARATE guarded index (that endpoint's own
// contract doc comment), so this route never shares a code path or result
// set with the general SearchPanel.

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { components } from "@loombre/sdk";
import { AppShell } from "../../../components/shell/AppShell.js";
import { RestrictedGate } from "../../../components/restricted/RestrictedGate.js";
import { ZoneBrowseGrid } from "../../../components/restricted/ZoneBrowseGrid.js";
import { SearchField } from "../../../components/ui/Input.js";
import { useRestricted } from "../../../components/restricted/RestrictedProvider.js";
import { hasRestrictedZoneEntitlement, useRestrictedZoneCount } from "../../../lib/restricted-zone-count.js";
import { debounce } from "../../../lib/debounce.js";
import { apiGet } from "../../../lib/api-client.js";
import { getAuthStore } from "../../../lib/auth-store.js";
import styles from "./page.module.css";

type RestrictedBrowseItem = components["schemas"]["RestrictedBrowseItem"];

const DEBOUNCE_MS = 250;

function SearchContent(): React.JSX.Element | null {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state: restrictedState } = useRestricted();
  const { count, loading: countLoading } = useRestrictedZoneCount();
  const entitled = hasRestrictedZoneEntitlement(count);

  const initialQuery = searchParams.get("q") ?? "";
  const [inputValue, setInputValue] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [results, setResults] = useState<RestrictedBrowseItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    if (!countLoading && !entitled) router.replace("/home");
  }, [countLoading, entitled, router]);

  useEffect(() => {
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  const debouncedSetQuery = useRef(
    debounce((value: string) => {
      setDebouncedQuery(value);
      const url = value.trim() ? `/restricted/search?q=${encodeURIComponent(value)}` : "/restricted/search";
      router.replace(url);
    }, DEBOUNCE_MS),
  ).current;

  useEffect(() => () => debouncedSetQuery.cancel(), [debouncedSetQuery]);

  useEffect(() => {
    if (restrictedState.locked || !entitled || debouncedQuery.trim() === "") {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    apiGet("/restricted/search", { params: { query: { q: debouncedQuery, limit: 60 } } })
      .then((page) => {
        if (!cancelled) setResults(page.items);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, restrictedState.locked, entitled]);

  function handleChange(value: string): void {
    setInputValue(value);
    debouncedSetQuery(value);
  }

  if (countLoading || !entitled) return null;

  if (restrictedState.locked) {
    return (
      <div className={styles.page}>
        <RestrictedGate itemCount={count} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <SearchField
        className={styles.field}
        name="restricted-search"
        placeholder="Search this zone…"
        value={inputValue}
        onChange={(e) => handleChange(e.target.value)}
        autoFocus
        aria-label="Search restricted zone"
      />

      {debouncedQuery.trim() === "" ? (
        <div className={styles.hint}>Search titles, performers, studios, and tags within the zone.</div>
      ) : accessToken === null ? null : (
        <ZoneBrowseGrid
          items={results}
          hasMore={false}
          loading={searching && results.length === 0}
          loadingMore={false}
          onLoadMore={() => {}}
          density="wall"
          serverUrl={serverUrl}
          accessToken={accessToken}
          ariaLabel="Restricted zone search results"
          emptyMessage="No matches."
        />
      )}
    </div>
  );
}

export default function RestrictedSearchPage(): React.JSX.Element {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <SearchContent />
      </Suspense>
    </AppShell>
  );
}
