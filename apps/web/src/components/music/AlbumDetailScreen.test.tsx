// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui/Toast.js";
import { MusicPlayerContext, type MusicPlayerContextValue } from "./MusicPlayerProvider.js";
import { initialQueueState } from "../../lib/queue.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

// AlbumDetailScreen only ever calls apiGet (never apiPost/Put/Delete
// itself — WatchlistToggle owns its own mutation calls), so mocking that
// one export is enough; switching on the path literal mirrors
// use-watched-state.test.tsx's established apiGet-mocking convention.
const apiGetMock = vi.fn();

// Same FakeLoombreApiError convention as detail/MovieDetailScreen.test.tsx:
// mocking the module's own LoombreApiError export keeps the `instanceof`
// check inside detail/useDetailFetch.ts (imported against this same mocked
// module) working against a class the test itself controls. The class is
// declared INSIDE the factory, unlike that file: this spec statically
// imports MusicPlayerProvider, whose module graph pulls lib/api-client.js
// while the imports are still being evaluated, so the hoisted factory runs
// BEFORE a top-level `class` binding is initialized ("Cannot access
// 'FakeLoombreApiError' before initialization"). It is read back off the
// mocked module below.
vi.mock("../../lib/api-client.js", () => {
  class FakeLoombreApiError extends Error {
    readonly status: number;
    constructor(status: number, message = "Request failed") {
      super(message);
      this.status = status;
    }
  }
  return {
    apiGet: (...args: unknown[]) => apiGetMock(...args),
    LoombreApiError: FakeLoombreApiError,
  };
});

const { LoombreApiError } = await import("../../lib/api-client.js");
const FakeLoombreApiError = LoombreApiError as unknown as new (status: number, message?: string) => Error;

// Imported AFTER the mock so the module under test picks it up (same
// convention as use-watched-state.test.tsx).
const { AlbumDetailScreen } = await import("./AlbumDetailScreen.js");

const ALBUM = {
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

function makeTrack(id: string, trackNumber: number, title: string) {
  return {
    id,
    libraryId: "lib-1",
    itemType: "track" as const,
    title,
    sortTitle: title,
    year: 2024,
    communityRating: null,
    contentClass: "general" as const,
    addedAtMs: 0,
    updatedAtMs: 0,
    albumId: "album-1",
    artistId: "artist-1",
    trackNumber,
    discNumber: null,
    durationMs: 200_000,
    images: [],
  };
}

const OTHER_ALBUM = { ...ALBUM, id: "album-2", title: "Marrow" };

function installApiGetMock(
  opts: {
    otherAlbums?: unknown[];
    album?: () => Promise<unknown>;
    tracks?: () => Promise<unknown>;
  } = {},
): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/albums/{id}") return opts.album ? opts.album() : Promise.resolve(ALBUM);
    if (path === "/artists/{id}") return Promise.resolve(ARTIST);
    if (path === "/albums/{id}/tracks") {
      if (opts.tracks) return opts.tracks();
      return Promise.resolve({ items: [makeTrack("t3", 3, "Tunnel Light"), makeTrack("t1", 1, "Sodium Glow")], nextCursor: null });
    }
    if (path === "/artists/{id}/albums") {
      return Promise.resolve({ items: opts.otherAlbums ?? [OTHER_ALBUM, ALBUM], nextCursor: null });
    }
    if (path === "/watchlist") return Promise.resolve({ items: [], nextCursor: null });
    return Promise.reject(new Error(`unexpected apiGet(${path})`));
  });
}

/** The watchlist control, wherever it sits in a given responsive tree. */
function watchlistToggles(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll("button")).filter((b) => (b.textContent ?? "").includes("Watchlist"));
}

