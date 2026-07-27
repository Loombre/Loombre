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

    // Wave 2 L7: the glyphs have their numerals baked in, so the amounts
    // are part of the contract — back 15s, forward 30s.
    button(view, "Back 15 seconds").click();
    expect(p.onSeekRelative).toHaveBeenCalledWith(-15_000);
    button(view, "Forward 30 seconds").click();
    expect(p.onSeekRelative).toHaveBeenCalledWith(30_000);

    button(view, "Mute").click();
    expect(p.onToggleMute).toHaveBeenCalledTimes(1);
    button(view, "Fullscreen").click();
    expect(p.onToggleFullscreen).toHaveBeenCalledTimes(1);
    button(view, "Back").click();
    expect(p.onBack).toHaveBeenCalledTimes(1);
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
