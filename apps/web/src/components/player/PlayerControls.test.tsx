// SPDX-License-Identifier: AGPL-3.0-only

// The H6 capability chips must name the track the player actually selected.
// `selectedAudioIndex`/`selectedSubtitleIndex` are media STREAM indices —
// the same values TrackPickers emits from `stream.index` — so every fixture
// here uses realistic non-positional indices (video is stream 0, audio 1..n,
// subtitles after that). A chip resolved by array subscript instead of by
// stream identity names the wrong track, or none at all, and these cases
// are what catch that.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { PlayerControls, type PlayerControlsProps } from "./PlayerControls.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type AudioStream = components["schemas"]["AudioStream"];
type SubtitleStream = components["schemas"]["SubtitleStream"];
type PlaybackPlan = components["schemas"]["PlaybackPlan"];

// jsdom has no window.matchMedia, which PlayerControls now needs (S7/K9's
// chapters button picks a desktop popover vs mobile BottomSheet via
// useMediaQuery) — VideoPlayer.test.tsx's identical note. A static "always
// desktop" stub is enough here: none of this file's cases exercise the
// phone-vs-desktop chapters panel split, only the capability chips and
// transport wiring around it.
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

function audio(index: number, overrides: Partial<AudioStream> = {}): AudioStream {
  return {
    index,
    codec: "eac3",
    channels: 6,
    sampleRate: 48_000,
    bitrateBps: 640_000,
    language: "eng",
    isDefault: index === 1,
    hasAtmos: false,
    ...overrides,
  };
}

function subtitle(index: number, overrides: Partial<SubtitleStream> = {}): SubtitleStream {
  return {
    index,
    codec: "subrip",
    language: "eng",
    isForced: false,
    isDefault: false,
    isExternal: false,
    externalPath: null,
    ...overrides,
  };
}

function plan(decision: PlaybackPlan["decision"]): PlaybackPlan {
  return {
    decision,
    reasons: [],
    container: decision === "direct-play" ? "source" : "fmp4-hls",
    video: { action: decision === "transcode" ? "transcode" : "copy" },
    audio: { action: "copy" },
    subtitle: { strategy: "none" },
    ladder: [],
    ffmpegArgs: [],
    engineVersion: "1.0.0",
  };
}

function props(overrides: Partial<PlayerControlsProps> = {}): PlayerControlsProps {
  return {
    visible: true,
    title: "Arrival",
    isPlaying: false,
    positionMs: 0,
    durationMs: 600_000,
    buffered: [],
    volume: 1,
    muted: false,
    isFullscreen: false,
    buffering: false,
    audioStreams: [],
    subtitleStreams: [],
    selectedAudioIndex: null,
    selectedSubtitleIndex: null,
    chapters: [],
    videoElement: null,
    directPlay: true,
    plan: null,
    onBack: vi.fn(),
    onTogglePlay: vi.fn(),
    onSeek: vi.fn(),
    onSeekRelative: vi.fn(),
    onVolumeChange: vi.fn(),
    onToggleMute: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onSelectAudio: vi.fn(),
    onSelectSubtitle: vi.fn(),
    ...overrides,
  };
}

