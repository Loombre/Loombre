// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/MovieDetailScreen.test.tsx
//
// Regression guard (77-agent review, confirmed[15]): the primary
// GET /movies/{id} fetch used to be a bare `.then()` with no `.catch()`,
// so a 404'd (deleted/mistyped/restricted-without-clearance, see
// STATE.md) or transiently-failing id left the loading skeleton up
// forever — never the "not found"/retry feedback app/people/[id]/page.tsx
// already had. useDetailFetch.ts generalizes that page's pattern.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui/Toast.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

// MetadataCard (rendered once the movie loads) uses SheetOrModal ->
// useMediaQuery -> window.matchMedia, which jsdom doesn't implement — same
// stub as components/player/UnavailableScreen.test.tsx's installMatchMedia.
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

const apiGetMock = vi.fn();

// Same FakeLoombreApiError convention as lib/use-watched-state.test.tsx:
// mocking the module's own LoombreApiError export keeps `instanceof` checks
// inside useDetailFetch.ts (also imported against this mocked module)
// working against a class the test itself controls.
class FakeLoombreApiError extends Error {
  readonly status: number;
  constructor(status: number, message = "Request failed") {
    super(message);
    this.status = status;
  }
}

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeLoombreApiError,
}));

// Imported AFTER the mock so the module under test picks it up (same
// convention as AlbumDetailScreen.test.tsx / use-watched-state.test.tsx).
const { MovieDetailScreen } = await import("./MovieDetailScreen.js");

const MOVIE = {
  id: "movie-1",
  libraryId: "lib-1",
  itemType: "movie" as const,
  title: "Night Circuit",
  sortTitle: "Night Circuit",
  year: 2022,
  communityRating: null,
  contentClass: "general" as const,
  addedAtMs: 0,
  updatedAtMs: 0,
  runtimeMs: 6_000_000,
  genres: [],
  images: [],
};

/** Only `/movies/{id}` is under test here — WatchlistToggle's
 *  useWatchlistIds() (lib/watchlist-sync.ts) also fires its own /watchlist
 *  fetch once the movie loads and the action row mounts, so that path
 *  needs a real (empty) response rather than sharing the movie mock's
 *  once-only rejections/resolutions, mirroring AlbumDetailScreen.test.tsx's
 *  path-switching apiGet mock. */
function installApiGetMock(fetchMovie: () => Promise<unknown>): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/movies/{id}") return fetchMovie();
    if (path === "/watchlist") return Promise.resolve({ items: [], nextCursor: null });
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

function renderScreen(): TestRender {
  return renderIntoBody(
    <ToastProvider>
      <MovieDetailScreen id="movie-1" serverUrl="https://loombre.local" accessToken="tok" />
    </ToastProvider>,
  );
}

describe("MovieDetailScreen", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("REGRESSION GUARD: renders 'Movie not found.' instead of an infinite skeleton on a 404", async () => {
    installApiGetMock(() => Promise.reject(new FakeLoombreApiError(404, "Not Found")));
    view = renderScreen();
    await flush();

    expect(view.container.textContent).toContain("Movie not found.");
  });

  it("REGRESSION GUARD: on a non-404 failure, renders an error message with a working Retry instead of an infinite skeleton", async () => {
    installMatchMedia();
    let succeed = false;
    installApiGetMock(() => (succeed ? Promise.resolve(MOVIE) : Promise.reject(new Error("network down"))));
    view = renderScreen();
    await flush();

    const retryButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    expect(retryButton).toBeDefined();

    succeed = true;
    act(() => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(view.container.textContent).toContain("Night Circuit");
  });

  it("still renders the real movie once /movies/{id} resolves (no regression on the happy path)", async () => {
    installMatchMedia();
    installApiGetMock(() => Promise.resolve(MOVIE));
    view = renderScreen();
    await flush();

    expect(view.container.textContent).toContain("Night Circuit");
    expect(view.container.textContent).not.toContain("not found");
  });
});
