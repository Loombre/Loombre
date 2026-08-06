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

import { useSyncExternalStore } from "react";
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

// ── Module-level shared store (AUD-A4v6-003) ────────────────────────────
// This hook is mounted by ~7 shell surfaces at once on every authenticated
// page (Sidebar, UserMenu, QuickSearch, MobileTabBar, RestrictedLockControl,
// RestrictedZoneBrowseChip, the /restricted route components). The count is
// ONE piece of server state that cannot differ between them in the same
// render, so all consumers share one snapshot, one in-flight GET, and one
// auth-store subscription — N mounts must never mean N requests (the
// audited build fired 21 identical GET /restricted/count per page load).
// Same shared-loader discipline as RestrictedProvider.tsx's optIn loader.

const INITIAL: UseRestrictedZoneCountResult = { count: null, loading: true };

let snapshot: UseRestrictedZoneCountResult = INITIAL;
const listeners = new Set<() => void>();
/** Bumped on every load AND on full teardown, so a response that lands
 *  after it was superseded (or after every consumer unmounted) is
 *  discarded — the shared-store equivalent of the old per-mount
 *  `cancelled` flag. */
let fetchSeq = 0;
let unsubscribeAuth: (() => void) | null = null;

function emit(next: UseRestrictedZoneCountResult): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function load(): void {
  const store = getAuthStore();
  const seq = ++fetchSeq;
  if (!store.isAuthenticated()) {
    emit({ count: null, loading: false });
    return;
  }
  // Keep the previous count visible while a re-fetch (auth settling) is in
  // flight — same behavior the per-mount version had.
  if (!snapshot.loading) emit({ count: snapshot.count, loading: true });
  apiGet("/restricted/count")
    .then((res) => {
      if (seq === fetchSeq) emit({ count: res.count, loading: false });
    })
    .catch(() => {
      // 404 (not entitled) and every other error fold to the same
      // "no count" outcome — see this module's header.
      if (seq === fetchSeq) emit({ count: null, loading: false });
    });
}

function subscribeShared(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // First consumer: one shared auth-store subscription drives the one
    // shared re-fetch on session changes (login/logout/token refresh
    // settling — same subscription pattern RestrictedProvider.tsx's own
    // optIn loader uses, so a user switch in the same tab never leaves a
    // stale count from the PREVIOUS session). Later consumers share the
    // in-flight request / cached result instead of fetching again.
    unsubscribeAuth = getAuthStore().subscribe(load);
    load();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      // Last consumer gone: drop the auth subscription, discard any
      // still-in-flight response, and reset so the NEXT consumer starts
      // with a fresh fetch rather than a cache of unknown age.
      unsubscribeAuth?.();
      unsubscribeAuth = null;
      fetchSeq++;
      snapshot = INITIAL;
    }
  };
}

function getSharedSnapshot(): UseRestrictedZoneCountResult {
  return snapshot;
}

function getServerSnapshot(): UseRestrictedZoneCountResult {
  return INITIAL;
}

/** All mounted consumers share one snapshot, one in-flight request, and one
 *  auth-store subscription — see the module-level store above. */
export function useRestrictedZoneCount(): UseRestrictedZoneCountResult {
  return useSyncExternalStore(subscribeShared, getSharedSnapshot, getServerSnapshot);
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
