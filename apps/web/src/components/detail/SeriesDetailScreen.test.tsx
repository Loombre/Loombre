// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/SeriesDetailScreen.test.tsx
//
// Regression guard (77-agent review, confirmed[15]): the primary
// GET /series/{id} fetch used to be a bare `.then()` with no `.catch()`,
// so a 404'd (deleted/mistyped/restricted-without-clearance, see
// STATE.md) or transiently-failing id left the loading skeleton up
// forever — never the "not found"/retry feedback app/people/[id]/page.tsx
// already had. useDetailFetch.ts generalizes that page's pattern.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui/Toast.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const apiGetMock = vi.fn();

// Same FakeLoombreApiError convention as lib/use-watched-state.test.tsx /
// MovieDetailScreen.test.tsx: mocking the module's own LoombreApiError
// export keeps `instanceof` checks inside useDetailFetch.ts working
// against a class this test controls.
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

/** Records what a real next/link click would hand to the client router.
 *  Same stub (and same reason) as PlayLink.test.tsx's: vitest resolves the
 *  bare "next/link" specifier to Next's PAGES build, so the shipped App
 *  Router Link cannot intercept a click under jsdom. It models what the real
 *  component does on an unmodified primary click — preventDefault() then a
 *  client-side router navigation. */
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

// Imported AFTER the mock so the module under test picks it up.
const { SeriesDetailScreen } = await import("./SeriesDetailScreen.js");

const SERIES = {
  id: "series-1",
  libraryId: "lib-1",
  itemType: "series" as const,
  title: "Marrow Line",
  sortTitle: "Marrow Line",
  year: 2021,
  communityRating: null,
  contentClass: "general" as const,
  addedAtMs: 0,
  updatedAtMs: 0,
  status: "ended" as const,
};

const SEASON = {
  id: "season-1",
  libraryId: "lib-1",
  itemType: "season" as const,
  title: "Season 1",
  sortTitle: "Season 1",
  year: 2021,
  communityRating: null,
  contentClass: "general" as const,
  addedAtMs: 0,
  updatedAtMs: 0,
  seriesId: "series-1",
  seasonNumber: 1,
  episodeCount: 2,
  images: [],
};

function makeEpisode(id: string, episodeNumber: number, title: string) {
  return {
    id,
    libraryId: "lib-1",
    itemType: "episode" as const,
    title,
    sortTitle: title,
    year: 2021,
    communityRating: null,
    contentClass: "general" as const,
    addedAtMs: 0,
    updatedAtMs: 0,
    seasonId: "season-1",
    seriesId: "series-1",
    episodeNumber,
    runtimeMs: 42 * 60_000,
    overview: null,
    images: [],
  };
}

const EPISODES = [makeEpisode("ep-1", 1, "Cold Open"), makeEpisode("ep-2", 2, "Second Pass")];

/** browser-items-F11: the fully-loaded shape (seasons + episodes + one
 *  played episode's Progress) — the only state in which the screen has
 *  both a resume target AND a non-empty "N OF M SEEN" readout to render,
 *  which is what makes the desktop/mobile parity assertion meaningful. */
function installFullSeriesMock(): void {
  apiGetMock.mockImplementation((path: string, options?: { params?: { path?: { itemId?: string } } }) => {
    if (path === "/series/{id}") return Promise.resolve(SERIES);
    if (path === "/series/{id}/seasons") return Promise.resolve({ items: [SEASON], nextCursor: null });
    if (path === "/seasons/{id}/episodes") return Promise.resolve({ items: EPISODES, nextCursor: null });
    if (path === "/progress/{itemId}") {
      const itemId = options?.params?.path?.itemId;
      // ep-1 watched, ep-2 has no progress row at all (a real 404 —
      // lib/progress-lookup.ts maps that to null without a list walk).
      return itemId === "ep-1"
        ? Promise.resolve({ itemId, positionMs: 0, durationMs: null, state: "played", playCount: 1, updatedAtMs: 1 })
        : Promise.reject(new FakeLoombreApiError(404, "Not Found"));
    }
    if (path === "/watchlist") return Promise.resolve({ items: [], nextCursor: null });
    return Promise.reject(new Error(`unexpected apiGet(${path})`));
  });
}

/** The watchlist control, wherever it sits in a given responsive tree. */
function watchlistToggles(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll("button")).filter((b) => (b.textContent ?? "").includes("Watchlist"));
}

/** WatchlistToggle's useWatchlistIds() and the sibling seasons effect each
 *  fire their own apiGet calls independent of the primary /series/{id}
 *  fetch under test — path-switching mirrors AlbumDetailScreen.test.tsx's
 *  convention rather than order-dependent once-only mocks. */
