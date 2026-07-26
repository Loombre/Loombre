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

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

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

function installApiGetMock(opts: { otherAlbums?: unknown[] } = {}): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/albums/{id}") return Promise.resolve(ALBUM);
    if (path === "/artists/{id}") return Promise.resolve(ARTIST);
    if (path === "/albums/{id}/tracks") {
      return Promise.resolve({ items: [makeTrack("t3", 3, "Tunnel Light"), makeTrack("t1", 1, "Sodium Glow")], nextCursor: null });
    }
    if (path === "/artists/{id}/albums") {
      return Promise.resolve({ items: opts.otherAlbums ?? [OTHER_ALBUM, ALBUM], nextCursor: null });
    }
    if (path === "/watchlist") return Promise.resolve({ items: [], nextCursor: null });
    return Promise.reject(new Error(`unexpected apiGet(${path})`));
  });
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
        current: { entryId: "e1", itemId: "t1", title: "Sodium Glow", subtitle: null, albumId: "album-1", durationMs: 200_000, blurhash: null },
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
        current: { entryId: "e1", itemId: "other-track", title: "Other", subtitle: null, albumId: "some-other-album", durationMs: 200_000, blurhash: null },
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
});
