// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/player/controls-overlay-stacking.test.ts
//
// browser-player-F8 regression pin — the quality dock vs. control bar
// stacking contract. jsdom has no layout engine, so the geometry itself was
// verified in a real browser (Playwright, 1280x800: .bottomBar rect
// {x:24, y:644.3, w:1232, h:131.7} — top edge 155.7px above the viewport
// bottom — with the radios' centers at y 665.6 inside the scrubberRow band
// y 657.3-674.7). What CAN be pinned deterministically is the CSS contract
// that made that geometry a defect:
//
//   1. .qualityDock stacked UNDER .bottomBar (z-index 3 vs 5), so every
//      pointer event at a radio's center hit the Scrubber rail / scrubberRow
//      instead — a center click on "Auto"/"1080p" committed a seek to
//      ~85-90% of the film; "720p"/"360p" clicks died on bar padding.
//   2. .qualityDock's bottom clearance (88px) did not clear the bar's real
//      height (~132px + 24px bottom offset): the dock was born clear of a
//      pre-capability-chips bar and rotted when the bar grew.
//   3. .qualityDock was a solid pointer target (pointer-events: auto on the
//      whole container), so ANY overlap in EITHER z-order turns into a
//      click shield over whatever sits beneath.
//
// These assertions parse the source CSS modules directly: the contract is
// about the stylesheet, and reading it from disk keeps the pin independent
// of jsdom's non-layout.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const videoPlayerCss = readFileSync(join(here, "VideoPlayer.module.css"), "utf8");
const playerControlsCss = readFileSync(join(here, "PlayerControls.module.css"), "utf8");
const tokensCss = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

/** The declarations of the FIRST `.name { ... }` block in a flat (non-nested)
 *  CSS module. Good enough for these stylesheets, which never nest. */
function classBlock(css: string, className: string): string {
  const body = css.match(new RegExp(String.raw`^\.${className}\b[^{]*\{([^}]*)\}`, "m"))?.[1];
  if (body === undefined) throw new Error(`no .${className} block found`);
  return body;
}

function declaration(block: string, property: string): string | null {
  const value = block.match(new RegExp(String.raw`(?:^|;)\s*${property}\s*:\s*([^;]+)`))?.[1];
  return value === undefined ? null : value.trim();
}

/** Resolves a `--space-*`-style token to its px number. */
function tokenPx(name: string): number {
  const match = tokensCss.match(new RegExp(String.raw`${name}\s*:\s*(-?[\d.]+)px`));
  if (!match) throw new Error(`token ${name} not found or not in px`);
  return Number(match[1]);
}

/** Evaluates a flat px/var() sum: `Npx`, `var(--x)`, or `calc(a + b + ...)`.
 *  The dock's clearance is exactly that shape; anything fancier should fail
 *  loudly rather than silently pass. */
function resolvePxSum(value: string): number {
  const inner = value.startsWith("calc(") ? value.slice(5, -1) : value;
  return inner.split("+").reduce((sum, rawTerm) => {
    const term = rawTerm.trim();
    const varName = term.match(/^var\((--[\w-]+)\)$/)?.[1];
    if (varName !== undefined) return sum + tokenPx(varName);
    const pxMatch = term.match(/^(-?[\d.]+)px$/);
    if (pxMatch) return sum + Number(pxMatch[1]);
    throw new Error(`unsupported term in px sum: "${term}"`);
  }, 0);
}

describe("controls overlay stacking (browser-player-F8)", () => {
  const dock = classBlock(videoPlayerCss, "qualityDock");
  const bottomBar = classBlock(playerControlsCss, "bottomBar");

  it("stacks the quality dock ABOVE the bottom control bar so the radios receive clicks", () => {
    const dockZ = Number(declaration(dock, "z-index"));
    const barZ = Number(declaration(bottomBar, "z-index"));
    expect(Number.isFinite(dockZ)).toBe(true);
    expect(Number.isFinite(barZ)).toBe(true);
    // HEAD defect: dock 3 vs bar 5 — the bar's full-width scrubberRow band
    // swallowed every radio-center click.
    expect(dockZ).toBeGreaterThan(barZ);
  });

  it("gives the dock enough bottom clearance to clear the control bar at its tallest", () => {
    // Live-measured tallest bar (scrubber row + transport row + capability
    // chips row) at 1280x800: 131.7px tall, bottom offset 24px — its top
    // edge sits 155.7px above the viewport bottom. The dock's bottom
    // clearance must exceed that or the radios sit inside the bar's band.
    const clearance = resolvePxSum(declaration(dock, "bottom") ?? "0px");
    expect(clearance).toBeGreaterThanOrEqual(164);
  });

  it("keeps the dock container click-through so an overlap never shields the controls beneath", () => {
    // Belt-and-braces for viewports where the bar grows (capability chips
    // wrapping): only the radio buttons may take pointer events; the dock's
    // padding/label/note must let clicks fall through to the bar/scrubber.
    expect(declaration(dock, "pointer-events")).toBe("none");
    const dockButtons = classBlock(videoPlayerCss, "qualityDock button");
    expect(declaration(dockButtons, "pointer-events")).toBe("auto");
  });
});
