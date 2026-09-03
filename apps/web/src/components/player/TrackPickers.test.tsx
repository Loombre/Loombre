// SPDX-License-Identifier: AGPL-3.0-only

// The selection value threaded through this picker is a media STREAM index
// (ffprobe's, as carried on AudioStream.index) — never a position in the
// props array, which contains only the audio/subtitle streams and so skips
// the file's video stream(s). Every fixture below therefore uses realistic
// non-positional indices (video is 0, audio is 1..n) so a subscript-instead-
// of-identity regression cannot pass.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { TrackPickers, applyAudioTrackSelection, audioSwitchBlockedReason } from "./TrackPickers.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

type AudioStream = components["schemas"]["AudioStream"];
type SubtitleStream = components["schemas"]["SubtitleStream"];

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

/** A <video> stand-in with the WebKit-only audioTracks API present. */
function videoWithAudioTracks(trackCount: number): HTMLVideoElement {
  const video = document.createElement("video");
  const tracks = Array.from({ length: trackCount }, (_, i) => ({ id: String(i), enabled: i === 0 }));
  Object.defineProperty(video, "audioTracks", { value: tracks, configurable: true });
  return video;
}

/** jsdom's HTMLMediaElement DOES expose `audioTracks`, unlike the real
 *  Chrome/Firefox this branch exists for, so a real element can't model
 *  "the API is absent" — a bare stand-in is the only way to express it. */
function videoWithoutAudioTracks(): HTMLVideoElement {
  return {} as HTMLVideoElement;
}

/** Every audio-group case below renders with `subtitleStreams: []`, so the
 *  rendered buttons are exactly the audio entries. */
function audioButtons(view: TestRender): HTMLButtonElement[] {
  return Array.from(view.container.querySelectorAll("button"));
}

describe("TrackPickers — audio", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("reports the selected track by stream index, not by array position", () => {
    const onSelectAudio = vi.fn();
    view = renderIntoBody(
      <TrackPickers
        audioStreams={[audio(1), audio(2, { codec: "aac", channels: 2, isDefault: false })]}
        subtitleStreams={[]}
        selectedAudioIndex={2}
        selectedSubtitleIndex={null}
        videoElement={videoWithAudioTracks(2)}
        directPlay
        onSelectAudio={onSelectAudio}
        onSelectSubtitle={vi.fn()}
      />,
    );
    const buttons = audioButtons(view);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("data-active")).toBe("false");
    expect(buttons[1]?.getAttribute("data-active")).toBe("true");

    buttons[0]?.click();
    expect(onSelectAudio).toHaveBeenCalledWith(1);
  });

  it("enables switching only for a direct-play session on a browser with the audioTracks API", () => {
    view = renderIntoBody(
      <TrackPickers
        audioStreams={[audio(1), audio(2)]}
        subtitleStreams={[]}
        selectedAudioIndex={1}
        selectedSubtitleIndex={null}
        videoElement={videoWithAudioTracks(2)}
        directPlay
        onSelectAudio={vi.fn()}
        onSelectSubtitle={vi.fn()}
      />,
    );
    for (const button of audioButtons(view)) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("title")).toBeNull();
    }
    expect(view.container.textContent).not.toContain("server-selected");
  });

  it("disables every audio entry for an HLS session and says the server picked the track", () => {
    const onSelectAudio = vi.fn();
    view = renderIntoBody(
      <TrackPickers
        audioStreams={[audio(1), audio(2)]}
        subtitleStreams={[]}
        selectedAudioIndex={1}
        selectedSubtitleIndex={null}
        // WebKit-shaped element (audioTracks present) — the API being there
        // must NOT be enough on its own, which is the whole defect.
        videoElement={videoWithAudioTracks(1)}
        directPlay={false}
        onSelectAudio={onSelectAudio}
        onSelectSubtitle={vi.fn()}
      />,
    );
    const buttons = audioButtons(view);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toContain("the server selected the audio track");
    }
    expect(view.container.textContent).toContain("server-selected for this session");

    buttons[1]?.click();
    expect(onSelectAudio).not.toHaveBeenCalled();
  });

  it("disables direct-play entries with the browser reason when audioTracks is absent", () => {
    view = renderIntoBody(
      <TrackPickers
        audioStreams={[audio(1), audio(2)]}
        subtitleStreams={[]}
        selectedAudioIndex={1}
        selectedSubtitleIndex={null}
        videoElement={videoWithoutAudioTracks()}
        directPlay
        onSelectAudio={vi.fn()}
        onSelectSubtitle={vi.fn()}
      />,
    );
    for (const button of audioButtons(view)) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toBe("This browser doesn't support switching audio tracks");
    }
    expect(view.container.textContent).not.toContain("server-selected");
  });

  it("never blocks or annotates a single-stream file — there is nothing to switch to", () => {
    view = renderIntoBody(
      <TrackPickers
        audioStreams={[audio(1)]}
        subtitleStreams={[]}
        selectedAudioIndex={1}
        selectedSubtitleIndex={null}
        videoElement={videoWithoutAudioTracks()}
        directPlay={false}
        onSelectAudio={vi.fn()}
        onSelectSubtitle={vi.fn()}
      />,
    );
    const buttons = audioButtons(view);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.disabled).toBe(false);
    expect(view.container.textContent).not.toContain("server-selected");
  });
});

