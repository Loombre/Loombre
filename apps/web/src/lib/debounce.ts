// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/debounce.ts
//
// Minimal trailing-edge debounce — used by the search-as-you-type surface
// (~250ms per the Wave-2 brief) so keystrokes don't each fire a GET /search.
// No dependency pulled in for this (bundle budget, P2.6): it's ~20 lines.

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Cancel a pending trailing call without invoking it. */
  cancel: () => void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: A) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return debounced;
}
