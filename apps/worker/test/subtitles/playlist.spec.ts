// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/subtitles/playlist.spec.ts
//
// Pure unit tests for renderSubtitlePlaylist (docs/PLAYBACK.md §9/P3.9(e)).

import { describe, expect, it } from "vitest";
import { renderSubtitlePlaylist } from "../../src/subtitles/playlist.js";

describe("renderSubtitlePlaylist", () => {
  it("renders a valid single-segment VOD HLS subtitle playlist", () => {
    const text = renderSubtitlePlaylist(125.4, "sub0.vtt");
    const lines = text.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe("#EXT-X-VERSION:3");
    expect(lines[2]).toBe("#EXT-X-TARGETDURATION:126"); // ceil(125.4)
    expect(lines[3]).toBe("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(lines[4]).toBe("#EXTINF:125.400,");
    expect(lines[5]).toBe("sub0.vtt");
    expect(lines[6]).toBe("#EXT-X-ENDLIST");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("target duration is the full media duration (single segment, no re-segmentation)", () => {
    const text = renderSubtitlePlaylist(6_480, "sub0.vtt");
    expect(text).toContain("#EXT-X-TARGETDURATION:6480");
    expect(text).toContain("#EXTINF:6480.000,");
  });

  it("degenerate/invalid duration (<=0, NaN) never produces a malformed playlist", () => {
    for (const bad of [0, -5, Number.NaN]) {
      const text = renderSubtitlePlaylist(bad, "sub0.vtt");
      expect(text).toContain("#EXT-X-TARGETDURATION:1");
      expect(text).toContain("#EXTINF:0.000,");
    }
  });

  it("always exactly one segment entry (VOD, never re-segmented)", () => {
    const text = renderSubtitlePlaylist(60, "sub0.vtt");
    expect(text.match(/#EXTINF/g)?.length).toBe(1);
    expect(text.match(/sub0\.vtt/g)?.length).toBe(1);
  });
});
