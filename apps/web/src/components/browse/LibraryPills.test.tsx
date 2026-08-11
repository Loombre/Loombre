// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/browse/LibraryPills.test.tsx
//
// Item 1 (an upstream media server-study Wave A, radiogroup sweep): LibraryPills used to
// hand-roll role="tablist"/role="tab" markup with no keyboard support
// beyond plain Tab — now consolidates onto the shared ui/SegmentedControl,
// which owns the WAI-ARIA radiogroup + roving-tabindex + arrow-key
// behavior once (see that component's own test suite for the exhaustive
// keyboard coverage). This just pins that LibraryPills wires its own
// {id,name} shape through correctly.

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryPills } from "./LibraryPills.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("LibraryPills — consolidated onto ui/SegmentedControl (item 1)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  const options = [
    { id: "lib-1", name: "Movies" },
    { id: "lib-2", name: "TV Shows" },
  ];

  it("is a radiogroup of radios, never a tablist of tabs", () => {
    view = renderIntoBody(<LibraryPills options={options} activeId="lib-1" onSelect={() => {}} />);
    expect(view.container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(view.container.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("marks the active library's pill aria-checked and renders real library names as labels", () => {
    view = renderIntoBody(<LibraryPills options={options} activeId="lib-2" onSelect={() => {}} />);
    const radios = Array.from(view.container.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent)).toEqual(["Movies", "TV Shows"]);
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false");
  });

  it("clicking a pill calls onSelect with the library's real id (not its label)", async () => {
    let selected: string | null = null;
    view = renderIntoBody(<LibraryPills options={options} activeId="lib-1" onSelect={(id) => (selected = id)} />);
    const tvShows = Array.from(view.container.querySelectorAll('[role="radio"]')).find((r) => r.textContent === "TV Shows") as HTMLButtonElement;
    await act(async () => {
      tvShows.click();
    });
    expect(selected).toBe("lib-2");
  });
});