function button(view: TestRender, label: string): HTMLButtonElement {
  const el = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no button labelled "${label}"`);
  return el;
}

describe("PlayerControls — capability chips", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("names the selected audio track by stream index, not by array position", () => {
    view = renderIntoBody(
      <PlayerControls
        {...props({
          audioStreams: [audio(1), audio(2, { codec: "aac", channels: 2, isDefault: false })],
          selectedAudioIndex: 2,
        })}
      />,
    );
    expect(view.container.textContent).toContain("AAC 2CH");
    expect(view.container.textContent).not.toContain("EAC3 6CH");
  });

  it("still names the only track of a single-audio file (stream index 1, array position 0)", () => {
    view = renderIntoBody(<PlayerControls {...props({ audioStreams: [audio(1)], selectedAudioIndex: 1 })} />);
    expect(view.container.textContent).toContain("EAC3 6CH");
  });

  it("names the selected subtitle track by stream index", () => {
    view = renderIntoBody(
      <PlayerControls
        {...props({
          subtitleStreams: [subtitle(3), subtitle(4, { codec: "ass", language: "fra" })],
          selectedSubtitleIndex: 4,
        })}
      />,
    );
    expect(view.container.textContent).toContain("ASS FRA");
  });

  it("reads SUBTITLES OFF when nothing is selected, and omits the chip when the file has none", () => {
    view = renderIntoBody(<PlayerControls {...props({ subtitleStreams: [subtitle(3)], selectedSubtitleIndex: null })} />);
    expect(view.container.textContent).toContain("SUBTITLES OFF");
    view.unmount();

    view = renderIntoBody(<PlayerControls {...props()} />);
    expect(view.container.textContent).not.toContain("SUBTITLES");
  });

  it("shows the session's real decision and never invents one", () => {
    view = renderIntoBody(<PlayerControls {...props({ plan: plan("remux") })} />);
    expect(view.container.textContent).toContain("REMUX");
    view.unmount();

    view = renderIntoBody(<PlayerControls {...props({ plan: null })} />);
    expect(view.container.textContent).not.toContain("REMUX");
  });
});

describe("PlayerControls — transport wiring", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("wires play/pause, both seek buttons, mute, fullscreen and back to their own callbacks", () => {
    const p = props({ isPlaying: true });
    view = renderIntoBody(<PlayerControls {...p} />);

    button(view, "Pause").click();
    expect(p.onTogglePlay).toHaveBeenCalledTimes(1);

    // Wave 2 L7 / LD-12(b): the glyphs have their numerals baked in, so the
    // amounts are part of the contract — 10s both directions.
    button(view, "Back 10 seconds").click();
    expect(p.onSeekRelative).toHaveBeenCalledWith(-10_000);
    button(view, "Forward 10 seconds").click();
    expect(p.onSeekRelative).toHaveBeenCalledWith(10_000);

    button(view, "Mute").click();
    expect(p.onToggleMute).toHaveBeenCalledTimes(1);
    button(view, "Fullscreen").click();
    expect(p.onToggleFullscreen).toHaveBeenCalledTimes(1);
    button(view, "Back").click();
    expect(p.onBack).toHaveBeenCalledTimes(1);
  });

  it("LD-12(a): groups the transport cluster (skip/play/mute/volume) in its own wrapper, separate from the right-aligned fullscreen/picker controls", () => {
    const p = props({ isPlaying: true });
    view = renderIntoBody(<PlayerControls {...p} />);

    const backButton = button(view, "Back 10 seconds");
    const playButton = button(view, "Pause");
    const forwardButton = button(view, "Forward 10 seconds");
    const muteButton = button(view, "Mute");
    const volumeSlider = view.container.querySelector('input[aria-label="Volume"]')!;
    const fullscreenButton = button(view, "Fullscreen");

    // The three-zone bar: skip-back/play/skip-forward/volume all share ONE
    // parent (the centered cluster) — a real DOM grouping the CSS module's
    // equal-flex left/right zones center as a unit, not five independently
    // positioned siblings.
    const cluster = backButton.parentElement!;
    expect(cluster).toBe(playButton.parentElement);
    expect(cluster).toBe(forwardButton.parentElement);
    expect(cluster).toBe(muteButton.parentElement);
    expect(cluster.contains(volumeSlider)).toBe(true);

    // Fullscreen (and the picker buttons, when present) live in a SEPARATE
    // right-hand wrapper, not the centered cluster.
    expect(fullscreenButton.parentElement).not.toBe(cluster);
    expect(cluster.contains(fullscreenButton)).toBe(false);

    // The cluster sits after an empty leading spacer element (the left
    // zone that balances the right zone to actually center it) and before
    // the right-hand wrapper — left spacer, centered cluster, right
    // controls, in that order.
    const controlsRow = cluster.parentElement!;
    const rowChildren = Array.from(controlsRow.children);
    const clusterIndex = rowChildren.indexOf(cluster);
    expect(clusterIndex).toBeGreaterThan(0);
    expect(rowChildren[clusterIndex - 1]!.children.length).toBe(0); // the left spacer is empty
    expect(rowChildren[clusterIndex + 1]!.contains(fullscreenButton)).toBe(true);
  });

  it("only mounts the track pickers once a track popover is opened, and forwards directPlay", () => {
    const p = props({ audioStreams: [audio(1), audio(2)], selectedAudioIndex: 1, directPlay: false });
    view = renderIntoBody(<PlayerControls {...p} />);
    expect(view.container.textContent).not.toContain("Audio");

    const toggle = button(view, "Audio and subtitle tracks");
    act(() => toggle.click());
    expect(view.container.textContent).toContain("server-selected for this session");
  });
});

// S7/K9: the Chapters button/list — mission spec "zero chapters -> zero
// UI" (no button at all when the item has none) and "clicking a chapter
// seeks" (via the same onSeek prop the scrubber/seek buttons use).
describe("PlayerControls — chapters", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders no Chapters button at all for an item with zero chapters", () => {
    view = renderIntoBody(<PlayerControls {...props({ chapters: [] })} />);
    expect(view.container.querySelector('button[aria-label="Chapters"]')).toBeNull();
  });

  it("opens the chapter list from the Chapters button and seeks + closes on a click", () => {
    const p = props({
      chapters: [
        { title: "Opening", startMs: 0 },
        { title: "Midpoint", startMs: 32 * 60_000 },
      ],
    });
    view = renderIntoBody(<PlayerControls {...p} />);

    const toggle = button(view, "Chapters");
    expect(view.container.textContent).not.toContain("Midpoint");
    act(() => toggle.click());
    expect(view.container.textContent).toContain("Opening");
    expect(view.container.textContent).toContain("Midpoint");

    const midpointEntry = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Midpoint"));
    expect(midpointEntry).toBeTruthy();
    act(() => midpointEntry?.click());
    expect(p.onSeek).toHaveBeenCalledWith(32 * 60_000);
    // Selecting a chapter closes the popover, same as TrackPickers-style
    // pickers don't (this one is a one-shot navigation, not a persistent
    // toggle) — the list content unmounts.
    expect(view.container.textContent).not.toContain("Midpoint");
  });
});
