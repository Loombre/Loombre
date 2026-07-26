// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/recent-searches.ts
//
// Phosphor H5 search retheme (design/phosphor/dc:367-373, empty-query
// "RECENT" pills). Ground truth before writing this file: grepped the
// whole client for any existing "recent search" storage — none exists
// anywhere (only unrelated "recently added"/"recently-added sort" concepts
// do). Per the fix brief ("ground-truth whether recents are stored
// client-side already; if not, add localStorage recents honestly"), this
// adds one — same SSR-safe, corrupt-data-safe localStorage recipe
// lib/appearance-prefs.ts and auth-store.ts already use, not a new
// pattern. Client-only by design (no server concept of "my recent
// searches" exists in the contract, and adding one would be a contract
// change this fix wave doesn't need).

const STORAGE_KEY = "loombre.search.recent.v1";

/** Small and fixed — this is a handful of quick-access pills, not a search
 *  history feature; unbounded growth was never the intent. */
const MAX_RECENT = 8;

export function getRecentSearches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Records `query` as the most-recent search, de-duplicating case-
 *  insensitively (re-searching "Sodium" after "sodium" moves it to the
 *  front rather than showing two near-identical pills) and returns the
 *  updated list so a caller can setState with it directly instead of
 *  re-reading storage. No-ops (returns the unchanged list) for a blank
 *  query — a cleared search box should never itself become a pill. */
export function addRecentSearch(query: string): string[] {
  const trimmed = query.trim();
  const existing = getRecentSearches();
  if (!trimmed) return existing;
  const deduped = existing.filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...deduped].slice(0, MAX_RECENT);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}
