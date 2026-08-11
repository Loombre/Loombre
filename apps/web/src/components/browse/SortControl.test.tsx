// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/SortControl.test.tsx
//
// Item 1 (Wave A, radiogroup sweep): consolidated onto the
// shared ui/SegmentedControl — see that component's own test suite for the
// exhaustive radiogroup/roving-tabindex/keyboard coverage. This pins
// SortControl's own {value,label} wiring.

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SortControl, SORT_OPTIONS, type SortValue } from "./SortControl.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("SortControl — consolidated onto ui/SegmentedControl (item 1)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("is a radiogroup of radios, never a tablist of tabs", () => {
    view = renderIntoBody(<SortControl active="recently-added" onChange={() => {}} />);
    expect(view.container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(view.container.querySelectorAll('[role="radio"]')).toHaveLength(SORT_OPTIONS.length);
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("marks the active sort aria-checked and renders every sort's real label", () => {
    view = renderIntoBody(<SortControl active="rating" onChange={() => {}} />);
    const radios = Array.from(view.container.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent)).toEqual(SORT_OPTIONS.map((o) => o.label));
    const checked = radios.find((r) => r.getAttribute("aria-checked") === "true");
    expect(checked?.textContent).toBe("Highest Rated");
  });

  it("clicking a pill calls onChange with the sort's value, not its label", async () => {
    let received: SortValue | null = null;
    view = renderIntoBody(<SortControl active="recently-added" onChange={(v) => (received = v)} />);
    const titlePill = Array.from(view.container.querySelectorAll('[role="radio"]')).find((r) => r.textContent === "Title A–Z") as HTMLButtonElement;
    await act(async () => {
      titlePill.click();
    });
    expect(received).toBe("title");
  });
});
