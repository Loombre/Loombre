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
//
// E3 / UD-18 (run UIFIX-2026-08-29): the cap moved from `.main`
// (max-width: 1920px on the padded box, which also left every wider display
// packed against the left edge) to `.main > *` (a 1646px CONTENT cap plus
// margin-inline: auto, so the column centres). This file follows it: the
// parser now reads the inner rule, and there is a second assertion that a
// cap has NOT come back onto .main — a cap in both places would re-open the
// dead-gutter defect while every count below still passed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { visibleRailIds } from "./featured-pool.js";
import {
  RAIL_CARD_TRACK_PX,
  RECENTLY_ADDED_VISIBLE_CARDS,
  SHELL_CONTENT_MAX_WIDTH_PX,
  railCardsInFold,
} from "./home-rail-geometry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_SHELL_CSS = readFileSync(path.join(__dirname, "../components/shell/AppShell.module.css"), "utf8");

/**
 * The `max-width` in px from the first UNCONDITIONAL rule whose selector
 * matches `selector`, or null when it has none. Media-nested rules are
 * skipped deliberately: a cap that only applies inside a breakpoint is
 * exactly the shape of bug this file exists to catch (see
 * ZoneFilterBar.test.tsx's d4-w7 model).
 */
function maxWidthPx(css: string, selector: RegExp): number | null {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(selector)) {
    const prefix = source.slice(0, match.index);
    const depth = (prefix.match(/\{/g) ?? []).length - (prefix.match(/\}/g) ?? []).length;
    if (depth !== 0) continue; // inside @media
    const width = /(?:^|[;\s])max-width:\s*([\d.]+)px/.exec(match[1]!);
    if (width) return Number(width[1]);
  }
  return null;
}

/** `.main > * { ... }` — the content column, where the cap lives (UD-18). */
const CONTENT_RULE = /\.main\s*>\s*\*\s*\{([^}]*)\}/g;

/** `.main { ... }` alone — no `>`, no attribute selector. Must have no cap. */
const MAIN_RULE = /\.main\s*\{([^}]*)\}/g;

describe("Home rail geometry — the featured banner's fold (d4-w6)", () => {
  const cap = maxWidthPx(APP_SHELL_CSS, CONTENT_RULE);

  it("shows no more Recently Added cards than the featured pool excludes, on a 2400px display", () => {
    expect(
      railCardsInFold(2400, cap),
      "more cards share the banner's fold than the exclusion covers: the extra rail indices are still eligible " +
        "featured candidates, so the banner can duplicate a card in the same fold (backlog #087, measured 13 at 2400x900)",
    ).toBe(RECENTLY_ADDED_VISIBLE_CARDS);
  });

  it("caps the content column at the width the count is derived from", () => {
    expect(
      cap,
      "components/shell/AppShell.module.css must cap `.main > *` at SHELL_CONTENT_MAX_WIDTH_PX — the count in " +
        "lib/home-rail-geometry.ts is a stale literal on any wider display without it",
    ).toBe(SHELL_CONTENT_MAX_WIDTH_PX);
  });

  it("centres that column rather than capping .main itself (E3/UD-18)", () => {
    expect(
      maxWidthPx(APP_SHELL_CSS, MAIN_RULE),
      "a max-width is back on .main: capping the PADDED box is what left every display above the cap packed " +
        "against the left edge (640px of dead gutter at 2560px). The cap belongs on `.main > *`, with margin-inline",
    ).toBeNull();
    expect(
      /\.main\s*>\s*\*\s*\{[^}]*margin-inline:\s*auto/.test(APP_SHELL_CSS.replace(/\/\*[\s\S]*?\*\//g, "")),
      "`.main > *` must carry `margin-inline: auto` — a capped column that is not centred is the defect, not the fix",
    ).toBe(true);
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
