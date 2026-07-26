// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/restricted-zone-items.ts
//
// GET /restricted/items (STATE.md Phosphor retheme, Wave 2 lane L8; design/
// phosphor README "Interactions -> Restricted content"): fetches the zone's
// items IN FULL (paginating the cursor to completion) so the zone's own
// toolbar (lib/restricted-zone-toolbar.ts) can search/filter/sort entirely
// client-side over one small, curated collection — see that module's
// header and the server-side query's own header (packages/db/src/query/
// restricted-zone.ts) for why there is no separate zone-search endpoint.
//
// 404 (not entitled at all) resolves to `entitled: false, items: null` —
// the SAME "the zone does not exist for this viewer" signal
// lib/restricted-zone-count.ts's hook already folds 404 into (U10: never a
// client-visible distinction between "no zone" and "empty zone"). Every
// OTHER failure (network error, unexpected status) folds to the same
// `entitled: false` outcome — fail closed, matching restricted-zone-count's
// own posture, never a fabricated listing.
//
// Refetches whenever `refreshKey` changes (the caller passes the
// RestrictedProvider lock-state signal — see app/restricted/page.tsx) so
// unlocking/locking the zone re-fetches real content/an empty page without
// a full route reload, same as every other lock-sensitive surface in this
// app reacting to RestrictedProvider's context value changing.

import { useEffect, useState } from "react";
import type { components } from "@loombre/sdk";
import { apiGet } from "./api-client.js";
import { getAuthStore } from "./auth-store.js";

export type RestrictedZoneItem = components["schemas"]["RestrictedZoneItem"];

export interface UseRestrictedZoneItemsResult {
  /** null while loading and whenever `entitled` is false. */
  items: RestrictedZoneItem[] | null;
  loading: boolean;
  /** false on 404 (no restricted-library entitlement at all) or any other
   *  fetch failure — see this module's header for why both fold together. */
  entitled: boolean;
}

const MAX_PAGES = 50; // generous safety cap — a curated zone, not a 50k library.

export function useRestrictedZoneItems(refreshKey: unknown): UseRestrictedZoneItemsResult {
  const [items, setItems] = useState<RestrictedZoneItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [entitled, setEntitled] = useState(true);

  useEffect(() => {
    const store = getAuthStore();
    let cancelled = false;

    async function load(): Promise<void> {
      if (!store.isAuthenticated()) {
        if (!cancelled) {
          setItems(null);
          setEntitled(false);
          setLoading(false);
        }
        return;
      }

      setLoading(true);
      try {
        const collected: RestrictedZoneItem[] = [];
        let cursor: string | null = null;
        let page = 0;
        do {
          const query = cursor ? { cursor, limit: 200 } : { limit: 200 };
          // Sequential pages, deliberately: each depends on the previous
          // page's cursor, so this cannot be parallelized.
          const result: components["schemas"]["RestrictedZoneItemPage"] = await apiGet("/restricted/items", {
            params: { query },
          });
          collected.push(...result.items);
          cursor = result.nextCursor;
          page += 1;
        } while (cursor !== null && page < MAX_PAGES);

        if (!cancelled) {
          setItems(collected);
          setEntitled(true);
          setLoading(false);
        }
      } catch {
        if (cancelled) return;
        // 404 (not entitled) and every other error fold to the same "no
        // zone" outcome — see this module's header.
        setItems(null);
        setEntitled(false);
        setLoading(false);
      }
    }

    void load();
    const unsubscribe = store.subscribe(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // refreshKey is intentionally in the dependency array only to trigger a
    // refetch (e.g. lock/unlock) — its identity, not its value, matters.
  }, [refreshKey]);

  return { items, loading, entitled };
}
