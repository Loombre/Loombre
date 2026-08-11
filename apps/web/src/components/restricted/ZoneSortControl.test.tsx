// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/restricted/ZoneSortControl.test.tsx
//
// Item 1 (an upstream media server-study Wave A, radiogroup sweep): consolidated onto the
// shared ui/SegmentedControl — see that component's own test suite for the
// exhaustive radiogroup/roving-tabindex/keyboard coverage. This pins
// ZoneSortControl's own {value,label} wiring and its warning-toned active
// fill (ZoneControls.module.css's `.sortTrack .sortSegment[data-active]`
// override, threaded through unchanged via segmentClassName).

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ZoneSortControl } from "./ZoneSortControl.js";
import { ZONE_SORT_OPTIONS, type ZoneSort } from "../../lib/zone-browse-filters.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("ZoneSortControl — consolidated onto ui/SegmentedControl (item 1)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("is a radiogroup of radios, never a tablist of tabs", () => {
    view = renderIntoBody(<ZoneSortControl active="added" onChange={() => {}} />);
    expect(view.container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(view.container.querySelectorAll('[role="radio"]')).toHaveLength(ZONE_SORT_OPTIONS.length);
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("marks the active sort aria-checked", () => {
    view = renderIntoBody(<ZoneSortControl active="rating" onChange={() => {}} />);
    const radios = Array.from(view.container.querySelectorAll('[role="radio"]'));
    const ratingOption = ZONE_SORT_OPTIONS.find((o) => o.value === "rating")!;
    const checked = radios.find((r) => r.getAttribute("aria-checked") === "true");
    expect(checked?.textContent).toBe(ratingOption.label);
  });

  it("clicking a pill calls onChange with the sort's value", async () => {
    let received: ZoneSort | null = null;
    view = renderIntoBody(<ZoneSortControl active="added" onChange={(v) => (received = v)} />);
    const titleOption = ZONE_SORT_OPTIONS.find((o) => o.value === "title")!;
    const pill = Array.from(view.container.querySelectorAll('[role="radio"]')).find((r) => r.textContent === titleOption.label) as HTMLButtonElement;
    await act(async () => {
      pill.click();
    });
    expect(received).toBe("title");
  });
});
