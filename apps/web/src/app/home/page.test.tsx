// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/home/page.test.tsx
//
// Regression guard (77-agent review, confirmed[16]): the Home bootstrap
// effect's /home/continue-watching and /home/recently-added fetches used
// to be bare `.then()`s with no `.catch()` — a transient 5xx/network
// failure left `loading` (and the skeleton it gates, lines ~277-284) stuck
// forever, with no error state and no retry short of a full page reload.

import { act, StrictMode } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../components/ui/test-render.js";

const apiGetMock = vi.fn();

class FakeLoombreApiError extends Error {
  readonly status: number;
  constructor(status: number, message = "Request failed") {
    super(message);
    this.status = status;
  }
}

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiDelete: vi.fn(),
  LoombreApiError: FakeLoombreApiError,
}));

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: "https://loombre.local" }),
    getAccessToken: () => Promise.resolve("tok"),
  }),
}));

// Home's own live-signal hooks (events-socket subscriptions) — irrelevant
// to the fetch/error-state behavior under test here.
// The rail cards (components/home/PosterCard.tsx) call useRouter() for
// their hover-prefetch/navigation — no app router is mounted under
// renderIntoBody, so the real hook throws its "expected app router to be
// mounted" invariant.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, back: () => undefined, prefetch: () => undefined }),
}));

vi.mock("../../lib/now-playing.js", () => ({
  useNowPlayingItemIds: () => new Set<string>(),
}));
vi.mock("../../lib/watchlist-sync.js", () => ({
  useWatchlistChangeSignal: () => undefined,
  // The featured banner mounts L3's real WatchlistToggle, which reads the
  // shared watchlist id store through this module (lib/watchlist-id-store.ts
  // + the events socket) — stubbed here so the banner's own render is what
  // these cases exercise.
  useWatchlistIds: () => ({ ids: new Set<string>(), loading: false, atCapacity: false, markAdded: () => undefined, markRemoved: () => undefined }),
}));

// Imported AFTER the mocks so the module under test picks them up.
// HomeContent lives beside page.tsx rather than in it: Next rejects any
// non-route export from a `page.tsx` (see ./HomeContent.tsx's header).
const { HomeContent } = await import("./HomeContent.js");
// Same reason, one step further: MusicPlayerProvider's import chain reaches
// lib/playback-session.ts -> lib/api-client.js, so a STATIC import of it here
// would run the api-client mock factory above before this file's own
// FakeLoombreApiError class is initialized (a TDZ ReferenceError at collect).
const { ToastProvider } = await import("../../components/ui/Toast.js");
const { MusicPlayerProvider } = await import("../../components/music/MusicPlayerProvider.js");
// d4-w2: the rail's seed request is SHARED while in flight (module state in
// lib/watchlist-rail.ts) — dropped between cases so one test's unsettled
// request can never be adopted by the next.
const { __resetWatchlistRailForTests } = await import("../../lib/watchlist-rail.js");

function emptyPage(): Promise<{ items: unknown[]; nextCursor: null }> {
  return Promise.resolve({ items: [], nextCursor: null });
}

function page(items: unknown[]): Promise<{ items: unknown[]; nextCursor: null }> {
  return Promise.resolve({ items, nextCursor: null });
}

/** jsdom has no matchMedia (useFeaturedRotation -> useMediaQuery for
 *  prefers-reduced-motion) — same stub as components/home/FeaturedBanner.test.tsx. */
function installMatchMedia(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })),
  );
}

/** The banner needs the same two providers the real app mounts above Home
 *  (AppProviders): ToastProvider for WatchlistToggle's useToast(),
 *  MusicPlayerProvider for the rotation hook's queue-drawer pause signal. */
function renderHome(node: ReactNode): TestRender {
  return renderIntoBody(
    <ToastProvider>
      <MusicPlayerProvider>{node}</MusicPlayerProvider>
    </ToastProvider>,
  );
}

function movieFixture(index: number): Record<string, unknown> {
  const id = `m${String(index).padStart(2, "0")}`;
  return {
    id,
    title: `Movie ${index}`,
    year: 2000 + index,
    genres: ["Action"],
    communityRating: 7.5,
    runtimeMs: 5_400_000,
    overview: `Overview ${index}`,
    images: [],
    addedAtMs: 100_000 - index * 1_000,
  };
}

/** Only continue-watching/recently-added are under test — /watchlist and
 *  the featured pool's /movies+/series over-fetch (lib/featured-pool.ts)
 *  all need a real (empty) response too, same path-switching convention as
 *  AlbumDetailScreen.test.tsx's apiGet mock. */
function installApiGetMock(overrides: {
  continueWatching?: () => Promise<unknown>;
  recentlyAdded?: () => Promise<unknown>;
  movies?: () => Promise<unknown>;
}): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/home/continue-watching") return (overrides.continueWatching ?? emptyPage)();
    if (path === "/home/recently-added") return (overrides.recentlyAdded ?? emptyPage)();
    if (path === "/movies") return (overrides.movies ?? emptyPage)();
    if (path === "/watchlist" || path === "/series") return emptyPage();
    return Promise.reject(new Error(`unexpected apiGet(${path})`));
  });
}

/** Home's featured pool resolves a fetch chain BEHIND the two rail fetches
 *  (rails -> exclusion effect -> /movies+/series -> setFeaturedPool), which
 *  outruns flush()'s three microtasks — same deeper-flush need lane W hit on
 *  the series detail screen. */
