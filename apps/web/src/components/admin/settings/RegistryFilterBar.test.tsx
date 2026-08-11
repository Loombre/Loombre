// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/RegistryFilterBar.test.tsx
//
// Phosphor Wave-2 lane L6 (design/phosphor/README.md §Screens → Settings
// tab 7 "Advanced Server": "a filter field, category pills with counts" +
// STATE.md scope item 3, "the filter field + category pills with counts
// (derived)"). This component is pure presentation over already-derived
// data (lib/settings-schema-widget.ts#categorySummaries) — no network,
// so unlike SettingField/ProviderKeysCard there's no network boundary to
// stay behind here.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryFilterBar } from "./RegistryFilterBar.js";
import { CATEGORY_LABELS } from "./SettingsCategoryCard.js";
import type { RegistryCategorySummary } from "../../../lib/settings-schema-widget.js";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const CATEGORIES: RegistryCategorySummary[] = [
  { category: "transcode", count: 5, hasEnvOnlyKey: false },
  { category: "rateLimit", count: 6, hasEnvOnlyKey: false },
  { category: "database", count: 1, hasEnvOnlyKey: true },
];

describe("RegistryFilterBar", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders one pill per category, with its label and derived count", () => {
    view = renderIntoBody(
      <RegistryFilterBar
        categories={CATEGORIES}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="transcode"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    expect(view.container.textContent).toContain("Transcode");
    expect(view.container.textContent).toContain("5");
    expect(view.container.textContent).toContain("Rate limits");
    expect(view.container.textContent).toContain("6");
    expect(view.container.textContent).toContain("Database");
    expect(view.container.textContent).toContain("1");
  });

  it("marks only the active category's pill as selected", () => {
    view = renderIntoBody(
      <RegistryFilterBar
        categories={CATEGORIES}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="rateLimit"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    const tabs = Array.from(view.container.querySelectorAll('[role="tab"]'));
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain("Rate limits");
  });

  it("shows a padlock glyph for a category with at least one env-only key, and none for a category with zero", () => {
    view = renderIntoBody(
      <RegistryFilterBar
        categories={CATEGORIES}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="transcode"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    const tabs = Array.from(view.container.querySelectorAll('[role="tab"]'));
    const databasePill = tabs.find((t) => t.textContent?.includes("Database"))!;
    const transcodePill = tabs.find((t) => t.textContent?.includes("Transcode"))!;
    expect(databasePill.querySelector("svg")).not.toBeNull();
    expect(transcodePill.querySelector("svg")).toBeNull();
  });

  // LD-9 (owner screenshot): the real registry's "network" category is
  // MIXED — env-only http.port/network.corsOrigins alongside ui-scope
  // network.publicUrl/network.trustProxy. Before this fix, the padlock
  // required EVERY key to be env-only, so a mixed category like this never
  // got one at all, despite genuinely holding a key nobody can edit here.
  it("shows a padlock glyph for a MIXED category too (some keys env-only, some ui — not just an all-env-only one)", () => {
    view = renderIntoBody(
      <RegistryFilterBar
        categories={[{ category: "network", count: 4, hasEnvOnlyKey: true }]}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="network"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    const tab = view.container.querySelector('[role="tab"]')!;
    expect(tab.querySelector("svg")).not.toBeNull();
  });

  it("clicking a pill calls onSelectCategory with that category's id", () => {
    const onSelectCategory = vi.fn();
    view = renderIntoBody(
      <RegistryFilterBar
        categories={CATEGORIES}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="transcode"
        onSelectCategory={onSelectCategory}
        query=""
        onQueryChange={() => {}}
      />,
    );
    const tabs = Array.from(view.container.querySelectorAll('[role="tab"]'));
    const databasePill = tabs.find((t) => t.textContent?.includes("Database")) as HTMLButtonElement;
    act(() => databasePill.click());
    expect(onSelectCategory).toHaveBeenCalledWith("database");
  });

  it("falls back to the raw category id when categoryLabels has no entry for it", () => {
    view = renderIntoBody(
      <RegistryFilterBar
        categories={[{ category: "someNewCategory", count: 2, hasEnvOnlyKey: false }]}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="someNewCategory"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    expect(view.container.textContent).toContain("someNewCategory");
  });

  // LD-10 (owner screenshot): the pill row must be alphabetical by its
  // DISPLAYED label, independent of whatever order `categories` arrives in
  // (registry/first-seen order from categorySummaries() — deliberately NOT
  // alphabetical, per that function's own header). CATEGORIES above is
  // fed in [transcode, rateLimit, database] order; the correct DOM order is
  // "Database", "Rate limits", "Transcode" (label-alphabetical).
  it("sorts the category pills alphabetically by their displayed label, regardless of the order `categories` arrives in", () => {
    view = renderIntoBody(
      <RegistryFilterBar
        categories={CATEGORIES}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="transcode"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    const tabs = Array.from(view.container.querySelectorAll('[role="tab"]'));
    expect(tabs).toHaveLength(3);
    // Each pill's own text is "<label><count>" (FilterChip renders the
    // label span before the count span) — startsWith is enough to pin DOM
    // order without depending on hashed CSS-module class names.
    expect(tabs[0]!.textContent?.startsWith("Database")).toBe(true);
    expect(tabs[1]!.textContent?.startsWith("Rate limits")).toBe(true);
    expect(tabs[2]!.textContent?.startsWith("Transcode")).toBe(true);
  });

  it("does not reorder when the categories already arrive alphabetically — a stable, idempotent sort", () => {
    const alreadySorted: RegistryCategorySummary[] = [
      { category: "database", count: 1, hasEnvOnlyKey: true },
      { category: "rateLimit", count: 6, hasEnvOnlyKey: false },
      { category: "transcode", count: 5, hasEnvOnlyKey: false },
    ];
    view = renderIntoBody(
      <RegistryFilterBar
        categories={alreadySorted}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="transcode"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    const tabs = Array.from(view.container.querySelectorAll('[role="tab"]'));
    expect(tabs[0]!.textContent?.startsWith("Database")).toBe(true);
    expect(tabs[1]!.textContent?.startsWith("Rate limits")).toBe(true);
    expect(tabs[2]!.textContent?.startsWith("Transcode")).toBe(true);
  });

  it("typing in the filter field calls onQueryChange with the typed text", () => {
    const onQueryChange = vi.fn();
    view = renderIntoBody(
      <RegistryFilterBar
        categories={CATEGORIES}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="transcode"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={onQueryChange}
      />,
    );
    const input = view.container.querySelector('input[aria-label="Filter advanced keys"]') as HTMLInputElement;
    act(() => setNativeValue(input, "transcode"));
    expect(onQueryChange).toHaveBeenCalledWith("transcode");
  });

  it("reflects the query prop back into the input's value (controlled)", () => {
    view = renderIntoBody(
      <RegistryFilterBar
        categories={CATEGORIES}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="transcode"
        onSelectCategory={() => {}}
        query="rateLimit"
        onQueryChange={() => {}}
      />,
    );
    const input = view.container.querySelector('input[aria-label="Filter advanced keys"]') as HTMLInputElement;
    expect(input.value).toBe("rateLimit");
  });
});
