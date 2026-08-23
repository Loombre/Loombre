// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/music/MiniPlayerBar.test.tsx
//
// browser-player-F12: the bar's right-hand duration label read
// player.durationMs — a piece of state MusicPlayerProvider only populates
// AFTER the async createDirectPlaySession round-trip for the active slot
// resolves (see that file's loadIntoSlot). The queue ENTRY itself
// (player.current, which QueueDrawer.tsx already renders its "· 3:24" meta
// from) knows its own durationMs immediately, synchronously, the moment it
// becomes current — the bar just never looked at it, so it showed "–:–"
// during that whole async window even though the real duration was already
// in hand.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MiniPlayerBar } from "./MiniPlayerBar.js";
import { MusicPlayerContext, type MusicPlayerContextValue } from "./MusicPlayerProvider.js";
import { initialQueueState, type QueueTrack } from "../../lib/queue.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: "https://example.test", accessToken: "tok" }),
    getAccessToken: async () => "tok",
  }),
}));

const TRACK: QueueTrack = {
  entryId: "e1",
  itemId: "track-1",
  mediaFileId: null,
  title: "Tideline",
  subtitle: "Low Water · 2019",
  albumId: "album-1",
  durationMs: 204_000, // 3:24, matching the queue drawer's own meta
  blurhash: null,
};

function makePlayer(overrides: Partial<MusicPlayerContextValue> = {}): MusicPlayerContextValue {
  return {
    queueState: { ...initialQueueState, items: [TRACK], currentIndex: 0 },
    current: TRACK,
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

function renderBar(player: MusicPlayerContextValue): TestRender {
  return renderIntoBody(
    <MusicPlayerContext.Provider value={player}>
      <MiniPlayerBar />
    </MusicPlayerContext.Provider>,
  );
}

describe("MiniPlayerBar", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("browser-player-F12 REGRESSION GUARD: shows the queued track's own durationMs before the provider's async durationMs state has populated", () => {
    // player.durationMs is still null (the real async-loaded state) even
    // though player.current (the queue entry) already knows its duration —
    // exactly the window the bug lived in.
    view = renderBar(makePlayer({ durationMs: null }));
    expect(view.container.textContent).toContain("3:24");
    expect(view.container.textContent).not.toContain("–:–");
  });

  it("still prefers the provider's confirmed durationMs once it differs from the queue entry's advertised one", () => {
    view = renderBar(makePlayer({ durationMs: 210_000 })); // 3:30, the real probed duration
    expect(view.container.textContent).toContain("3:30");
  });
});
