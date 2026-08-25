// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { describe, expect, it, afterEach, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { SearchMusicGrid } from "./SearchMusicGrid.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

/** Records what a real next/link click would hand to the client router. */
const clientNav = vi.hoisted(() => ({ pushes: [] as string[] }));

// The next/link stub mirrors PlayLink.test.tsx's and the restricted-scene
// guard's (same reason: vitest resolves the bare "next/link" specifier to
// Next's PAGES build, so the shipped App Router Link cannot intercept
// clicks under jsdom). It models what the real component does on an
// unmodified primary click: preventDefault() then a client-side navigation.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        clientNav.pushes.push(href);
      }}
    >
      {children}
    </a>
  ),
}));

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

function click(node: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    node.dispatchEvent(event);
  });
  return event;
}

describe("SearchMusicGrid", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    clientNav.pushes.length = 0;
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

  it("AUD-A4v4-001 REGRESSION GUARD: on an artwork error event, removes the broken <img> so the gradient fallback shows — never the browser's broken-image glyph (the six-sibling onError pattern, e.g. EpisodeRow/DetailPoster)", () => {
    view = renderIntoBody(
      <SearchMusicGrid results={[ALBUM_RESULT]} artistNames={new Map()} serverUrl="https://loombre.local" accessToken="tok" />,
    );
    // No blurhash on the fixture, so each tree renders exactly one <img>:
    // the real artwork (desktop cell + mobile row = 2).
    const imgs = view.container.querySelectorAll("img");
    expect(imgs.length).toBe(2);

    act(() => {
      for (const img of imgs) img.dispatchEvent(new Event("error"));
    });

    // Both failed artwork <img>s are gone; the .art/.mobileArt gradient
    // background is what paints (design/phosphor/README.md:342-344).
    expect(view.container.querySelectorAll("img").length).toBe(0);
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

  // d4-w3 (C/zone-search-result-raw-anchor): BOTH trees were raw
  // <a href={hrefFor(result)}>, i.e. FULL DOCUMENT loads. The search overlay
  // is mounted by AppShell on EVERY route including the restricted zone, so
  // a result clicked from inside the unlocked zone re-locked it
  // (RestrictedProvider re-initializes to locked on every document load) —
  // the exact mechanism of browser-restricted-settings-F1.
  it("d4-w3: BOTH trees navigate client-side, never as a document load", () => {
    view = renderIntoBody(
      <SearchMusicGrid
        results={[ALBUM_RESULT]}
        artistNames={new Map([["artist-1", "Cassette Ghosts"]])}
        serverUrl="https://loombre.local"
        accessToken="tok"
      />,
    );
    const links = Array.from(view.container.querySelectorAll('a[href="/items/album/album-1"]'));
    expect(links.length).toBe(2); // desktop cell + mobile row

    for (const link of links) {
      expect(click(link).defaultPrevented).toBe(true);
    }
    expect(clientNav.pushes).toEqual(["/items/album/album-1", "/items/album/album-1"]);
  });

  it("d4-w3: leaves a modified (cmd/ctrl) click to the browser", () => {
    view = renderIntoBody(
      <SearchMusicGrid results={[ARTIST_RESULT]} artistNames={new Map()} serverUrl="https://loombre.local" accessToken="tok" />,
    );
    const link = view.container.querySelector('a[href="/items/artist/artist-1"]') as Element;

    const event = click(link, { ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(clientNav.pushes).toEqual([]);
  });
});