async function flushDeep(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findRetryButton(view: TestRender): HTMLButtonElement | undefined {
  return Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Retry");
}

function callsTo(path: string): unknown[][] {
  return apiGetMock.mock.calls.filter((call) => call[0] === path);
}

describe("HomeContent", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
    __resetWatchlistRailForTests();
    vi.unstubAllGlobals();
  });

  it("REGRESSION GUARD: renders an error message with a working Retry instead of an infinite skeleton on a fetch failure", async () => {
    let succeed = false;
    installApiGetMock({
      continueWatching: () => (succeed ? emptyPage() : Promise.reject(new Error("network down"))),
    });
    view = renderIntoBody(<HomeContent />);
    await flush();

    const retryButton = findRetryButton(view);
    expect(retryButton).toBeDefined();
    // The generic fallback (a plain Error, not a LoombreApiError) —
    // useDetailFetch.ts's sibling convention in components/detail/.
    expect(view.container.textContent).toContain("Failed to load Home.");

    succeed = true;
    act(() => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(findRetryButton(view)).toBeUndefined();
    expect(view.container.textContent).toContain("Nothing in progress");
  });

  it("REGRESSION GUARD: a LoombreApiError's own message reaches the error state", async () => {
    installApiGetMock({
      recentlyAdded: () => Promise.reject(new FakeLoombreApiError(500, "Server error")),
    });
    view = renderIntoBody(<HomeContent />);
    await flush();

    expect(view.container.textContent).toContain("Server error");
  });

  it("still renders the real rails once every fetch resolves (no regression on the happy path)", async () => {
    installApiGetMock({});
    view = renderIntoBody(<HomeContent />);
    await flush();

    expect(findRetryButton(view)).toBeUndefined();
    expect(view.container.textContent).toContain("Nothing in progress");
    expect(view.container.textContent).toContain("Nothing added yet");
  });

  // browser-shell-browse-F7: the featured-pool's /movies+/series over-fetch
  // (fetchFeaturedCandidates, run after both rails resolve) had no .catch
  // at all — a failure there was an unhandled promise rejection (vitest
  // reports these as a run-level "Errors" failure independent of any
  // individual test's own assertions, so this case is a real RED/GREEN
  // signal even though the banner's own render output is identical either
  // way — null and [] both fail the `featuredPool.length > 0` gate).
  it("REGRESSION GUARD: a failed featured-pool fetch degrades to no banner instead of an unhandled rejection", async () => {
    installApiGetMock({ movies: () => Promise.reject(new Error("pool fetch down")) });
    view = renderIntoBody(<HomeContent />);
    await flush();

    expect(findRetryButton(view)).toBeUndefined();
    expect(view.container.textContent).toContain("Nothing in progress");
  });

  // browser-shell-browse-F8 (owner ruling 2026-08-24): on a library smaller
  // than the featured over-fetch, the Recently Added rail listed every
  // candidate, the whole-rail exclusion emptied the pool, and the flagship
  // banner could never render at all. The exclusion is now the rail's
  // VISIBLE FIRST PAGE only (RECENTLY_ADDED_VISIBLE_CARDS in HomeContent.tsx).
  it("REGRESSION GUARD: the banner still appears when the Recently Added rail covers the whole candidate over-fetch", async () => {
    installMatchMedia();
    const movies = Array.from({ length: 14 }, (_, i) => movieFixture(i + 1));
    installApiGetMock({
      recentlyAdded: () => page(movies.map((item) => ({ itemType: "movie", item }))),
      movies: () => page(movies),
    });

    view = renderHome(<HomeContent />);
    await flushDeep();

    expect(view.container.textContent).toContain("FEATURED ·");
    // Exactly the rail's off-screen tail, most-recently-added first: the
    // ten cards sharing the fold with the banner stay excluded (the real
    // README constraint — no duplicate in the same fold).
    const dotLabels = Array.from(view.container.querySelectorAll('[role="radio"]')).map((dot) => dot.getAttribute("aria-label"));
    expect(dotLabels).toEqual([
      "Show featured title: Movie 11",
      "Show featured title: Movie 12",
      "Show featured title: Movie 13",
      "Show featured title: Movie 14",
    ]);
  });

  // d4-w2: browser-items-F9 coalesced the SHARED id fetch (limit=200,
  // lib/watchlist-id-store.ts) but not this rail's own entry fetch
  // (limit=20), which the bootstrap effect issued directly — so /home still
  // fired two identical GET /watchlist per mount in dev, one per StrictMode
  // effect invocation. The rail's page now goes through
  // lib/watchlist-rail.ts, which shares the request while it is in flight.
  it("d4-w2: the watchlist rail fires ONE GET /watchlist per Home mount under StrictMode's effect double-invoke", async () => {
    installApiGetMock({});
    view = renderIntoBody(
      <StrictMode>
        <HomeContent />
      </StrictMode>,
    );
    await flush();

    expect(callsTo("/watchlist")).toHaveLength(1);
  });

  it("d4-w2: a later Home mount re-seeds the rail (the in-flight share is not a cache)", async () => {
    installApiGetMock({});
    view = renderIntoBody(<HomeContent />);
    await flush();
    view.unmount();
    view = null;

    view = renderIntoBody(<HomeContent />);
    await flush();

    expect(callsTo("/watchlist")).toHaveLength(2);
  });
});
