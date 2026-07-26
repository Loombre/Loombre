// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { TrackRow } from "./TrackRow.js";
import { MusicPlayerContext, type MusicPlayerContextValue } from "../music/MusicPlayerProvider.js";
import { initialQueueState } from "../../lib/queue.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type Track = components["schemas"]["Track"];

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    libraryId: "lib-1",
    itemType: "track",
    title: "Sodium Glow",
    sortTitle: "Sodium Glow",
    year: 2024,
    communityRating: null,
    contentClass: "general",
    addedAtMs: 0,
    updatedAtMs: 0,
    albumId: "album-1",
    artistId: "artist-1",
    trackNumber: 3,
    discNumber: null,
    durationMs: 222_000, // 3:42
    images: [],
    ...overrides,
  };
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

function renderRow(track: Track, player: MusicPlayerContextValue, index = 0): TestRender {
  return renderIntoBody(
    <MusicPlayerContext.Provider value={player}>
      <TrackRow track={track} albumTracks={[track]} index={index} />
    </MusicPlayerContext.Provider>,
  );
}

describe("TrackRow", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("shows a zero-padded mono track index and mm:ss length when idle", () => {
    view = renderRow(makeTrack({ trackNumber: 3, durationMs: 222_000 }), makePlayer());
    expect(view.container.textContent).toContain("03");
    expect(view.container.textContent).toContain("3:42");
  });

  it("falls back to an em dash for an unknown track number, never a fabricated one", () => {
    view = renderRow(makeTrack({ trackNumber: null }), makePlayer());
    const numberSpan = view.container.querySelector("button > span:first-child");
    expect(numberSpan?.textContent).toBe("–");
  });

  it("renders the index, not an equalizer, when this track is current but paused", () => {
    const track = makeTrack();
    const player = makePlayer({
      current: { entryId: "e1", itemId: track.id, title: track.title, subtitle: null, albumId: track.albumId, durationMs: track.durationMs, blurhash: null },
      isPlaying: false,
    });
    view = renderRow(track, player);
    expect(view.container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(view.container.textContent).toContain("03");
  });

  it("swaps the index for a 3-bar equalizer only when this exact track is current AND playing", () => {
    const track = makeTrack();
    const player = makePlayer({
      current: { entryId: "e1", itemId: track.id, title: track.title, subtitle: null, albumId: track.albumId, durationMs: track.durationMs, blurhash: null },
      isPlaying: true,
    });
    view = renderRow(track, player);
    const eq = view.container.querySelector('[aria-hidden="true"]');
    expect(eq).not.toBeNull();
    expect(eq?.children.length).toBe(3);
  });

  it("does not show the equalizer for a different track even while something else plays", () => {
    const track = makeTrack({ id: "track-1" });
    const player = makePlayer({
      current: { entryId: "e1", itemId: "some-other-track", title: "Other", subtitle: null, albumId: track.albumId, durationMs: 1000, blurhash: null },
      isPlaying: true,
    });
    view = renderRow(track, player);
    expect(view.container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("titles the currently-playing row in accent (data-playing), other rows are not marked", () => {
    const track = makeTrack();
    const player = makePlayer({
      current: { entryId: "e1", itemId: track.id, title: track.title, subtitle: null, albumId: track.albumId, durationMs: track.durationMs, blurhash: null },
      isPlaying: true,
    });
    view = renderRow(track, player);
    const title = Array.from(view.container.querySelectorAll("span")).find((s) => s.textContent === track.title);
    expect(title?.getAttribute("data-playing")).toBe("true");
  });

  it("clicking the row plays the whole album queue starting at this track's index", () => {
    const track = makeTrack();
    const player = makePlayer();
    view = renderRow(track, player, 2);
    act(() => {
      (view!.container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(player.playQueue).toHaveBeenCalledTimes(1);
    const [, startIndex] = (player.playQueue as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(startIndex).toBe(2);
  });

  it("renders no trailing play icon (hover/click-anywhere is the whole affordance, per the prototype)", () => {
    view = renderRow(makeTrack(), makePlayer());
    expect(view.container.querySelector("svg")).toBeNull();
  });
});