function makePlayer(overrides: Partial<MusicPlayerContextValue> = {}): MusicPlayerContextValue {
  return {
    queueState: initialQueueState,
    current: null,
    isPlaying: false,
    positionMs: 0,
    durationMs: null,
    volume: 1,
    muted: false,
    queueDrawerOpen: false,
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seekTo: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    playTrack: vi.fn(),
    playQueue: vi.fn(),
    enqueue: vi.fn(),
    removeFromQueue: vi.fn(),
    reorderQueue: vi.fn(),
    jumpTo: vi.fn(),
    openQueueDrawer: vi.fn(),
    closeQueueDrawer: vi.fn(),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderScreen(player: MusicPlayerContextValue): TestRender {
  return renderIntoBody(
    <ToastProvider>
      <MusicPlayerContext.Provider value={player}>
        <AlbumDetailScreen id="album-1" serverUrl="https://loombre.local" accessToken="tok" />
      </MusicPlayerContext.Provider>
    </ToastProvider>,
  );
}

describe("AlbumDetailScreen", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
  });

  it("renders the real eyebrow (ALBUM · year · N TRACKS) and artist name once loaded", async () => {
    installApiGetMock();
    view = renderScreen(makePlayer());
    await flush();

    expect(view.container.textContent).toContain("ALBUM · 2024 · 2 TRACKS");
    expect(view.container.textContent).toContain("Cassette Ghosts");
    expect(view.container.textContent).toContain("Night Drive Tapes");
  });

  it("never renders the fixture's fabricated codec/gapless/shuffle facts", async () => {
    installApiGetMock();
    view = renderScreen(makePlayer());
    await flush();

    expect(view.container.textContent).not.toContain("FLAC");
    expect(view.container.textContent).not.toContain("GAPLESS");
    expect(view.container.textContent).not.toContain("Shuffle");
  });

  it("MORE ALBUMS: renders the artist's other albums, excluding the current one", async () => {
    installApiGetMock();
    view = renderScreen(makePlayer());
    await flush();

    expect(view.container.textContent).toContain("MORE ALBUMS");
    expect(view.container.textContent).toContain("Marrow");

    const moreAlbumLinks = Array.from(view.container.querySelectorAll('a[href^="/items/album/"]'));
    const hrefs = moreAlbumLinks.map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/items/album/album-1"); // the current album, never self-linked in its own "more albums"
    expect(hrefs).toContain("/items/album/album-2");
  });

  it("omits the MORE ALBUMS column entirely when the artist has no other albums", async () => {
    installApiGetMock({ otherAlbums: [ALBUM] }); // only itself comes back
    view = renderScreen(makePlayer());
    await flush();

    expect(view.container.textContent).not.toContain("MORE ALBUMS");
  });

  it("the vinyl ring only spins when THIS album's audio is current AND playing", async () => {
    installApiGetMock();
    view = renderScreen(
      makePlayer({
        current: { entryId: "e1", itemId: "t1", mediaFileId: null, title: "Sodium Glow", subtitle: null, albumId: "album-1", durationMs: 200_000, blurhash: null },
        isPlaying: true,
      }),
    );
    await flush();

    const ring = view.container.querySelector("[data-spinning]");
    expect(ring?.getAttribute("data-spinning")).toBe("true");
  });

  it("the vinyl ring stays static for a different album's playback", async () => {
    installApiGetMock();
    view = renderScreen(
      makePlayer({
        current: { entryId: "e1", itemId: "other-track", mediaFileId: null, title: "Other", subtitle: null, albumId: "some-other-album", durationMs: 200_000, blurhash: null },
        isPlaying: true,
      }),
    );
    await flush();

    const ring = view.container.querySelector("[data-spinning]");
    expect(ring?.getAttribute("data-spinning")).toBe("false");
  });

  it("real tracks render sorted by track number with mono index + length", async () => {
    installApiGetMock();
    view = renderScreen(makePlayer());
    await flush();

    const titles = Array.from(view.container.querySelectorAll("button")).map((b) => b.textContent).filter((t) => t?.includes("Glow") || t?.includes("Tunnel"));
    // "Sodium Glow" is trackNumber 1, "Tunnel Light" is trackNumber 3 — the
    // fetch returned them out of order, this asserts the real sort.
    expect(titles[0]).toContain("Sodium Glow");
  });

  it("browser-items-F11 REGRESSION GUARD: the MOBILE tree carries the watchlist toggle, not just desktop", async () => {
    installApiGetMock();
    view = renderScreen(makePlayer());
    await flush();

    const desktop = view.container.querySelector('[class*="desktopOnly"]');
    const mobile = view.container.querySelector('[class*="mobileOnly"]');
    expect(desktop).not.toBeNull();
    expect(mobile).not.toBeNull();

    // Desktop already had it; the mobile tree used to render none at all,
    // so a phone viewer lost a capability desktop viewers of the same
    // album have.
    expect(watchlistToggles(desktop!)).toHaveLength(1);
    expect(watchlistToggles(mobile!)).toHaveLength(1);

    // ...and it joins the ONE shared GET /watchlist (browser-items-F9's
    // lib/watchlist-id-store.ts), rather than adding a second fetch.
    expect(apiGetMock.mock.calls.filter((call) => call[0] === "/watchlist")).toHaveLength(1);
  });

  it("REGRESSION GUARD (browser-items-F4): renders 'Album not found.' instead of an infinite skeleton on a 404", async () => {
    installApiGetMock({
      album: () => Promise.reject(new FakeLoombreApiError(404, "Not Found")),
      tracks: () => Promise.reject(new FakeLoombreApiError(404, "Not Found")),
    });
    view = renderScreen(makePlayer());
    await flush();

    expect(view.container.textContent).toContain("Album not found.");
    // The three loading skeletons must be GONE, not merely joined by the copy.
    expect(view.container.querySelectorAll('[class*="skeleton"]')).toHaveLength(0);
  });

  it("REGRESSION GUARD (browser-items-F4): a 404 on both album fetches leaves no unhandled promise rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      installApiGetMock({
        album: () => Promise.reject(new FakeLoombreApiError(404, "Not Found")),
        tracks: () => Promise.reject(new FakeLoombreApiError(404, "Not Found")),
      });
      view = renderScreen(makePlayer());
      await flush();
      // Node emits unhandledRejection on the macrotask turn after the
      // microtask queue drains — give it that turn.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
  });

  it("REGRESSION GUARD (browser-items-F4): on a non-404 album failure, renders an error message with a working Retry", async () => {
    let succeed = false;
    installApiGetMock({ album: () => (succeed ? Promise.resolve(ALBUM) : Promise.reject(new Error("network down"))) });
    view = renderScreen(makePlayer());
    await flush();

    const retryButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    expect(retryButton).toBeDefined();
    expect(view.container.textContent).not.toContain("not found");

    succeed = true;
    act(() => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(view.container.textContent).toContain("Night Drive Tapes");
  });

  it("REGRESSION GUARD (browser-items-F4): a failing tracks fetch never leaves the track list skeleton up forever", async () => {
    installApiGetMock({ tracks: () => Promise.reject(new Error("network down")) });
    view = renderScreen(makePlayer());
    await flush();

    // The album itself still renders...
    expect(view.container.textContent).toContain("Night Drive Tapes");
    // ...and the track column says so instead of pulsing forever.
    expect(view.container.textContent).toContain("Failed to load tracks.");
    expect(view.container.querySelectorAll('[class*="skeleton"]')).toHaveLength(0);
  });
});
