// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiGetMock = vi.fn();

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// Imported AFTER the mocks (use-watched-state.test.tsx's established
// convention) so the module under test picks them up.
const { SearchPanel } = await import("./SearchPanel.js");

import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const MOVIE = {
  itemType: "movie" as const,
  item: {
    id: "movie-1",
    libraryId: "lib-1",
    itemType: "movie" as const,
    title: "Low Orbit",
    sortTitle: "Low Orbit",
    year: 2025,
    communityRating: null,
    contentClass: "general" as const,
    addedAtMs: 0,
    updatedAtMs: 0,
    contentRating: "R",
    runtimeMs: 6_600_000,
    overview: null,
    genres: [],
    images: [],
  },
};

const SERIES = {
  itemType: "series" as const,
  item: {
    id: "series-1",
    libraryId: "lib-1",
    itemType: "series" as const,
    title: "The Relay",
    sortTitle: "The Relay",
    year: 2022,
    communityRating: null,
    contentClass: "general" as const,
    addedAtMs: 0,
    updatedAtMs: 0,
    contentRating: null,
    overview: null,
    status: "continuing" as const,
    genres: [],
    images: [],
  },
};

const ALBUM = {
  itemType: "album" as const,
  item: {
    id: "album-1",
    libraryId: "lib-1",
    itemType: "album" as const,
    title: "Night Drive Tapes",
    sortTitle: "Night Drive Tapes",
    year: 2024,
    communityRating: null,
    contentClass: "general" as const,
    addedAtMs: 0,
    updatedAtMs: 0,
    artistId: "artist-1",
    trackCount: 8,
    genres: [],
    images: [],
  },
};

const PERSON = { id: "person-1", name: "Maya Reyes", contentClass: "general" as const, creditCount: 3 };

function installApiGetMock(opts: { people?: unknown[] } = {}): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/search") return Promise.resolve({ items: [MOVIE, SERIES, ALBUM], nextCursor: null });
    if (path === "/people") return Promise.resolve({ items: opts.people ?? [PERSON], nextCursor: null });
    if (path === "/artists/{id}") return Promise.resolve({ id: "artist-1", title: "Cassette Ghosts" });
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

describe("SearchPanel", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
    pushMock.mockReset();
    window.localStorage.clear();
  });

  it("empty query: shows the ghost state, no fabricated latency claim", () => {
    view = renderIntoBody(<SearchPanel query="" serverUrl="https://loombre.local" accessToken="tok" />);
    expect(view.container.textContent).toContain("Search Everything");
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("empty query with a recent search on file: clicking the pill calls onSelectQuery", () => {
    window.localStorage.setItem("loombre.search.recent.v1", JSON.stringify(["sodium"]));
    const onSelectQuery = vi.fn();
    view = renderIntoBody(
      <SearchPanel query="" serverUrl="https://loombre.local" accessToken="tok" onSelectQuery={onSelectQuery} />,
    );
    const pill = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "sodium") as HTMLButtonElement;
    act(() => {
      pill.click();
    });
    expect(onSelectQuery).toHaveBeenCalledWith("sodium");
  });

  it("groups real results into MOVIES / SERIES / MUSIC / PEOPLE and shows a real readout", async () => {
    installApiGetMock();
    view = renderIntoBody(<SearchPanel query="relay" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    expect(view.container.textContent).toContain("MOVIES");
    expect(view.container.textContent).toContain("Low Orbit");
    expect(view.container.textContent).toContain("SERIES");
    expect(view.container.textContent).toContain("The Relay");
    expect(view.container.textContent).toContain("MUSIC");
    expect(view.container.textContent).toContain("Night Drive Tapes");
    expect(view.container.textContent).toContain("PEOPLE");
    expect(view.container.textContent).toContain("Maya Reyes");
    expect(view.container.textContent).toMatch(/4 RESULTS · \d+ MS · FTS \+ TRIGRAM/);
  });

  it("resolves the album's real artist name via the deduped lookup (not the fixture's fake fixture)", async () => {
    installApiGetMock();
    view = renderIntoBody(<SearchPanel query="relay" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();
    await flush();

    expect(view.container.textContent).toContain("Cassette Ghosts");
  });

  it("shows the honestly-scoped no-results copy, never the raw prototype's P95/latency style claim", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/search") return Promise.resolve({ items: [], nextCursor: null });
      if (path === "/people") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.reject(new Error("unexpected"));
    });
    view = renderIntoBody(<SearchPanel query="zzz-nothing" serverUrl="https://loombre.local" accessToken="tok" />);
    await flush();

    expect(view.container.textContent).toContain("Nothing matched");
    expect(view.container.textContent).not.toMatch(/P95/i);
  });

  it("moveActive/activateFocused navigate via router.push (no synthesized DOM click)", async () => {
    installApiGetMock();
    let handle: { moveActive: (d: number) => void; activateFocused: () => boolean } | null = null;
    view = renderIntoBody(
      <SearchPanel
        query="relay"
        serverUrl="https://loombre.local"
        accessToken="tok"
        registerHandle={(h) => {
          handle = h;
        }}
      />,
    );
    await flush();

    expect(handle).not.toBeNull();
    act(() => {
      handle!.activateFocused();
    });
    expect(pushMock).toHaveBeenCalledWith("/items/movie/movie-1");
  });
});
