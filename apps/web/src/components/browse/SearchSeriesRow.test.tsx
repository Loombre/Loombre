// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { SearchSeriesRow } from "./SearchSeriesRow.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type SearchResult = components["schemas"]["SearchResult"];

function makeSeriesResult(overrides: Partial<components["schemas"]["Series"]> = {}): SearchResult {
  return {
    itemType: "series",
    item: {
      id: "series-1",
      libraryId: "lib-1",
      itemType: "series",
      title: "The Relay",
      sortTitle: "The Relay",
      year: 2022,
      communityRating: null,
      contentClass: "general",
      addedAtMs: 0,
      updatedAtMs: 0,
      contentRating: null,
      overview: null,
      status: "continuing",
      genres: [],
      images: [],
      ...overrides,
    },
  } as SearchResult;
}

describe("SearchSeriesRow", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("shows real year + status, never the fixture's fabricated season count", () => {
    view = renderIntoBody(
      <SearchSeriesRow results={[makeSeriesResult()]} serverUrl="https://loombre.local" accessToken="tok" />,
    );
    expect(view.container.textContent).toContain("2022 · Continuing");
    expect(view.container.textContent).not.toMatch(/season/i);
  });

  it("omits the status half when the series has none on record", () => {
    view = renderIntoBody(
      <SearchSeriesRow results={[makeSeriesResult({ status: null })]} serverUrl="https://loombre.local" accessToken="tok" />,
    );
    expect(view.container.textContent).toContain("2022");
    expect(view.container.textContent).not.toContain("·");
  });

  it("links to the real series detail route", () => {
    view = renderIntoBody(
      <SearchSeriesRow results={[makeSeriesResult()]} serverUrl="https://loombre.local" accessToken="tok" />,
    );
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/items/series/series-1");
  });

  it("marks the active row via data-search-active for keyboard nav", () => {
    view = renderIntoBody(
      <SearchSeriesRow results={[makeSeriesResult()]} serverUrl="https://loombre.local" accessToken="tok" activeId="series-1" />,
    );
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("data-search-active")).toBe("true");
  });
});
