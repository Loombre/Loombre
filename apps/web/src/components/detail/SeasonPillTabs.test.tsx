// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/SeasonPillTabs.test.tsx
//
// Item 1 (an upstream media server-study Wave A, radiogroup sweep): consolidated onto the
// shared ui/SegmentedControl — see that component's own test suite for the
// exhaustive radiogroup/roving-tabindex/keyboard coverage. This pins
// SeasonPillTabs' own Season-object wiring and that the mobile
// horizontal-scroll-strip CSS override (SeasonPillTabs.module.css's
// `.track .pill` compound selector) still resolves — both classes must
// land on the SAME elements SegmentedControl renders for that selector to
// match at all.

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { SeasonPillTabs } from "./SeasonPillTabs.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type Season = components["schemas"]["Season"];

function makeSeason(overrides: Partial<Season>): Season {
  return {
    id: "s1",
    seriesId: "series-1",
    seasonNumber: 1,
    name: null,
    overview: null,
    images: [],
    episodeCount: 10,
    ...overrides,
  } as Season;
}

describe("SeasonPillTabs — consolidated onto ui/SegmentedControl (item 1)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  const seasons = [makeSeason({ id: "s1", seasonNumber: 1 }), makeSeason({ id: "s2", seasonNumber: 2 })];

  it("is a radiogroup of radios, never a tablist of tabs", () => {
    view = renderIntoBody(<SeasonPillTabs seasons={seasons} selectedSeasonId="s1" onSelect={() => {}} />);
    expect(view.container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(view.container.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("labels each pill 'Season N' and checks the selected one", () => {
    view = renderIntoBody(<SeasonPillTabs seasons={seasons} selectedSeasonId="s2" onSelect={() => {}} />);
    const radios = Array.from(view.container.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent)).toEqual(["Season 1", "Season 2"]);
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking a pill calls onSelect with the season's id", async () => {
    let selected: string | null = null;
    view = renderIntoBody(<SeasonPillTabs seasons={seasons} selectedSeasonId="s1" onSelect={(id) => (selected = id)} />);
    const season2 = Array.from(view.container.querySelectorAll('[role="radio"]')).find((r) => r.textContent === "Season 2") as HTMLButtonElement;
    await act(async () => {
      season2.click();
    });
    expect(selected).toBe("s2");
  });

  it("the mobile scroll-strip CSS override still targets real rendered elements (.track .pill both present in the DOM)", () => {
    view = renderIntoBody(<SeasonPillTabs seasons={seasons} selectedSeasonId="s1" onSelect={() => {}} />);
    const track = view.container.firstElementChild as HTMLElement;
    const radios = Array.from(view.container.querySelectorAll('[role="radio"]'));
    // CSS Modules `composes` puts every composed class name in the same
    // space-separated className string — this can't assert the exact
    // hashed token, but it CAN assert every radio is a real DESCENDANT of
    // the track (the shape `.track .pill` depends on).
    for (const radio of radios) {
      expect(track.contains(radio)).toBe(true);
    }
  });
});
