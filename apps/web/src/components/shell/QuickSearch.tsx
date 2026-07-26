// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/QuickSearch.tsx
//
// Topbar search-as-you-type: same debounced GET /search + GET /people flow
// as the full /search page (components/browse/SearchPanel.tsx), rendered
// in a glass popover so search is reachable from any authenticated route,
// not just the dedicated page. Enter with no result highlighted falls
// through to the full page (?q=...); Escape/outside-click closes.
//
// Wave 2 L7 (⌘K polish, README "Interactions → Keyboard"): this file had
// NO keyboard shortcut at all before this lane — opening it required
// clicking/focusing the field directly. Added: a window-level Cmd+K/
// Ctrl+K listener that focuses the field (see quick-search-sources.ts for
// why screens/actions are instant local matches rendered above the
// debounced catalog results, not a second network round-trip). Escape
// semantics were already correctly scoped — this component's own
// handleKeyDown only ever flips ITS OWN `open` state, never touches any
// other modal/sheet — the ⌘K listener doesn't change that; it only adds a
// keybinding to OPEN, never a global-Escape handler that could stomp on
// an unrelated overlay.

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchField } from "../ui/Input.js";
import { SearchPanel, type SearchPanelHandle } from "../browse/SearchPanel.js";
import { debounce } from "../../lib/debounce.js";
import { getAuthStore } from "../../lib/auth-store.js";
import { useRestricted } from "../restricted/RestrictedProvider.js";
import {
  PALETTE_RESULT_LIMIT,
  filterPaletteActions,
  filterPaletteScreens,
  type PaletteAction,
  type PaletteScreen,
} from "./quick-search-sources.js";
import styles from "./QuickSearch.module.css";

const DEBOUNCE_MS = 250;

export function QuickSearch({ isAdmin }: { isAdmin: boolean }): React.JSX.Element {
  const router = useRouter();
  const restricted = useRestricted();
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [serverUrl] = useState(() => getAuthStore().getSnapshot().serverUrl);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelHandleRef = useRef<SearchPanelHandle | null>(null);

  useEffect(() => {
    getAuthStore()
      .getAccessToken()
      .then(setAccessToken);
  }, []);

  const debouncedSetQuery = useRef(debounce((value: string) => setDebouncedQuery(value), DEBOUNCE_MS)).current;
  useEffect(() => () => debouncedSetQuery.cancel(), [debouncedSetQuery]);

  useEffect(() => {
    function onDocumentMouseDown(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, []);

  // ⌘K / Ctrl+K: focus the field from anywhere on an authenticated route.
  // Deliberately narrow — it only ever opens THIS component; it is not a
  // global command bus and does not reach into any other overlay's state.
  useEffect(() => {
    function onWindowKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        containerRef.current?.querySelector("input")?.focus();
      }
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []);

  function handleChange(value: string): void {
    setInputValue(value);
    debouncedSetQuery(value);
    setOpen(true);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      setOpen(false);
      event.currentTarget.blur();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      panelHandleRef.current?.moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      panelHandleRef.current?.moveActive(-1);
    } else if (event.key === "Enter") {
      const activated = panelHandleRef.current?.activateFocused() ?? false;
      if (!activated && inputValue.trim()) {
        setOpen(false);
        router.push(`/search?q=${encodeURIComponent(inputValue)}`);
      }
    }
  }

  function goToScreen(screen: PaletteScreen): void {
    setOpen(false);
    setInputValue("");
    router.push(screen.href);
  }

  function runAction(action: PaletteAction): void {
    setOpen(false);
    setInputValue("");
    action.onSelect();
  }

  // Actions mirror the prototype's user-menu items (lock/unlock, sign out)
  // rather than admin business logic (scan triggers etc. need per-library
  // ids and would duplicate app/admin/libraries/page.tsx — see this file's
  // header and the freeze report for the scope call).
  const actions: PaletteAction[] = [
    restricted.state.locked
      ? { key: "unlock-restricted", label: "Unlock restricted content", onSelect: restricted.openUnlockModal }
      : { key: "lock-restricted", label: "Lock restricted content", onSelect: () => void restricted.lock() },
    {
      key: "sign-out",
      label: "Sign out",
      onSelect: () => {
        void getAuthStore()
          .logout()
          .then(() => router.replace("/login"));
      },
    },
  ];

  const screenMatches = filterPaletteScreens(inputValue, isAdmin);
  const actionMatches = filterPaletteActions(inputValue, actions);
  const paletteEntries = [...screenMatches.map((s) => ({ kind: "screen" as const, screen: s })), ...actionMatches.map((a) => ({ kind: "action" as const, action: a }))].slice(
    0,
    PALETTE_RESULT_LIMIT,
  );

  return (
    <div className={styles.container} ref={containerRef}>
      <SearchField
        className={styles.field}
        name="quick-search"
        placeholder="Search…"
        value={inputValue}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        aria-label="Search"
      />
      {open && inputValue.trim().length > 0 && (
        <div className={styles.popover}>
          {paletteEntries.length > 0 && (
            <div className={styles.paletteGroup}>
              {paletteEntries.map((entry) =>
                entry.kind === "screen" ? (
                  <button
                    key={`screen-${entry.screen.key}`}
                    type="button"
                    className={styles.paletteRow}
                    onClick={() => goToScreen(entry.screen)}
                  >
                    <span className={styles.paletteLabel}>{entry.screen.label}</span>
                    <span className={styles.paletteHint}>Screen</span>
                  </button>
                ) : (
                  <button
                    key={`action-${entry.action.key}`}
                    type="button"
                    className={styles.paletteRow}
                    onClick={() => runAction(entry.action)}
                  >
                    <span className={styles.paletteLabel}>{entry.action.label}</span>
                    <span className={styles.paletteHint}>Action</span>
                  </button>
                ),
              )}
            </div>
          )}
          {debouncedQuery.trim().length > 0 && accessToken !== null && (
            <SearchPanel
              query={debouncedQuery}
              serverUrl={serverUrl}
              accessToken={accessToken}
              onNavigate={() => setOpen(false)}
              registerHandle={(handle) => {
                panelHandleRef.current = handle;
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
