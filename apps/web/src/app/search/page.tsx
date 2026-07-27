// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/search/page.tsx
//
// Full search page: search-as-you-type against GET /search (+ GET /people),
// debounced ~250ms (lib/debounce.ts), grouped results, keyboard nav
// (ArrowUp/Down cycles results, Enter opens the highlighted one). Deep-
// linkable via ?q= so a shared/bookmarked URL reproduces the same search.
//
// Restricted invisibility is server-side already (P1.21/leak suite) — this
// page renders exactly what GET /search and GET /people return, with no
// client-side filtering of its own.
//
// Phosphor H5 (Wave-3 fix lane FX3): `onSelectQuery={handleChange}` below
// is the one line SearchPanel.tsx's RECENT pills need from this page — a
// pill click reuses the exact same path a real keystroke takes (updates
// the field + fires the debounced search), so recent-search selection
// can't drift from typed-search behavior.

"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SearchField } from "../../components/ui/Input.js";
import { AppShell } from "../../components/shell/AppShell.js";
import { SearchPanel, type SearchPanelHandle } from "../../components/browse/SearchPanel.js";
import { debounce } from "../../lib/debounce.js";
import { getAuthStore } from "../../lib/auth-store.js";
import styles from "./page.module.css";

const DEBOUNCE_MS = 250;

function SearchContent(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const [inputValue, setInputValue] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const panelHandleRef = useRef<SearchPanelHandle | null>(null);

  useEffect(() => {
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  const debouncedSetQuery = useRef(
    debounce((value: string) => {
      setDebouncedQuery(value);
      const url = value.trim() ? `/search?q=${encodeURIComponent(value)}` : "/search";
      router.replace(url);
    }, DEBOUNCE_MS),
  ).current;

  useEffect(() => () => debouncedSetQuery.cancel(), [debouncedSetQuery]);

  function handleChange(value: string): void {
    setInputValue(value);
    debouncedSetQuery(value);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      panelHandleRef.current?.moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      panelHandleRef.current?.moveActive(-1);
    } else if (event.key === "Enter") {
      if (panelHandleRef.current?.activateFocused()) event.preventDefault();
    }
  }

  const registerHandle = useCallback((handle: SearchPanelHandle | null) => {
    panelHandleRef.current = handle;
  }, []);

  return (
    <div className={styles.page}>
      <SearchField
        className={styles.field}
        name="search"
        placeholder="Search movies, series, music, people…"
        value={inputValue}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        aria-label="Search"
      />
      <div className={styles.results}>
        {accessToken !== null && (
          <SearchPanel
            query={debouncedQuery}
            serverUrl={serverUrl}
            accessToken={accessToken}
            registerHandle={registerHandle}
            onSelectQuery={handleChange}
            paginated
          />
        )}
      </div>
    </div>
  );
}

export default function SearchPage(): React.JSX.Element {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <SearchContent />
      </Suspense>
    </AppShell>
  );
}
