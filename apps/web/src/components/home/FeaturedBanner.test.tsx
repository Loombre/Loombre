// SPDX-License-Identifier: AGPL-3.0-only

// jsdom does not implement window.matchMedia (used here via useMediaQuery
// for prefers-reduced-motion) — same stub as use-media-query.test.tsx.

import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(0);
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
    const dots = view.container.querySelectorAll('[role="tab"]');
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
