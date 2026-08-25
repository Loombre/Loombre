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

  it("closes on an outside press (click or tap)", async () => {
    renderBar();
    await open();
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel(), "expected an outside press to close the filter panel").toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open when the press lands on one of its own controls", async () => {
    renderBar();
    await open();
    const checkbox = panel()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      checkbox.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel(), "a press inside the panel must not dismiss it").not.toBeNull();
  });

  it("stops listening once closed (no stray document listeners after unmount)", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    try {
      renderBar();
      await open();
      expect(addSpy.mock.calls.some(([type]) => type === "pointerdown")).toBe(true);
      await act(async () => {
        toggle().click();
      });
      expect(removeSpy.mock.calls.some(([type]) => type === "pointerdown")).toBe(true);
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

    await act(async () => {
      remedy.click();
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
