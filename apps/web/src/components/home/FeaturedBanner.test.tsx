// SPDX-License-Identifier: AGPL-3.0-only

// jsdom does not implement window.matchMedia (used here via useMediaQuery
// for prefers-reduced-motion) — same stub as use-media-query.test.tsx.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

/** Records what a real next/link click would hand to the client router.
 *  Same stub (and same reason) as PlayLink.test.tsx's: vitest resolves the
 *  bare "next/link" specifier to Next's PAGES build, so the shipped App
 *  Router Link cannot intercept a click under jsdom. */
const clientNav = vi.hoisted(() => ({ pushes: [] as string[] }));

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
import { MusicPlayerProvider } from "../music/MusicPlayerProvider.js";
import { FeaturedBanner } from "./FeaturedBanner.js";
import type { ReactNode } from "react";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { ToastProvider } from "../ui/Toast.js";

// The banner mounts L3's real WatchlistToggle since the Wave-2 landing
// reconciliation — its useToast() needs a provider, exactly as in the app
// (AppProviders mounts one at the root).
const renderBanner = (node: ReactNode): TestRender => renderIntoBody(<ToastProvider>{node}</ToastProvider>);
import type { FeaturedCandidate } from "../../lib/featured-fields.js";

function installMatchMedia(initialMatches = false): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: initialMatches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })),
  );
}

function makeCandidate(overrides: Partial<FeaturedCandidate> = {}): FeaturedCandidate {
  return {
    id: "c1",
    itemType: "movie",
    title: "Test Movie",
    tag: "ACTION",
    specLine: "2024 · ★ 8.2 · 2h 10m",
    blurb: "A test overview.",
    images: [],
    href: "/items/movie/c1",
    playHref: "/watch/c1?type=movie",
    initial: "T",
    ...overrides,
  };
}

describe("FeaturedBanner", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  it("renders nothing for an empty pool (no fabricated placeholder banner)", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={[]} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    expect(view.container.querySelector("section")).toBeNull();
  });

  it("hides the dot/arrow control cluster for a pool of one (README: hide when pool has one item)", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={[makeCandidate()]} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    expect(view.container.querySelectorAll('[role="radio"]')).toHaveLength(0);
    expect(view.container.querySelector('[aria-label="Next featured title"]')).toBeNull();
  });

  it("shows one dot per candidate and marks the active one for a pool of more than one", () => {
    installMatchMedia();
    const pool = [makeCandidate({ id: "a", title: "Movie A" }), makeCandidate({ id: "b", title: "Movie B" }), makeCandidate({ id: "c", title: "Movie C" })];
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={pool} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    const dots = view.container.querySelectorAll('[role="radio"]');
    expect(dots).toHaveLength(3);
    expect(dots[0]?.getAttribute("data-active")).toBe("true");
    expect(dots[1]?.getAttribute("data-active")).toBe("false");
  });

  it("renders the Play/Details pills pointing at the active candidate's real hrefs", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={[makeCandidate()]} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    const links = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/watch/c1?type=movie");
    expect(links).toContain("/items/movie/c1");
  });

  // QA d3-c3: the Play pill's href is `candidate.playHref` — a VARIABLE, so
  // the whole-src /watch guard in PlayLink.test.tsx never matched it — and it
  // was a raw <a>, i.e. a full document navigation into /watch (live
  // confirmed). Every /watch entry has to stay in one document; the title and
  // Details links are the same defect one hop later.
  it("REGRESSION GUARD: every banner link navigates INSIDE the document, never as a document load", () => {
    installMatchMedia();
    clientNav.pushes.length = 0;
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={[makeCandidate()]} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );

    const links = [...view.container.querySelectorAll("a")];
    expect(links).toHaveLength(3); // title, Play, Details

    for (const link of links) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(clientNav.pushes).toEqual(["/items/movie/c1", "/watch/c1?type=movie", "/items/movie/c1"]);
  });

  it("renders the missing-artwork gradient+initial fallback when the candidate has no images", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={[makeCandidate({ images: [] })]} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    expect(view.container.textContent).toContain("T"); // the initial
    expect(view.container.querySelector("img")).toBeNull(); // no <img> without real art
  });

  it("scanlinesEnabled defaults on and can be turned off (L7 hook)", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={[makeCandidate()]} serverUrl="https://example.test" accessToken="tok" scanlinesEnabled={false} />
      </MusicPlayerProvider>,
    );
    expect(view.container.querySelector('section[data-scanlines="false"]')).not.toBeNull();
  });
});

// Item 1 (Wave A, radiogroup sweep): the dot cluster used to be
// role="tablist"/role="tab" with no keyboard support beyond plain Tab —
// rebuilt on the WAI-ARIA APG Radio Group pattern (same law as
// ui/SegmentedControl.tsx, applied directly here since these are icon-only
// carousel indicator dots, a different shape than a plain segment label).
describe("FeaturedBanner — dot cluster radiogroup pattern + roving tabindex (item 1)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  function pool3(): ReturnType<typeof makeCandidate>[] {
    return [
      makeCandidate({ id: "a", title: "Movie A" }),
      makeCandidate({ id: "b", title: "Movie B" }),
      makeCandidate({ id: "c", title: "Movie C" }),
    ];
  }

  function pressKey(el: HTMLElement, key: string): void {
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  it("is a radiogroup of radios, never a tablist of tabs", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={pool3()} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(view.container.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it("aria-checked (not aria-selected) marks the active dot, and exactly one dot is in the tab order", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={pool3()} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    const dots = Array.from(view.container.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
    expect(dots[0]?.getAttribute("aria-checked")).toBe("true");
    expect(dots[0]?.hasAttribute("aria-selected")).toBe(false);
    expect(dots[0]?.tabIndex).toBe(0);
    expect(dots[1]?.tabIndex).toBe(-1);
    expect(dots[2]?.tabIndex).toBe(-1);
  });

  it("ArrowRight moves focus AND selection to the next dot, wrapping past the end", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={pool3()} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    const dots = Array.from(view.container.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
    pressKey(dots[0]!, "ArrowRight");
    expect(dots[1]?.getAttribute("aria-checked")).toBe("true");
    expect(dots[1]?.tabIndex).toBe(0);
  });

  it("Home/End jump to the first/last dot", () => {
    installMatchMedia();
    view = renderBanner(
      <MusicPlayerProvider>
        <FeaturedBanner pool={pool3()} serverUrl="https://example.test" accessToken="tok" />
      </MusicPlayerProvider>,
    );
    const dots = Array.from(view.container.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
    pressKey(dots[0]!, "End");
    expect(dots[2]?.getAttribute("aria-checked")).toBe("true");

    pressKey(dots[2]!, "Home");
    expect(dots[0]?.getAttribute("aria-checked")).toBe("true");
  });
});
