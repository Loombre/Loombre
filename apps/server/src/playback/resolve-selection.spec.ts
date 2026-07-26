// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/resolve-selection.spec.ts
//
// Pure unit tests for resolveTrackSelection (docs/PLAYBACK.md §2.6, Phase
// 3 §11 step 6b). No DB/HTTP — plain data in, TrackSelection out.

import { describe, expect, it } from "vitest";
import { resolveTrackSelection } from "./resolve-selection.js";

const VIDEO = [
  { index: 0, codec: "h264" as const, profile: null, level: null, width: 1920, height: 1080, bitDepth: 8 as const, frameRate: 24, bitrateBps: null, hdr: "none" as const, dvProfile: null, dvBlCompatId: null, interlaced: false },
  { index: 1, codec: "h264" as const, profile: null, level: null, width: 1280, height: 720, bitDepth: 8 as const, frameRate: 24, bitrateBps: null, hdr: "none" as const, dvProfile: null, dvBlCompatId: null, interlaced: false },
];

const AUDIO = [
  { index: 2, codec: "aac" as const, channels: 2, sampleRate: 48000, bitrateBps: null, language: "eng", isDefault: false, hasAtmos: false },
  { index: 3, codec: "aac" as const, channels: 6, sampleRate: 48000, bitrateBps: null, language: "jpn", isDefault: true, hasAtmos: false },
  { index: 4, codec: "aac" as const, channels: 2, sampleRate: 48000, bitrateBps: null, language: "fra", isDefault: false, hasAtmos: false },
];

const SUBTITLE = [
  { index: 5, codec: "subrip" as const, language: "eng", isForced: false, isDefault: false, isExternal: false, externalPath: null },
  { index: 6, codec: "subrip" as const, language: "jpn", isForced: true, isDefault: false, isExternal: false, externalPath: null },
  { index: 7, codec: "subrip" as const, language: "fra", isForced: true, isDefault: false, isExternal: false, externalPath: null },
];

function media(overrides: Partial<{ video: typeof VIDEO; audio: typeof AUDIO; subtitle: typeof SUBTITLE }> = {}) {
  return { video: VIDEO, audio: AUDIO, subtitle: SUBTITLE, ...overrides };
}

describe("resolveTrackSelection — video", () => {
  it("no pin -> lowest index", () => {
    const sel = resolveTrackSelection(media(), {}, null);
    expect(sel.videoStreamIndex).toBe(0);
  });

  it("pin wins over lowest index", () => {
    const sel = resolveTrackSelection(media(), { videoStreamIndex: 1 }, null);
    expect(sel.videoStreamIndex).toBe(1);
  });

  it("pin to a nonexistent index falls back to the normal cascade", () => {
    const sel = resolveTrackSelection(media(), { videoStreamIndex: 99 }, null);
    expect(sel.videoStreamIndex).toBe(0);
  });

  it("no video streams (music) -> null", () => {
    const sel = resolveTrackSelection(media({ video: [] }), {}, null);
    expect(sel.videoStreamIndex).toBeNull();
  });
});

describe("resolveTrackSelection — audio", () => {
  it("pin wins over everything else", () => {
    const sel = resolveTrackSelection(media(), { audioStreamIndex: 4 }, "jpn");
    expect(sel.audioStreamIndex).toBe(4);
  });

  it("no pin -> language-pref match wins over isDefault", () => {
    const sel = resolveTrackSelection(media(), {}, "fra");
    expect(sel.audioStreamIndex).toBe(4);
  });

  it("no pin, no matching language -> isDefault", () => {
    const sel = resolveTrackSelection(media(), {}, "deu");
    expect(sel.audioStreamIndex).toBe(3); // index 3 is isDefault
  });

  it("no pin, no language pref at all -> isDefault", () => {
    const sel = resolveTrackSelection(media(), {}, null);
    expect(sel.audioStreamIndex).toBe(3);
  });

  it("no pin, no language pref, no isDefault stream -> lowest index", () => {
    const noDefault = AUDIO.map((a) => ({ ...a, isDefault: false }));
    const sel = resolveTrackSelection(media({ audio: noDefault }), {}, null);
    expect(sel.audioStreamIndex).toBe(2);
  });

  it("no audio streams -> null", () => {
    const sel = resolveTrackSelection(media({ audio: [] }), {}, null);
    expect(sel.audioStreamIndex).toBeNull();
  });
});

describe("resolveTrackSelection — subtitle", () => {
  it("pin wins over auto-forced matching", () => {
    const sel = resolveTrackSelection(media(), { audioStreamIndex: 3, subtitleStreamIndex: 5 }, null);
    expect(sel.subtitleStreamIndex).toBe(5);
  });

  it("no pin -> forced subtitle matching the RESOLVED audio's language (auto)", () => {
    // Resolved audio index 3 -> language 'jpn'; forced 'jpn' subtitle is index 6.
    const sel = resolveTrackSelection(media(), {}, null);
    expect(sel.audioStreamIndex).toBe(3);
    expect(sel.subtitleStreamIndex).toBe(6);
  });

  it("no pin, no forced subtitle matching audio language -> none", () => {
    const sel = resolveTrackSelection(media(), { audioStreamIndex: 2 }, null); // audio 'eng', no forced 'eng' sub
    expect(sel.subtitleStreamIndex).toBeNull();
  });

  it("no subtitle streams at all -> none", () => {
    const sel = resolveTrackSelection(media({ subtitle: [] }), {}, null);
    expect(sel.subtitleStreamIndex).toBeNull();
  });

  it("a non-forced subtitle matching the audio language is NOT auto-selected (forced-only auto rule)", () => {
    const sel = resolveTrackSelection(media(), { audioStreamIndex: 2 }, null); // audio 'eng'; index 5 is 'eng' but NOT forced
    expect(sel.subtitleStreamIndex).toBeNull();
  });
});
