// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/player/scrubber-hit-target.test.ts
//
// d3-a5 (A/gap-F4) regression pin — the scrubber's hit target vs the
// control bar's show/hide motion. PlayerControls' `.bottomBar.hidden`
// carries `transform: translateY(8px)`, so while the bar is transitioning
// (the `--motion-base` window right after the controls wake, or as they
// fade) the whole scrubber sits up to 8px away from where the viewer just
// saw it. The Scrubber `.track` was only 14px tall: a click at the track's
// former y landed on `.scrubberRow` (a plain flex container) and committed
// NOTHING — the verifier's "one POST per gesture" showed zero POSTs for a
// visually-on-the-rail click.
//
// The fix keeps the bar's motion (it is deliberate design polish) and
// instead extends the track's HIT AREA with an absolutely-positioned
// `::before` overlay — pointer events on a pseudo-element are dispatched to
// its originating element, and the Scrubber's own math only ever reads
// clientX, so a vertically-padded target changes which clicks REACH the
// slider, never what they commit.
//
// jsdom has no layout engine, so — exactly like
// controls-overlay-stacking.test.ts (browser-player-F8), whose helpers this
// file mirrors — the pin parses the source CSS modules directly:
//   1. the vertical extension must cover the transition's shift in BOTH
//      directions (a click aimed at any pixel of the track band must still
//      hit it after an 8px offset either way);
//   2. the DOWNWARD extension must not exceed the bottomBar's row gap —
//      `.track` is a positioned element, so anything past the gap would
//      paint over (and steal clicks from) the transport row beneath.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const scrubberCss = readFileSync(join(here, "Scrubber.module.css"), "utf8");
const playerControlsCss = readFileSync(join(here, "PlayerControls.module.css"), "utf8");
const tokensCss = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

/** The declarations of the FIRST block whose selector line starts with
 *  `selector` (flat, non-nested CSS modules — same assumption as
 *  controls-overlay-stacking.test.ts, but accepting compound selectors like
 *  `.bottomBar.hidden` and `.track::before`). */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(new RegExp(String.raw`^${escaped}\s*\{([^}]*)\}`, "m"))?.[1];
  if (body === undefined) throw new Error(`no ${selector} block found`);
  return body;
}

function declaration(blockBody: string, property: string): string | null {
  const value = blockBody.match(new RegExp(String.raw`(?:^|;)\s*${property}\s*:\s*([^;]+)`))?.[1];
  return value === undefined ? null : value.trim();
}

function tokenPx(name: string): number {
  const match = tokensCss.match(new RegExp(String.raw`${name}\s*:\s*(-?[\d.]+)px`));
  if (!match) throw new Error(`token ${name} not found or not in px`);
  return Number(match[1]);
}

/** The bar's hidden-state vertical shift, in px — the motion the hit area
 *  must survive. Read from the stylesheet so the pin tracks the design. */
function hiddenShiftPx(): number {
  const transform = declaration(block(playerControlsCss, ".bottomBar.hidden"), "transform");
  const match = transform?.match(/^translateY\((-?[\d.]+)px\)$/);
  if (!match) throw new Error(`.bottomBar.hidden transform is not a plain translateY: ${transform}`);
  return Math.abs(Number(match[1]));
}

/** The `::before` overlay's vertical extensions, in px (positive = how far
 *  the hit area extends beyond the track's own box). Pinned to the exact
 *  `inset: -Tpx 0 -Bpx` shape so a rewrite that changes the mechanism has
 *  to come back here and re-prove the geometry. */
function hitExtensionPx(): { top: number; bottom: number } {
  const before = block(scrubberCss, ".track::before");
  expect(declaration(before, "content"), "the overlay needs content to exist for hit-testing").toBe('""');
  expect(declaration(before, "position")).toBe("absolute");
  const inset = declaration(before, "inset");
  const match = inset?.match(/^(-[\d.]+)px\s+0\s+(-[\d.]+)px$/);
  if (!match) throw new Error(`.track::before inset is not the pinned "-Tpx 0 -Bpx" shape: ${inset}`);
  return { top: -Number(match[1]), bottom: -Number(match[2]) };
}

describe("scrubber hit target vs controls transition (d3-a5)", () => {
  it("extends the track's hit area past the show/hide shift in both directions", () => {
    const shift = hiddenShiftPx();
    const { top, bottom } = hitExtensionPx();
    expect(shift).toBeGreaterThan(0); // the motion this pin exists for
    expect(
      top,
      "a click at the track's former y (bar still translated down, mid-show) must still hit the slider",
    ).toBeGreaterThanOrEqual(shift);
    expect(
      bottom,
      "a click aimed while the bar was still low (mid-show, aimed early) must still hit the slider",
    ).toBeGreaterThanOrEqual(shift);
  });

  it("never lets the downward extension shield the transport row beneath the scrubber", () => {
    // `.track` is position:relative — a positioned element paints (and
    // hit-tests) above the static buttons in the same stacking context, so
    // the overlay may extend at most the bottomBar's own row gap.
    const rowGap = declaration(block(playerControlsCss, ".bottomBar"), "gap");
    if (rowGap === null) throw new Error("bottomBar row gap not found");
    const gapPx = tokenPx(rowGap.match(/^var\((--[\w-]+)\)$/)?.[1] ?? rowGap);
    expect(hitExtensionPx().bottom).toBeLessThanOrEqual(gapPx);
  });
});
