// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/restricted/ZoneFilterBar.test.tsx
//
// browser-restricted-settings-F7 (P3, QA sweep 2026-08-20/21): the zone
// browse filter disclosure had exactly ONE way to close — pressing the
// "Filters" toggle again. No Escape handling, no outside-press handling
// (unlike components/settings/RowMenu.tsx and components/shell/UserMenu.tsx,
// this codebase's own popover convention), and the panel FLOATED
// (position:absolute, z-index 20; position:fixed bottom sheet under
// 768px) over the results area. With `?yearMin=2999` the grid goes empty
// and RestrictedZoneEmptyState renders its "Clear search & filters"
// remedy directly underneath the open panel, so the panel's rect covered
// the button: elementFromPoint at the button's centre returned
// ZoneControls_filterPanel and a real click never reached it.
//
// Fix: (a) Escape + outside-press close, reusing the shared
// components/ui/overlay-hooks.ts `useEscapeKey` (the same hook
// browser-admin-F10 wired into RowMenu); (b) the panel is now a disclosure
// laid out IN FLOW — it pushes the results/empty state down instead of
// covering them, at every viewport. jsdom computes no layout and never
// evaluates the imported CSS module, so the "cannot cover" half is pinned
// against the stylesheet text itself — the established precedent in this
// suite (SegmentedControl.test.tsx, PosterCard.test.tsx, Toast.test.tsx
// all read their .module.css directly).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { ZoneFilterBar } from "./ZoneFilterBar.js";
import { RestrictedZoneEmptyState } from "./RestrictedZoneEmptyState.js";
import { parseZoneBrowseFilters } from "../../lib/zone-browse-filters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The QA repro's own URL: /restricted/browse?yearMin=2999 — an active
// filter (so the inline clear affordance renders) that matches nothing (so
// the page shows RestrictedZoneEmptyState instead of the grid).
const FILTERS = parseZoneBrowseFilters(new URLSearchParams("yearMin=2999"));

const PERFORMERS = [{ id: "p1", name: "Performer One" }];
const STUDIOS = [{ id: "s1", name: "Studio One" }];
const GENRES = [{ id: "g1", name: "Genre One" }];