function installApiGetMock(fetchSeries: () => Promise<unknown>): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/series/{id}") return fetchSeries();
    if (path === "/series/{id}/seasons") return Promise.resolve({ items: [], nextCursor: null });
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

/** The seasons effect is a 3-deep await chain (seasons -> per-season
 *  episodes -> per-episode progress); microtask-only flushing lands
 *  mid-chain, so the fully-loaded assertions need real macrotask turns. */
async function flushAll(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function renderScreen(): TestRender {
  return renderIntoBody(
    <ToastProvider>
      <SeriesDetailScreen id="series-1" serverUrl="https://loombre.local" accessToken="tok" />
    </ToastProvider>,
  );
}

describe("SeriesDetailScreen", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
  });

  it("REGRESSION GUARD: renders 'Series not found.' instead of an infinite skeleton on a 404", async () => {
    installApiGetMock(() => Promise.reject(new FakeLoombreApiError(404, "Not Found")));
    view = renderScreen();
    await flush();

    expect(view.container.textContent).toContain("Series not found.");
  });

  it("REGRESSION GUARD: on a non-404 failure, renders an error message with a working Retry instead of an infinite skeleton", async () => {
    let succeed = false;
    installApiGetMock(() => (succeed ? Promise.resolve(SERIES) : Promise.reject(new Error("network down"))));
    view = renderScreen();
    await flush();

    const retryButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    expect(retryButton).toBeDefined();

    succeed = true;
    act(() => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(view.container.textContent).toContain("Marrow Line");
  });

  it("still renders the real series once /series/{id} resolves (no regression on the happy path)", async () => {
    installApiGetMock(() => Promise.resolve(SERIES));
    view = renderScreen();
    await flush();

    expect(view.container.textContent).toContain("Marrow Line");
    expect(view.container.textContent).not.toContain("not found");
  });

  it("browser-items-F11 REGRESSION GUARD: the MOBILE tree carries the watchlist toggle AND the 'N OF M SEEN' readout, not just desktop", async () => {
    installFullSeriesMock();
    view = renderScreen();
    await flushAll();

    const desktop = view.container.querySelector('[class*="desktopOnly"]');
    const mobile = view.container.querySelector('[class*="mobileOnly"]');
    expect(desktop).not.toBeNull();
    expect(mobile).not.toBeNull();

    // Desktop already had both; mobile used to render neither, so a phone
    // viewer lost a capability a desktop viewer of the same series has.
    expect(watchlistToggles(desktop!)).toHaveLength(1);
    expect(watchlistToggles(mobile!)).toHaveLength(1);
    expect(desktop!.textContent).toContain("1 OF 2 SEEN");
    expect(mobile!.textContent).toContain("1 OF 2 SEEN");
  });

  it("browser-items-F11: the mobile toggle joins the ONE shared GET /watchlist (browser-items-F9 store), it does not add a fetch", async () => {
    installFullSeriesMock();
    view = renderScreen();
    await flushAll();

    expect(watchlistToggles(view.container)).toHaveLength(2);
    expect(apiGetMock.mock.calls.filter((call) => call[0] === "/watchlist")).toHaveLength(1);
  });
});

// QA d3-c3 (verify/browser-items-F1 adjacent): the "Continue SxEy" primary
// action — rendered once per responsive tree — is a /watch entry whose href
// is a VARIABLE (`/watch/${resumeTarget.episodeId}`). It was a raw <a href>,
// i.e. a FULL document navigation (live-confirmed: the pre-click window
// token was gone and the navigation type was 'navigate'), and the whole-src
// guard in PlayLink.test.tsx could not see it because that guard only
// matched LITERAL /watch hrefs. Same obligation as every other /watch entry:
// the document must survive the trip (PlayLink.tsx's header has the full
// mechanism).
describe("SeriesDetailScreen — the primary action is a client-side navigation (QA d3-c3)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
    clientNav.pushes.length = 0;
  });

  it("REGRESSION GUARD: clicking 'Continue …' navigates INSIDE the document", async () => {
    installFullSeriesMock();
    view = renderScreen();
    await flushAll();

    // ep-1 is played and ep-2 has no progress row, so ep-2 is the resume
    // target in BOTH trees (desktop + mobile are one component tree, U2).
    const actions = Array.from(view.container.querySelectorAll('a[href^="/watch/"]'));
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.getAttribute("href"))).toEqual(["/watch/ep-2", "/watch/ep-2"]);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    (actions[0] as Element).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(clientNav.pushes).toEqual(["/watch/ep-2"]);
  });
});
