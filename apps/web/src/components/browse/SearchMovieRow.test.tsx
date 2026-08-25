// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { type TestRender } from "../ui/test-render.js";

// PosterCell.tsx (reused by the desktop tree) calls next/navigation's
// useRouter() for its click-intercept-into-view-transition behavior — not
// under test here, just needs an app-router context to exist at all.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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

/** The MOBILE tree's row. Both trees carry the same href, and the desktop
 *  PosterCell renders first, so a `querySelectorAll("a")` lookup by href
 *  silently returns the desktop cell instead. Vitest gives CSS modules real
 *  hashed class names, hence the substring match. */
function mobileRow(view: TestRender): Element {
  return view.container.querySelector('[class*="mobileRow"]') as Element;
}

function click(node: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    node.dispatchEvent(event);
  });
  return event;
}

describe("SearchMovieRow", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    clientNav.pushes.length = 0;
  });

  it("renders both a desktop poster cell and a mobile wide row for the same movie", () => {
    view = renderIntoBody(<SearchMovieRow results={[MOVIE_RESULT]} serverUrl="https://loombre.local" accessToken="tok" />);
    expect(view.container.querySelectorAll('[data-search-id="movie-1"]').length).toBe(2);
  });

  it("mobile row links to the real movie route and shows the real year", () => {
    view = renderIntoBody(<SearchMovieRow results={[MOVIE_RESULT]} serverUrl="https://loombre.local" accessToken="tok" />);
    const mobileLink = mobileRow(view);
    expect(mobileLink.getAttribute("href")).toBe("/items/movie/movie-1");
    expect(mobileLink.textContent).toContain("2025");
  });

  // d4-w3 (C/zone-search-result-raw-anchor): the mobile row was a raw
  // <a href>, i.e. a FULL DOCUMENT load. The search overlay is mounted by
  // AppShell on EVERY route including the restricted zone, so a result
  // clicked from inside the unlocked zone re-locked it (RestrictedProvider
  // re-initializes to locked on every document load) — the exact mechanism
  // of browser-restricted-settings-F1.
  it("d4-w3: a mobile row click is a CLIENT navigation, not a document load", () => {
    view = renderIntoBody(<SearchMovieRow results={[MOVIE_RESULT]} serverUrl="https://loombre.local" accessToken="tok" />);

    const event = click(mobileRow(view));

    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual(["/items/movie/movie-1"]);
  });

  it("d4-w3: leaves a modified (cmd/ctrl) click to the browser", () => {
    view = renderIntoBody(<SearchMovieRow results={[MOVIE_RESULT]} serverUrl="https://loombre.local" accessToken="tok" />);

    const event = click(mobileRow(view), { metaKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(clientNav.pushes).toEqual([]);
  });

  it("marks whichever tree's node matches activeId", () => {
    view = renderIntoBody(<SearchMovieRow results={[MOVIE_RESULT]} serverUrl="https://loombre.local" accessToken="tok" activeId="movie-1" />);
    const activeNodes = view.container.querySelectorAll('[data-search-active="true"]');
    expect(activeNodes.length).toBe(2);
  });
});
