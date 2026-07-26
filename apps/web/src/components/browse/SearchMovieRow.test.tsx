// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { type TestRender } from "../ui/test-render.js";

// PosterCell.tsx (reused by the desktop tree) calls next/navigation's
// useRouter() for its click-intercept-into-view-transition behavior — not
// under test here, just needs an app-router context to exist at all.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Imported AFTER the mock (use-watched-state.test.tsx's established
// convention) so the module under test picks it up.
const { SearchMovieRow } = await import("./SearchMovieRow.js");
const { renderIntoBody } = await import("../ui/test-render.js");

type SearchResult = components["schemas"]["SearchResult"];

const MOVIE_RESULT: SearchResult = {
  itemType: "movie",
  item: {
    id: "movie-1",
    libraryId: "lib-1",
    itemType: "movie",
    title: "Low Orbit",
    sortTitle: "Low Orbit",
    year: 2025,
    communityRating: null,
    contentClass: "general",
    addedAtMs: 0,
    updatedAtMs: 0,
    contentRating: "R",
    runtimeMs: 6_600_000,
    overview: null,
    genres: [],
    images: [],
  },
} as SearchResult;

describe("SearchMovieRow", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders both a desktop poster cell and a mobile wide row for the same movie", () => {
    view = renderIntoBody(<SearchMovieRow results={[MOVIE_RESULT]} serverUrl="https://loombre.local" accessToken="tok" />);
    expect(view.container.querySelectorAll('[data-search-id="movie-1"]').length).toBe(2);
  });

  it("mobile row links to the real movie route and shows the real year", () => {
    view = renderIntoBody(<SearchMovieRow results={[MOVIE_RESULT]} serverUrl="https://loombre.local" accessToken="tok" />);
    const mobileLink = Array.from(view.container.querySelectorAll("a")).find((a) => a.getAttribute("href") === "/items/movie/movie-1");
    expect(mobileLink).not.toBeUndefined();
    expect(mobileLink?.textContent).toContain("2025");
  });

  it("marks whichever tree's node matches activeId", () => {
    view = renderIntoBody(<SearchMovieRow results={[MOVIE_RESULT]} serverUrl="https://loombre.local" accessToken="tok" activeId="movie-1" />);
    const activeNodes = view.container.querySelectorAll('[data-search-active="true"]');
    expect(activeNodes.length).toBe(2);
  });
});
