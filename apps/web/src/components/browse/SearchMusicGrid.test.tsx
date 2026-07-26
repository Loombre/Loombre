// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, afterEach } from "vitest";
import type { components } from "@loombre/sdk";
import { SearchMusicGrid } from "./SearchMusicGrid.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type SearchResult = components["schemas"]["SearchResult"];

const ALBUM_RESULT: SearchResult = {
  itemType: "album",
  item: {
    id: "album-1",
    libraryId: "lib-1",
    itemType: "album",
    title: "Night Drive Tapes",
    sortTitle: "Night Drive Tapes",
    year: 2024,
    communityRating: null,
    contentClass: "general",
    addedAtMs: 0,
    updatedAtMs: 0,
    artistId: "artist-1",
    trackCount: 8,
    genres: [],
    images: [],
  },
} as SearchResult;

const ARTIST_RESULT: SearchResult = {
  itemType: "artist",
  item: {
    id: "artist-1",
    libraryId: "lib-1",
    itemType: "artist",
    title: "Cassette Ghosts",
    sortTitle: "Cassette Ghosts",
    year: null,
    communityRating: null,
    contentClass: "general",
    addedAtMs: 0,
    updatedAtMs: 0,
    overview: null,
    genres: ["Synthwave", "Ambient"],
    images: [],
  },
} as SearchResult;

describe("SearchMusicGrid", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("shows the real looked-up artist name for an album tile, not a fabricated label", () => {
    view = renderIntoBody(
      <SearchMusicGrid
        results={[ALBUM_RESULT]}
        artistNames={new Map([["artist-1", "Cassette Ghosts"]])}
        serverUrl="https://loombre.local"
        accessToken="tok"
      />,
    );
    expect(view.container.textContent).toContain("Cassette Ghosts");
  });

  it("shows nothing for an album subtitle when the artist name hasn't resolved yet (never a placeholder)", () => {
    view = renderIntoBody(
      <SearchMusicGrid results={[ALBUM_RESULT]} artistNames={new Map()} serverUrl="https://loombre.local" accessToken="tok" />,
    );
    expect(view.container.textContent).toContain("Night Drive Tapes");
    expect(view.container.textContent).not.toContain("undefined");
  });

  it("an artist tile shows its own real genres as the subtitle, never a fabricated 'Artist' label", () => {
    view = renderIntoBody(
      <SearchMusicGrid results={[ARTIST_RESULT]} artistNames={new Map()} serverUrl="https://loombre.local" accessToken="tok" />,
    );
    expect(view.container.textContent).toContain("Synthwave / Ambient");
    expect(view.container.textContent).not.toContain("Artist");
  });

  it("both a desktop grid cell and a mobile row render for the same result (CSS-swapped, not JS-branched)", () => {
    view = renderIntoBody(
      <SearchMusicGrid
        results={[ALBUM_RESULT]}
        artistNames={new Map([["artist-1", "Cassette Ghosts"]])}
        serverUrl="https://loombre.local"
        accessToken="tok"
      />,
    );
    const matches = view.container.querySelectorAll('[data-search-id="album-1"]');
    expect(matches.length).toBe(2); // desktop .cell + mobile .mobileRow
  });
});
