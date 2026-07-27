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
});
