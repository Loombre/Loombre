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
  { category: "transcode", count: 5, allEnvOnly: false },
  { category: "rateLimit", count: 6, allEnvOnly: false },
  { category: "database", count: 1, allEnvOnly: true },
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

  it("shows a padlock glyph only for a category where every key is env-only", () => {
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
        categories={[{ category: "someNewCategory", count: 2, allEnvOnly: false }]}
        categoryLabels={CATEGORY_LABELS}
        activeCategory="someNewCategory"
        onSelectCategory={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    expect(view.container.textContent).toContain("someNewCategory");
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