describe("ZoneFilterBar — dismissing the filter disclosure (browser-restricted-settings-F7)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function renderBar(onClear: () => void = () => {}): void {
    view = renderIntoBody(
      <ZoneFilterBar
        filters={FILTERS}
        onChange={() => {}}
        onClear={onClear}
        hasActiveFilters
        performers={PERFORMERS}
        studios={STUDIOS}
        genres={GENRES}
      />,
    );
  }

  function toggle(): HTMLButtonElement {
    return view!.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  }

  function panel(): HTMLElement | null {
    return view!.container.querySelector<HTMLElement>('[class*="filterPanel"]');
  }

  async function open(): Promise<void> {
    await act(async () => {
      toggle().click();
    });
  }

  it("opens and closes from the Filters toggle (pre-existing behaviour, pinned)", async () => {
    renderBar();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    await open();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel()).not.toBeNull();
    await open();
    expect(panel()).toBeNull();
  });

  it("closes on Escape, returning focus to the Filters toggle", async () => {
    renderBar();
    await open();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel(), "expected Escape to close the filter panel").toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  // REOPEN follow-up (2026-08-24 verifier): the first fix dismissed on
  // outside POINTERDOWN. With the panel laid out in flow that unmounts it
  // while the user's press is still in flight — the page reflows, whatever
  // sat below the panel (the empty state's "Clear search & filters" remedy
  // in the QA repro) jumps ~380px UP under the still-held pointer, and the
  // subsequent pointerup + click retarget to AppShell: the pressed
  // control's own handler never runs. Dismissal must wait for the press to
  // COMPLETE (its click), leaving layout untouched until then. jsdom has
  // no layout, so these tests pin the mechanism instead: the panel stays
  // mounted through pointerdown/pointerup and collapses only on click.

  it("does not collapse at pointerdown — an outside press in flight must not reflow the page", async () => {
    renderBar();
    await open();
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(
      panel(),
      "dismissing at pointerdown reflows the page under a press in flight (F7 reopen): the panel must stay mounted until the click completes",
    ).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    expect(panel(), "pointerup alone must not collapse the panel — the click has not fired yet").not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(panel(), "expected the completed outside press (its click) to close the filter panel").toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on an outside click alone (keyboard/AT activation dispatches no pointer events)", async () => {
    renderBar();
    await open();
    await act(async () => {
      document.body.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(panel(), "expected an outside click to close the filter panel").toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open when the press lands on one of its own controls", async () => {
    renderBar();
    await open();
    const checkbox = panel()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      checkbox.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      checkbox.dispatchEvent(new Event("pointerup", { bubbles: true }));
      checkbox.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(panel(), "a press inside the panel must not dismiss it").not.toBeNull();
  });

  it("stops listening once closed (no stray document listeners after unmount)", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    try {
      renderBar();
      await open();
      expect(addSpy.mock.calls.some(([type]) => type === "click")).toBe(true);
      await act(async () => {
        toggle().click();
      });
      expect(removeSpy.mock.calls.some(([type]) => type === "click")).toBe(true);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});

describe("ZoneFilterBar — the open panel never covers the empty state's remedy (browser-restricted-settings-F7)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  const css = readFileSync(path.join(__dirname, "ZoneControls.module.css"), "utf8");

  function filterPanelRules(): string[] {
    const blocks = [...css.matchAll(/\.filterPanel\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(blocks.length, "expected at least one .filterPanel rule in ZoneControls.module.css").toBeGreaterThan(0);
    return blocks;
  }

  it("lays the panel out in flow — never absolute/fixed, at any viewport", () => {
    for (const rule of filterPanelRules()) {
      expect(
        rule,
        "a floating .filterPanel covers RestrictedZoneEmptyState's 'Clear search & filters' button (F7): the panel must push content, not overlay it",
      ).not.toMatch(/position:\s*(absolute|fixed)/);
    }
  });

  it("keeps the panel bounded and scrollable rather than growing past the viewport", () => {
    const [desktop] = filterPanelRules();
    expect(desktop).toMatch(/max-height:/);
    expect(desktop).toMatch(/overflow-y:\s*auto/);
  });

  it("leaves the filtered-empty state's Clear search & filters button live while the panel is open", async () => {
    const onClear = vi.fn();
    view = renderIntoBody(
      <>
        <ZoneFilterBar
          filters={FILTERS}
          onChange={() => {}}
          onClear={onClear}
          hasActiveFilters
          performers={PERFORMERS}
          studios={STUDIOS}
          genres={GENRES}
        />
        <RestrictedZoneEmptyState onClear={onClear} />
      </>,
    );
    await act(async () => {
      view!.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    });
    const panel = view.container.querySelector<HTMLElement>('[class*="filterPanel"]')!;
    expect(panel).not.toBeNull();

    const remedy = [...view.container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").toLowerCase().includes("clear search"),
    )!;
    expect(remedy, "expected the empty state's remedy button").toBeDefined();
    // In flow the remedy follows the panel in document order and is never
    // inside it — the two occupy different rows of the page, so nothing
    // can intercept the press.
    expect(panel.contains(remedy)).toBe(false);
    expect(panel.compareDocumentPosition(remedy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The press lifecycle exactly as a browser dispatches it. The panel
    // must survive pointerdown + pointerup — collapsing early reflows the
    // remedy out from under the still-held pointer and the click retargets
    // to the shell (the reopened F7 failure) — so onClear fires from the
    // COMPLETED click, which, being an outside press, then also dismisses
    // the panel.
    await act(async () => {
      remedy.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(
      view.container.querySelector('[class*="filterPanel"]'),
      "the panel collapsed at pointerdown — the remedy reflows out from under the press and the click is swallowed",
    ).not.toBeNull();
    await act(async () => {
      remedy.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    expect(view.container.querySelector('[class*="filterPanel"]')).not.toBeNull();
    await act(async () => {
      remedy.click();
    });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(
      view.container.querySelector('[class*="filterPanel"]'),
      "the completed press on the remedy is an outside press — it should also dismiss the panel",
    ).toBeNull();
  });
});

/* ── d4-w7 (backlog #091, browser-restricted-settings-F7 regression) ──
   The in-flow rework left the BAR itself unconstrained below 768px. The
   only rule that ever bounded its width — `flex: 1 1 0` — lives inside
   `@media (width >= 768px)`, and `.toolbar` (app/restricted/browse/
   page.module.css) keeps `flex-wrap: wrap` when it turns into a column at
   767.98px, so `align-items: stretch` stretches the bar to its own FLEX
   LINE's cross size (its max-content) instead of the column's width. QA
   measured the bar at 583px inside a 358px column at 390x844; the panel's
   `width: min(720px, 100%)` then resolved that 100% against 583, so the
   Rating / Duration / Year "Max" inputs sat at x=315..582 and were clipped
   at the screen edge — with `main { overflow-x: hidden }` there was no
   scrollbar to reach them either.

   jsdom computes no layout, so — like the "cannot cover" half above — this
   is pinned against the stylesheet text: a tiny cascade model that asks
   which declarations actually APPLY at a given viewport. That distinction
   is the whole defect (the constraint existed; it was media-gated away
   from every phone), so a media-blind grep would have passed all along. */

interface CssRule {
  selectors: string[];
  declarations: string;
  media: string | null;
}

/** One level of @media nesting — all this stylesheet (or any CSS module
 *  here) uses. Comments are stripped first so a commented-out rule can
 *  never satisfy an assertion. */
function parseRules(source: string): CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  let media: string | null = null;
  let prelude = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === "{") {
      const head = prelude.trim();
      prelude = "";
      if (head.startsWith("@media")) {
        media = head.slice("@media".length).trim();
        i += 1;
        continue;
      }
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") depth -= 1;
        j += 1;
      }
      rules.push({ selectors: head.split(",").map((s) => s.trim()), declarations: css.slice(i + 1, j - 1), media });
      i = j;
      continue;
    }
    if (ch === "}") {
      media = null;
      prelude = "";
      i += 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return rules;
}

function mediaAppliesAt(media: string | null, viewportPx: number): boolean {
  if (media === null) return true;
  const conditions = [...media.matchAll(/\(\s*width\s*(>=|<=|>|<)\s*([\d.]+)px\s*\)/g)];
  expect(conditions.length, `unhandled media query in ZoneControls.module.css: ${media}`).toBeGreaterThan(0);
  return conditions.every(([, op, raw]) => {
    const bound = Number(raw);
    if (op === ">=") return viewportPx >= bound;
    if (op === "<=") return viewportPx <= bound;
    if (op === ">") return viewportPx > bound;
    return viewportPx < bound;
  });
}

describe("ZoneFilterBar — the open panel fits the phone viewport (d4-w7)", () => {
  const rules = parseRules(readFileSync(path.join(__dirname, "ZoneControls.module.css"), "utf8"));

  /** Everything the cascade actually delivers to `selector` at that viewport. */
  function declarationsAt(selector: string, viewportPx: number): string {
    return rules
      .filter((r) => r.selectors.includes(selector) && mediaAppliesAt(r.media, viewportPx))
      .map((r) => r.declarations)
      .join(";");
  }

  /** A cap resolved against the CONTAINING BLOCK — the only kind that
   *  helps here. `align-self: stretch` does not: the bar's flex line is
   *  content-sized (the toolbar column still wraps), so stretching to the
   *  line is what produced the 583px in the first place. */
  function capsAgainstContainer(declarations: string): boolean {
    return /(?:^|[;\s])(?:max-)?width\s*:\s*(?:100%|min\()/.test(declarations);
  }

  // 390 = the QA repro's phone; 600 and 767 are the widths it measured as
  // still broken (clean at 768, where `flex: 1 1 0` takes over).
  it.each([390, 600, 767])("caps .filterBar against its toolbar column at %ipx", (viewport) => {
    expect(
      capsAgainstContainer(declarationsAt(".filterBar", viewport)),
      `nothing bounds .filterBar at ${viewport}px: it stretches to its own max-content (583px measured at 390px) ` +
        "and the panel's `width: min(720px, 100%)` resolves against THAT, clipping the range inputs off-screen (d4-w7)",
    ).toBe(true);
  });

  it("keeps the desktop toolbar rule that stops the panel bumping the sort group onto a second row (F7)", () => {
    expect(declarationsAt(".filterBar", 1280)).toMatch(/flex:\s*1\s+1\s+0/);
  });

  it("keeps the panel's own width tied to the bar, so the bar's cap propagates to it", () => {
    expect(declarationsAt(".filterPanel", 390)).toMatch(/width:\s*min\(720px,\s*100%\)/);
  });
});
