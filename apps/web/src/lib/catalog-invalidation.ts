// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/catalog-invalidation.ts
//
// Tiny pub-sub so restricted lock/unlock transitions (P2.8: "invalidate/
// refetch all catalog data so restricted rows vanish without reload") can
// signal every catalog-data-fetching component in the app, without those
// components needing to know about restricted state or the events socket
// directly. RestrictedProvider (components/restricted/) emits on every
// confirmed lock<->unlock transition; browse/detail/search data-fetching
// (owned by the other Wave-2 lane, not this one) should call
// `subscribeCatalogInvalidation()` and refetch on signal — that wiring is
// out of this lane's file ownership, so this module is the adoption seam:
// documented in the wave report, not force-wired into someone else's code.
//
// No React dependency on purpose: usable from a plain useEffect via
// `subscribeCatalogInvalidation(cb)` -> unsubscribe function, same shape as
// AuthStore.subscribe / EventsSocket.subscribe elsewhere in this app.

export type InvalidationListener = () => void;

const listeners = new Set<InvalidationListener>();

export function subscribeCatalogInvalidation(listener: InvalidationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitCatalogInvalidation(): void {
  for (const listener of listeners) listener();
}
