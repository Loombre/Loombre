// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/home-rail-geometry.test.ts
//
// d4-w6 (backlog #087, browser-shell-browse-F8-edge). Home excludes the
// Recently Added rail's VISIBLE FIRST PAGE from the featured pool so the
// banner can never duplicate a card in its own fold. That count was
// derived from a 1920px display and frozen, while AppShell's .main grew
// with the viewport — so on a wider display the fold held cards the
// exclusion had never heard of. QA measured it at 2400x900: 13 cards on
// screen, rail indices 10/11/12 all still eligible candidates.
//
// The count is only honest if the shell actually enforces the width it was
// derived from, so this reads components/shell/AppShell.module.css and
// holds the two together. jsdom computes no layout, which is why the
// stylesheet text is the evidence here (the same precedent as
// components/restricted/ZoneFilterBar.test.tsx and
// components/admin/settings/phosphor-mobile-css.test.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { visibleRailIds } from "./featured-pool.js";
import {
  RAIL_CARD_TRACK_PX,
  RECENTLY_ADDED_VISIBLE_CARDS,
  SHELL_CONTENT_MAX_WIDTH_PX,
  SHELL_MAIN_MAX_WIDTH_PX,
  railCardsInFold,
} from "./home-rail-geometry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_SHELL_CSS = readFileSync(path.join(__dirname, "../components/shell/AppShell.module.css"), "utf8");

/**
 * The `max-width` .main gets from the UNCONDITIONAL rule, in px, or null
 * when it has none. Media-nested `.main` rules are skipped deliberately: a
 * cap that only applies inside a breakpoint is exactly the shape of bug
 * this file exists to catch (see ZoneFilterBar.test.tsx's d4-w7 model).
 */
function mainMaxWidthPx(css: string): number | null {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/\.main\s*\{([^}]*)\}/g)) {
    const prefix = source.slice(0, match.index);
    const depth = (prefix.match(/\{/g) ?? []).length - (prefix.match(/\}/g) ?? []).length;
    if (depth !== 0) continue; // inside @media
    const width = /(?:^|[;\s])max-width:\s*([\d.]+)px/.exec(match[1]!);
    if (width) return Number(width[1]);
  }
  return null;
}

describe("Home rail geometry — the featured banner's fold (d4-w6)", () => {
  const cap = mainMaxWidthPx(APP_SHELL_CSS);

  it("shows no more Recently Added cards than the featured pool excludes, on a 2400px display", () => {
    expect(
      railCardsInFold(2400, cap),
      "more cards share the banner's fold than the exclusion covers: the extra rail indices are still eligible " +
        "featured candidates, so the banner can duplicate a card in the same fold (backlog #087, measured 13 at 2400x900)",
    ).toBe(RECENTLY_ADDED_VISIBLE_CARDS);
  });

  it("caps .main at the width the count is derived from", () => {
    expect(
      cap,
      "components/shell/AppShell.module.css must cap .main at SHELL_MAIN_MAX_WIDTH_PX — the count in " +
        "lib/home-rail-geometry.ts is a stale literal on any wider display without it",
    ).toBe(SHELL_MAIN_MAX_WIDTH_PX);
  });

  it("leaves every narrower display alone (the exclusion may over-cover, never under-cover)", () => {
    for (const viewport of [1280, 1440, 1600, 1920]) {
      expect(railCardsInFold(viewport, cap), `${viewport}px`).toBeLessThanOrEqual(RECENTLY_ADDED_VISIBLE_CARDS);
    }
    expect(railCardsInFold(1920, cap)).toBe(RECENTLY_ADDED_VISIBLE_CARDS);
  });

  it("counts a partly-visible card as in the fold (a visible duplicate is still a duplicate)", () => {
    expect(SHELL_CONTENT_MAX_WIDTH_PX / RAIL_CARD_TRACK_PX).toBeLessThan(RECENTLY_ADDED_VISIBLE_CARDS);
    expect(RECENTLY_ADDED_VISIBLE_CARDS * RAIL_CARD_TRACK_PX).toBeGreaterThan(SHELL_CONTENT_MAX_WIDTH_PX);
  });

  it("hands the featured pool exactly the ids that share the fold (the real call site's shape)", () => {
    const rail = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    expect(visibleRailIds(rail, RECENTLY_ADDED_VISIBLE_CARDS)).toEqual(rail.slice(0, railCardsInFold(2400, cap)));
  });

  it("models an uncapped shell as the defect that was reported", () => {
    // Not a tautology guard: this is the number QA measured on the live
    // app before the cap existed, and it is what `cap === null` yields.
    expect(railCardsInFold(2400, null)).toBe(13);
  });
});
