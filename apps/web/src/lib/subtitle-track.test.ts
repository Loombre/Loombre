// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/subtitle-track.test.ts

import { describe, expect, it } from "vitest";
import { deriveSubtitleTrackInfo, type SubtitleStreamLike } from "./subtitle-track.js";

const STREAMS: SubtitleStreamLike[] = [
  { index: 0, language: "eng" },
  { index: 1, language: "spa" },
  { index: 2, language: null },
];

describe("deriveSubtitleTrackInfo", () => {
  it("returns null for every strategy other than 'hls-vtt'", () => {
    expect(deriveSubtitleTrackInfo("none", undefined, STREAMS, "https://host/sub0.vtt")).toBeNull();
    expect(deriveSubtitleTrackInfo("embed", 0, STREAMS, "https://host/sub0.vtt")).toBeNull();
    expect(deriveSubtitleTrackInfo("burn-in", 0, STREAMS, "https://host/sub0.vtt")).toBeNull();
  });

  it("uses the matched stream's language, uppercased, as the label and lang", () => {
    const info = deriveSubtitleTrackInfo("hls-vtt", 1, STREAMS, "https://host/sub0.vtt?token=t");
    expect(info).toEqual({ src: "https://host/sub0.vtt?token=t", label: "SPA", lang: "spa" });
  });

  it("falls back to a generic label/undefined lang when the matched stream has no language", () => {
    const info = deriveSubtitleTrackInfo("hls-vtt", 2, STREAMS, "https://host/sub0.vtt");
    expect(info).toEqual({ src: "https://host/sub0.vtt", label: "Subtitles", lang: undefined });
  });

  it("falls back to a generic label/undefined lang when streamIndex is absent", () => {
    const info = deriveSubtitleTrackInfo("hls-vtt", undefined, STREAMS, "https://host/sub0.vtt");
    expect(info).toEqual({ src: "https://host/sub0.vtt", label: "Subtitles", lang: undefined });
  });

  it("falls back to a generic label/undefined lang when streamIndex doesn't match any known stream", () => {
    const info = deriveSubtitleTrackInfo("hls-vtt", 99, STREAMS, "https://host/sub0.vtt");
    expect(info).toEqual({ src: "https://host/sub0.vtt", label: "Subtitles", lang: undefined });
  });
});
