// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/view-transition.ts
//
// Thin wrapper around the View Transitions API (P2.10: poster→detail
// shared-element transition) — instant-cut fallback when the API is
// unsupported, and prefers-reduced-motion collapses to a fade by simply
// NOT starting a transition (the browser's default same-document nav has
// no motion at all, which is the safest "fade-equivalent" instant cut; the
// actual short cross-fade for reduced-motion users happens for free via
// globals.css's `@media (prefers-reduced-motion: reduce)` rule collapsing
// all transition/animation durations to 100ms, which also governs the
// browser's own ::view-transition-group default animation — but we still
// skip starting a transition entirely below, since a same-document view
// transition briefly freezes interaction, which reduced-motion users are
// explicitly opting out of).
//
// Callers pass a synchronous DOM-mutating callback (for App Router, that's
// `router.push`, which is itself synchronous — the resulting render commit
// happens inside the transition's update callback window).

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Runs `update` inside a View Transition when supported and motion is not
 *  reduced; otherwise runs it directly (instant cut). Elements that should
 *  cross-fade/move between the two states set a matching
 *  `viewTransitionName` (see PosterCell / AmbientHero) — this function only
 *  owns starting/skipping the transition itself. `Document.startViewTransition`
 *  is already typed by TypeScript's DOM lib (it's an optional method — no
 *  custom ambient interface needed, and declaring one here would conflict
 *  with the built-in `ViewTransition` return type). */
export function runViewTransition(update: () => void): void {
  if (typeof document === "undefined" || !document.startViewTransition || prefersReducedMotion()) {
    update();
    return;
  }
  document.startViewTransition(update);
}

/** Deterministic shared-element name for a catalog item's poster/hero art,
 *  shared between the browse grid cell and the detail hero so the browser
 *  pairs them across the navigation. */
export function posterTransitionName(itemId: string): string {
  return `loombre-poster-${itemId}`;
}
