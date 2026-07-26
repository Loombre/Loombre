// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/lib/restricted-zone-count.ts
//
// GET /restricted/count (STATE.md Phosphor retheme, W1c "contract
// enablers" lane; design/phosphor/README.md "Interactions -> Restricted
// content", U10): the zone's aggregate item count, visible to entitled
// viewers regardless of current lock state. This lane's own scope is
// contract + server + minimal sidebar wiring ONLY — the Restricted zone
// screen itself is Wave 2 L8's scope (design/phosphor README "Screens":
// `/restricted`, NEW). This hook is exported, ready to use, and
// DELIBERATELY not rendered anywhere by this lane (no Sidebar nav entry,
// no Browse chip — those land with the route in W2 L8).
//
// 404 from the endpoint means "no restricted-library entitlement at all"
// (a restricted-profile viewer, docs/PLAN.md §6.4 gates 1-4 never all
// passed) — server-side absence, not a UI-hidden affordance (U10). Every
// other failure mode (network error, unexpected status) resolves the same
// way: `count: null`, fail closed, never a fabricated number.

import { useEffect, useState } from "react";
import { apiGet } from "./api-client.js";
import { getAuthStore } from "./auth-store.js";

export interface UseRestrictedZoneCountResult {
  /** null while loading, on any fetch failure, AND for a viewer with no
   *  restricted-library entitlement at all (the zone does not exist for
   *  them) — the caller cannot and must not try to distinguish these
   *  cases (U10: server-side absence, not a UI-hidden count of zero). */
  count: number | null;
  loading: boolean;
}

/** Re-fetches whenever the auth store's session changes (login/logout/
 *  token refresh settling) — same subscription pattern
 *  RestrictedProvider.tsx's own optIn loader uses, so a user switch in the
 *  same tab never leaves a stale count from the PREVIOUS session. */
export function useRestrictedZoneCount(): UseRestrictedZoneCountResult {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const store = getAuthStore();
    let cancelled = false;

    function load(): void {
      if (!store.isAuthenticated()) {
        if (!cancelled) {
          setCount(null);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      apiGet("/restricted/count")
        .then((res) => {
          if (!cancelled) {
            setCount(res.count);
            setLoading(false);
          }
        })
        .catch(() => {
          // 404 (not entitled) and every other error fold to the same
          // "no count" outcome — see this module's header.
          if (!cancelled) {
            setCount(null);
            setLoading(false);
          }
        });
    }

    load();
    const unsubscribe = store.subscribe(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { count, loading };
}

/**
 * Wave 2 (lane L8) — THE single predicate every zone-entry-point renders
 * behind: sidebar entry, Browse chip, mobile tab, account-sheet/UserMenu
 * row. `count === null` covers both "still loading" and "no entitlement at
 * all" (404 or any other failure — see this hook's own doc comment); a
 * restricted-profile viewer must see NO affordance anywhere, so every one
 * of those surfaces treats "still loading" identically to "not entitled"
 * (briefly rendering nothing rather than a flash of a zone entry that then
 * disappears is the correct default here — there is no server-truth signal
 * to distinguish the two while a request is in flight, and guessing would
 * risk exactly the flash this predicate exists to prevent).
 */
export function hasRestrictedZoneEntitlement(count: number | null): boolean {
  return count !== null;
}
