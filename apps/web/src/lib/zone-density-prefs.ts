// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/zone-density-prefs.ts
//
// STATE.md Stash run (S9): /restricted/browse's density toggle (poster
// wall <-> detailed rows, net-new — no precedent elsewhere in the app).
// Persisted client-side only, same SSR-safe localStorage recipe
// lib/appearance-prefs.ts already established for accent/scanlines (see
// that file's header for why this is the right layer: the contract's
// UserSettings schema has no generic prefs bucket, and PUT /users/me/
// settings is a documented stub that doesn't persist one either — a
// display preference like this has never had a server-side home in this
// codebase, and inventing one is out of this lane's scope).

const STORAGE_KEY = "loombre.restricted-zone.density.v1";

export type ZoneDensity = "wall" | "rows";

export const DEFAULT_ZONE_DENSITY: ZoneDensity = "wall";

export function getZoneDensity(): ZoneDensity {
  if (typeof window === "undefined") return DEFAULT_ZONE_DENSITY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "wall" || raw === "rows" ? raw : DEFAULT_ZONE_DENSITY;
  } catch {
    return DEFAULT_ZONE_DENSITY;
  }
}

export function setZoneDensity(density: ZoneDensity): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, density);
  } catch {
    // Best-effort — a blocked/full localStorage just means the preference
    // doesn't stick across reloads, never a functional failure.
  }
}