describe("audioSwitchBlockedReason", () => {
  it("blocks every non-direct-play session regardless of browser support", () => {
    expect(audioSwitchBlockedReason(false, videoWithAudioTracks(1))).toContain("the server selected the audio track");
    expect(audioSwitchBlockedReason(false, null)).toContain("the server selected the audio track");
  });

  it("blocks direct-play only when the audioTracks API is missing", () => {
    expect(audioSwitchBlockedReason(true, videoWithoutAudioTracks())).toBe(
      "This browser doesn't support switching audio tracks",
    );
    expect(audioSwitchBlockedReason(true, videoWithAudioTracks(2))).toBeNull();
  });
});

describe("applyAudioTrackSelection", () => {
  it("enables exactly the requested stream's track, resolved by stream index", () => {
    const video = videoWithAudioTracks(3);
    const streams = [audio(1), audio(2), audio(3)];
    applyAudioTrackSelection(video, 3, streams);
    const tracks = (video as HTMLVideoElement & { audioTracks: { enabled: boolean }[] }).audioTracks;
    expect(tracks.map((t) => t.enabled)).toEqual([false, false, true]);
  });

  it("bails when the element's track list doesn't line up with the file's streams", () => {
    // An HLS session: one server-resolved track on the element, N in the
    // file. Disabling "the others" would silence the only real one.
    const video = videoWithAudioTracks(1);
    const streams = [audio(1), audio(2)];
    applyAudioTrackSelection(video, 2, streams);
    const tracks = (video as HTMLVideoElement & { audioTracks: { enabled: boolean }[] }).audioTracks;
    expect(tracks[0]?.enabled).toBe(true);
  });

  it("is a no-op when the browser has no audioTracks API at all", () => {
    const video = videoWithoutAudioTracks();
    expect(() => applyAudioTrackSelection(video, 1, [audio(1)])).not.toThrow();
  });
});

describe("TrackPickers — subtitles", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function render(streams: SubtitleStream[], selected: number | null, onSelectSubtitle = vi.fn()): HTMLButtonElement[] {
    view = renderIntoBody(
      <TrackPickers
        audioStreams={[]}
        subtitleStreams={streams}
        selectedAudioIndex={null}
        selectedSubtitleIndex={selected}
        videoElement={videoWithoutAudioTracks()}
        directPlay
        onSelectAudio={vi.fn()}
        onSelectSubtitle={onSelectSubtitle}
      />,
    );
    return Array.from(view.container.querySelectorAll("button"));
  }

  it("text subtitles are live entries — selecting one reports its stream index", () => {
    const onSelectSubtitle = vi.fn();
    const buttons = render([subtitle(3), subtitle(5, { codec: "ass", language: "jpn" })], null, onSelectSubtitle);
    expect(buttons.map((b) => b.textContent)).toEqual(["Off", "SUBRIP · eng", "ASS · jpn"]);
    expect(buttons[1]?.disabled).toBe(false);
    expect(buttons[2]?.disabled).toBe(false);
    expect(view?.container.textContent).not.toContain("requires transcoding");

    buttons[1]?.click();
    expect(onSelectSubtitle).toHaveBeenCalledWith(3);
  });

  it("image subtitles stay disabled with an honest burn-in note", () => {
    const buttons = render([subtitle(4, { codec: "pgs", language: "fra" }), subtitle(6, { codec: "vobsub", language: "deu" })], null);
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[2]?.disabled).toBe(true);
    expect(buttons[1]?.textContent).toContain("needs burn-in (transcode)");
    expect(buttons[1]?.title).toContain("burn");
  });

  it("Off is always live, active when nothing is selected, and reports null", () => {
    const onSelectSubtitle = vi.fn();
    const buttons = render([subtitle(3)], null, onSelectSubtitle);
    expect(buttons[0]?.textContent).toBe("Off");
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[0]?.getAttribute("data-active")).toBe("true");
    expect(buttons[1]?.getAttribute("data-active")).toBe("false");
    buttons[0]?.click();
    expect(onSelectSubtitle).toHaveBeenCalledWith(null);
  });

  it("the selected text subtitle is marked active and Off is not", () => {
    const buttons = render([subtitle(3), subtitle(4, { codec: "pgs" })], 3);
    expect(buttons[0]?.getAttribute("data-active")).toBe("false");
    expect(buttons[1]?.getAttribute("data-active")).toBe("true");
  });
});
