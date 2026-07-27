// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueDrawer } from "./QueueDrawer.js";
import { MusicPlayerContext, type MusicPlayerContextValue } from "./MusicPlayerProvider.js";
import { initialQueueState, type QueueState, type QueueTrack } from "../../lib/queue.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

// QueueDrawer only ever reads `queueState` + calls the handful of queue
// actions — it never touches <audio>/network directly (that's
// MusicPlayerProvider's job). Rendering against a hand-built context value
// (exported from MusicPlayerProvider.tsx for exactly this reason) keeps
// this test a pure, fast render/interaction test instead of exercising real
// playback sessions.
function track(entryId: string): QueueTrack {
  return { entryId, itemId: entryId, mediaFileId: null, title: `Track ${entryId}`, subtitle: "Some Artist", albumId: "album-1", durationMs: 200_000, blurhash: null };
}

function makeQueueState(entryIds: string[], currentIndex: number | null): QueueState {
  return { items: entryIds.map(track), currentIndex };
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
    queueDrawerOpen: true,
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

function renderDrawer(player: MusicPlayerContextValue): TestRender {
  return renderIntoBody(
    <MusicPlayerContext.Provider value={player}>
      <QueueDrawer />
    </MusicPlayerContext.Provider>,
  );
}

describe("QueueDrawer", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders nothing when the drawer is closed", () => {
    view = renderDrawer(makePlayer({ queueDrawerOpen: false }));
    expect(view.container.firstChild).toBeNull();
  });

  it("shows an empty state with nothing queued", () => {
    view = renderDrawer(makePlayer());
    expect(view.container.textContent).toContain("Nothing queued");
  });

  // H14 (Phosphor Wave-3, README "Music": "the current track cannot be
  // removed") — the real regression this fix targets.
  it("disables the remove control on the current track's row, and only that row", () => {
    const player = makePlayer({ queueState: makeQueueState(["a", "b", "c"], 1) });
    view = renderDrawer(player);

    const removeButtons = view.container.querySelectorAll('button[aria-label="Remove from queue"]');
    expect(removeButtons).toHaveLength(3);
    expect((removeButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((removeButtons[1] as HTMLButtonElement).disabled).toBe(true); // currentIndex
    expect((removeButtons[2] as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking remove on a non-current row calls removeFromQueue with that row's entryId", () => {
    const player = makePlayer({ queueState: makeQueueState(["a", "b", "c"], 1) });
    view = renderDrawer(player);

    const removeButtons = Array.from(view.container.querySelectorAll('button[aria-label="Remove from queue"]')) as HTMLButtonElement[];
    act(() => {
      removeButtons[2]!.click();
    });
    expect(player.removeFromQueue).toHaveBeenCalledWith("c");
  });

  it("a disabled remove button is inert — clicking the current row's remove is a no-op", () => {
    const player = makePlayer({ queueState: makeQueueState(["a", "b", "c"], 1) });
    view = renderDrawer(player);

    const removeButtons = Array.from(view.container.querySelectorAll('button[aria-label="Remove from queue"]')) as HTMLButtonElement[];
    act(() => {
      removeButtons[1]!.click(); // currentIndex row, disabled
    });
    expect(player.removeFromQueue).not.toHaveBeenCalled();
  });

  it("still disables up/down at the queue boundaries (pre-existing behavior, untouched)", () => {
    const player = makePlayer({ queueState: makeQueueState(["a", "b"], 0) });
    view = renderDrawer(player);

    const upButtons = view.container.querySelectorAll('button[aria-label="Move up"]');
    const downButtons = view.container.querySelectorAll('button[aria-label="Move down"]');
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((downButtons[downButtons.length - 1] as HTMLButtonElement).disabled).toBe(true);
  });
});
