// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/home-rail-geometry.ts
//
// The shell geometry Home's featured-pool exclusion is derived from — one
// module so the numbers cannot drift apart, and so a test can hold them
// against the stylesheet that has to enforce them.
//
// WHY THIS EXISTS (browser-shell-browse-F8-edge, backlog #087). The
// featured banner must never duplicate a card sharing its fold
// (design/phosphor/README.md; the owner ruling in lib/featured-pool.ts's
// header narrowed the exclusion from the Recently Added rail's whole fetch
// to its VISIBLE FIRST PAGE). "Visible" was computed from a 1920px display
// and frozen as a constant — but AppShell's .main had no max-width, so on
// anything wider the fold simply held more cards than the constant knew
// about: QA measured 13 Recently Added cards on screen at 2400x900, with
// rail indices 10/11/12 all still eligible featured candidates, i.e. the
// banner could and did duplicate a card in the same fold again.
//
// The fix is to make the assumption TRUE rather than to guess a bigger
// number: the shell caps .main at SHELL_MAIN_MAX_WIDTH_PX below, so the
// content column — and therefore the fold — stops growing exactly where
// this count was derived. home-rail-geometry.test.ts reads
// components/shell/AppShell.module.css and fails if that cap is missing or
// stops matching this file, so the two can never silently diverge.
//
// The alternative considered and rejected: measuring the live rail rect
// (ResizeObserver on the scroller) and recomputing the exclusion from it.
// It fixes the same defect, but the pool would then be recomputed after
// first paint — the banner can swap under the reader — and a measured
// first render cannot be produced on the server, so it trades a layout
// constant for a hydration seam. If the cap is ever lifted for design
// reasons, that measurement is the replacement, not a bigger literal.

/** One card of track in a Home rail's horizontal scroller: the 160px
 *  poster tile (components/home/PosterCard.module.css `.tile`) plus the
 *  scroller's --space-md gap (16px, styles/tokens.css). */
export const RAIL_CARD_TRACK_PX = 160 + 16;

/** The full-width desktop sidebar (components/shell/Sidebar.module.css) —
 *  .main clears it with padding, so it is not content width. */
export const SHELL_SIDEBAR_PX = 210;

/** .main's --space-xl gutter, once per side (styles/tokens.css). */
export const SHELL_GUTTER_PX = 32;

/** The widest .main is ever allowed to get, enforced by
 *  components/shell/AppShell.module.css's `.main { max-width }` (with
 *  `box-sizing: border-box` from globals.css, so it includes the padding
 *  that clears the sidebar and the gutters). */
export const SHELL_MAIN_MAX_WIDTH_PX = 1920;

/** What is left for content at that cap: 1646px. */
export const SHELL_CONTENT_MAX_WIDTH_PX = SHELL_MAIN_MAX_WIDTH_PX - SHELL_SIDEBAR_PX - SHELL_GUTTER_PX * 2;

/**
 * How many poster cards of a rail share the fold at `viewportPx` — a card
 * that is only PARTLY on screen counts (it is visible, and a visible
 * duplicate is what the README forbids), hence `ceil`.
 *
 * `mainMaxWidthPx` is the shell's own cap: pass `null` to model a shell
 * with no cap at all, which is what the test does to show what the defect
 * looked like.
 */
export function railCardsInFold(viewportPx: number, mainMaxWidthPx: number | null): number {
  const mainWidth = Math.min(viewportPx, mainMaxWidthPx ?? Number.POSITIVE_INFINITY);
  const contentWidth = mainWidth - SHELL_SIDEBAR_PX - SHELL_GUTTER_PX * 2;
  return Math.max(0, Math.ceil(contentWidth / RAIL_CARD_TRACK_PX));
}

/** = 10. The Recently Added ids Home excludes from the featured pool
 *  (app/home/HomeContent.tsx, via lib/featured-pool.ts's visibleRailIds).
 *  Cards past this are behind the rail's own horizontal scroll at every
 *  width the capped shell can reach, i.e. NOT in the banner's fold. */
export const RECENTLY_ADDED_VISIBLE_CARDS = railCardsInFold(SHELL_MAIN_MAX_WIDTH_PX, SHELL_MAIN_MAX_WIDTH_PX);
