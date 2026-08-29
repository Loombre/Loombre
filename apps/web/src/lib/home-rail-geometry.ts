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
// rail indices 10/11/12 all still eligible featured candidates.
//
// The fix is to make the assumption TRUE rather than to guess a bigger
// number: the shell caps the CONTENT COLUMN at SHELL_CONTENT_MAX_WIDTH_PX
// below, so the fold stops growing exactly where this count was derived.
// home-rail-geometry.test.ts reads components/shell/AppShell.module.css and
// fails if that cap is missing or stops matching this file, so the two can
// never silently diverge.
//
// E3 / UD-18 (run UIFIX-2026-08-29) — WHAT CHANGED AND WHY IT MATTERS HERE.
// The cap used to live on `.main` itself as `max-width: 1920px`, and this
// module modelled it that way: a SHELL_MAIN_MAX_WIDTH_PX of 1920 with the
// content column DERIVED from it by subtracting the sidebar and gutters.
// That capped the padded box, which also left the whole app packed against
// the left edge of any wider display (640px of dead space on one side at
// 2560px). The cap now sits on `.main > *` as a real 1646px content width
// with `margin-inline: auto`, so the column is centred instead.
//
// So 1646 is a FIRST-CLASS CONSTANT here now, not a derivation. That is not
// cosmetic: `railCardsInFold` subtracts the sidebar and gutters off the
// VIEWPORT to find the content width available at a given display size, so
// a cap expressed in .main terms would be subtracted a second time and the
// count would come out short. The cap and the available width are now the
// same kind of number — content pixels — and the min() between them is the
// only place they meet. (1646 is still the number the old arithmetic
// produced: 1920 − 210 − 2 × 32. It is stated once, not recomputed.)
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
 *  .main clears it with padding, so it is not content width. Used here to
 *  turn a VIEWPORT width into the content width available at it. */
export const SHELL_SIDEBAR_PX = 210;

/** .main's --space-xl gutter, once per side (styles/tokens.css). */
export const SHELL_GUTTER_PX = 32;

/** The widest the content column is ever allowed to get, enforced by
 *  components/shell/AppShell.module.css's `.main > * { max-width }` (which
 *  also centres it with `margin-inline: auto`). Content pixels — the
 *  sidebar and the gutters are already outside this number. */
export const SHELL_CONTENT_MAX_WIDTH_PX = 1646;

/** How many poster cards fit across `contentWidthPx` of rail. A card only
 *  PARTLY on screen counts (it is visible, and a visible duplicate is what
 *  the README forbids), hence `ceil`. One home for the rounding rule so the
 *  two exports below cannot round differently. */
function cardsAcross(contentWidthPx: number): number {
  return Math.max(0, Math.ceil(contentWidthPx / RAIL_CARD_TRACK_PX));
}

/**
 * How many poster cards of a rail share the fold at `viewportPx`.
 *
 * `contentMaxWidthPx` is the shell's own content cap, in CONTENT pixels
 * (SHELL_CONTENT_MAX_WIDTH_PX): pass `null` to model a shell with no cap at
 * all, which is what the test does to show what the defect looked like.
 */
export function railCardsInFold(viewportPx: number, contentMaxWidthPx: number | null): number {
  const availableWidth = viewportPx - SHELL_SIDEBAR_PX - SHELL_GUTTER_PX * 2;
  return cardsAcross(Math.min(availableWidth, contentMaxWidthPx ?? Number.POSITIVE_INFINITY));
}

/** = 10. The Recently Added ids Home excludes from the featured pool
 *  (app/home/HomeContent.tsx, via lib/featured-pool.ts's visibleRailIds).
 *  Cards past this are behind the rail's own horizontal scroll at every
 *  width the capped shell can reach, i.e. NOT in the banner's fold. Read
 *  straight off the capped column: at and above the cap the fold IS the
 *  cap, so no viewport is involved. */
export const RECENTLY_ADDED_VISIBLE_CARDS = cardsAcross(SHELL_CONTENT_MAX_WIDTH_PX);
