// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/home/page.test.tsx
//
// Regression guard (77-agent review, confirmed[16]): the Home bootstrap
// effect's /home/continue-watching and /home/recently-added fetches used
// to be bare `.then()`s with no `.catch()` — a transient 5xx/network
// failure left `loading` (and the skeleton it gates, lines ~277-284) stuck
// forever, with no error state and no retry short of a full page reload.

import { act } from "react";
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
vi.mock("../../lib/now-playing.js", () => ({
  useNowPlayingItemIds: () => new Set<string>(),
}));
vi.mock("../../lib/watchlist-sync.js", () => ({
  useWatchlistChangeSignal: () => undefined,
}));

// Imported AFTER the mocks so the module under test picks them up.
// HomeContent lives beside page.tsx rather than in it: Next rejects any
// non-route export from a `page.tsx` (see ./HomeContent.tsx's header).
const { HomeContent } = await import("./HomeContent.js");

function emptyPage(): Promise<{ items: unknown[]; nextCursor: null }> {
  return Promise.resolve({ items: [], nextCursor: null });
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

describe("HomeContent", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
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
});
