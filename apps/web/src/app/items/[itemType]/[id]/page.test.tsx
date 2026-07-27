// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/items/[itemType]/[id]/page.test.tsx
//
// Regression guard (77-agent review, confirmed[15]): EpisodeDetail/
// ArtistDetail/TrackDetail's primary fetches used to be bare `.then()`
// calls with no `.catch()`, so a 404'd (deleted/mistyped/restricted-
// without-clearance, see STATE.md) or transiently-failing id left the
// loading skeleton up forever — never the "not found"/retry feedback
// app/people/[id]/page.tsx already had. useDetailFetch.ts (components/
// detail/) generalizes that page's pattern; this exercises the three
// screens in ./DetailScreens.tsx (this route's component tree) that now
// use it.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../../components/ui/test-render.js";

const apiGetMock = vi.fn();

class FakeLoombreApiError extends Error {
  readonly status: number;
  constructor(status: number, message = "Request failed") {
    super(message);
    this.status = status;
  }
}

vi.mock("../../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeLoombreApiError,
}));

// Imported AFTER the mock so the module under test picks it up.
// The three screens live beside page.tsx rather than in it: Next rejects any
// non-route export from a `page.tsx` (see ./DetailScreens.tsx's header).
const { EpisodeDetail, ArtistDetail, TrackDetail } = await import("./DetailScreens.js");

const EPISODE = {
  id: "ep-1",
  libraryId: "lib-1",
  itemType: "episode" as const,
  title: "The Pilot",
  sortTitle: "The Pilot",
  year: 2020,
  communityRating: null,
  contentClass: "general" as const,
  addedAtMs: 0,
  updatedAtMs: 0,
  seasonId: "season-1",
  seriesId: "series-1",
  episodeNumber: 1,
  runtimeMs: 2_520_000,
  overview: null,
  images: [],
};

const ARTIST = {
  id: "artist-1",
  libraryId: "lib-1",
  itemType: "artist" as const,
  title: "Cassette Ghosts",
  sortTitle: "Cassette Ghosts",
  year: null,
  communityRating: null,
  contentClass: "general" as const,
  addedAtMs: 0,
  updatedAtMs: 0,
  genres: [],
  images: [],
};

const TRACK = {
  id: "track-1",
  libraryId: "lib-1",
  itemType: "track" as const,
  title: "Sodium Glow",
  sortTitle: "Sodium Glow",
  year: 2024,
  communityRating: null,
  contentClass: "general" as const,
  addedAtMs: 0,
  updatedAtMs: 0,
  albumId: "album-1",
  artistId: "artist-1",
  trackNumber: 1,
  discNumber: null,
  durationMs: 200_000,
  images: [],
};

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

describe("EpisodeDetail", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
  });

  it("REGRESSION GUARD: renders 'Episode not found.' instead of an infinite skeleton on a 404", async () => {
    apiGetMock.mockImplementation((path: string) =>
      path === "/episodes/{id}" ? Promise.reject(new FakeLoombreApiError(404)) : Promise.reject(new Error(`unexpected ${path}`)),
    );
    view = renderIntoBody(<EpisodeDetail id="ep-1" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    expect(view.container.textContent).toContain("Episode not found.");
  });

  it("REGRESSION GUARD: on a non-404 failure, renders an error message with a working Retry", async () => {
    let succeed = false;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/episodes/{id}") return succeed ? Promise.resolve(EPISODE) : Promise.reject(new Error("network down"));
      if (path === "/series/{id}") return Promise.resolve({ id: "series-1", title: "Marrow Line" });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    view = renderIntoBody(<EpisodeDetail id="ep-1" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    const retryButton = findRetryButton(view);
    expect(retryButton).toBeDefined();

    succeed = true;
    act(() => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(view.container.textContent).toContain("The Pilot");
  });

  it("still renders the real episode once /episodes/{id} resolves (no regression on the happy path)", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/episodes/{id}") return Promise.resolve(EPISODE);
      if (path === "/series/{id}") return Promise.resolve({ id: "series-1", title: "Marrow Line" });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    view = renderIntoBody(<EpisodeDetail id="ep-1" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    expect(view.container.textContent).toContain("The Pilot");
    expect(view.container.textContent).not.toContain("not found");
  });
});

describe("ArtistDetail", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
  });

  it("REGRESSION GUARD: renders 'Artist not found.' instead of an infinite skeleton on a 404", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/artists/{id}") return Promise.reject(new FakeLoombreApiError(404));
      if (path === "/artists/{id}/albums") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    view = renderIntoBody(<ArtistDetail id="artist-1" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    expect(view.container.textContent).toContain("Artist not found.");
  });

  it("REGRESSION GUARD: on a non-404 failure, renders an error message with a working Retry", async () => {
    let succeed = false;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/artists/{id}") return succeed ? Promise.resolve(ARTIST) : Promise.reject(new Error("network down"));
      if (path === "/artists/{id}/albums") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    view = renderIntoBody(<ArtistDetail id="artist-1" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    const retryButton = findRetryButton(view);
    expect(retryButton).toBeDefined();

    succeed = true;
    act(() => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(view.container.textContent).toContain("Cassette Ghosts");
  });
});

describe("TrackDetail", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
  });

  it("REGRESSION GUARD: renders 'Track not found.' instead of an infinite skeleton on a 404", async () => {
    apiGetMock.mockRejectedValue(new FakeLoombreApiError(404));
    view = renderIntoBody(<TrackDetail id="track-1" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    expect(view.container.textContent).toContain("Track not found.");
  });

  it("REGRESSION GUARD: on a non-404 failure, renders an error message with a working Retry", async () => {
    let succeed = false;
    apiGetMock.mockImplementation(() => (succeed ? Promise.resolve(TRACK) : Promise.reject(new Error("network down"))));
    view = renderIntoBody(<TrackDetail id="track-1" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    const retryButton = findRetryButton(view);
    expect(retryButton).toBeDefined();

    succeed = true;
    act(() => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(view.container.textContent).toContain("Sodium Glow");
  });
});
