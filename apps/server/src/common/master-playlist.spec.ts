// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/master-playlist.spec.ts
//
// Unit + GOLDEN coverage for the §9.1.1 master-playlist renderer. The
// renderer is PURE (stored plan + probed MediaInfo in, string out — no
// filesystem, no worker, no clock), which is exactly what lets it answer
// 200 the instant the session row exists and never 503.
//
// The goldens are checked-in `.m3u8` files under test/goldens/master-playlist/
// compared by FULL TEXT, never a subset: every byte of a master playlist is
// load-bearing to a client, and a CODECS string that drifts by one hex digit
// makes hls.js silently drop the variant rather than fail loudly. Those exact
// strings additionally carry an EXECUTION fence
// (apps/worker/test/transcode/codecs-string-fence.integration.spec.ts) that
// checks them against ffprobe of REAL encoder output — goldens alone can only
// prove the renderer is self-consistent, not that it describes the bytes
// ffmpeg actually writes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderMasterPlaylist, type MasterPlaylistInput } from "./master-playlist.js";

const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "goldens", "master-playlist");
const golden = (name: string): string => readFileSync(join(GOLDENS, `${name}.m3u8`), "utf8");

const VIDEO_1080P = { widthPx: 1920, heightPx: 1080, frameRate: 23.976, bitDepth: 8, codec: "h264" };
const AUDIO_AAC = { codec: "aac", bitrateBps: 160_000 };

function input(overrides: Partial<MasterPlaylistInput> = {}): MasterPlaylistInput {
  return {
    ladder: [
      { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ],
    video: VIDEO_1080P,
    audio: AUDIO_AAC,
    overallBitrateBps: 20_000_000,
    ...overrides,
  };
}

describe("renderMasterPlaylist: goldens (§9.1.1)", () => {
  it("the Tier-0 three-variant h264 master", () => {
    expect(renderMasterPlaylist(input())).toBe(golden("01-t0-three-variant-h264"));
  });

  it("a mixed-codec ladder (hevc 2160p top over av1 rungs) — each variant states its OWN codec", () => {
    const text = renderMasterPlaylist(
      input({
        ladder: [
          { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
          { heightPx: 1080, videoBitrateBps: 2_400_000, audioBitrateBps: 160_000, codec: "av1" },
          { heightPx: 360, videoBitrateBps: 480_000, audioBitrateBps: 160_000, codec: "av1" },
        ],
        video: { widthPx: 3840, heightPx: 2160, frameRate: 23.976, bitDepth: 10, codec: "h264" },
      }),
    );
    expect(text).toBe(golden("02-mixed-codec-hevc-av1"));
  });

  it("a ladder-EMPTY session (direct-stream copy) renders a SINGLE-variant master (owner-decision V5)", () => {
    const text = renderMasterPlaylist(input({ ladder: [], overallBitrateBps: 6_000_000 }));
    expect(text).toBe(golden("03-ladder-empty-copy"));
  });

  it("an audio-only transcode renders one variant with NO RESOLUTION and no video codec", () => {
    const text = renderMasterPlaylist(input({ ladder: [], video: null, overallBitrateBps: 320_000 }));
    expect(text).toBe(golden("04-audio-only"));
  });
});

describe("renderMasterPlaylist: attribute derivation (§9.1.1)", () => {
  it("BANDWIDTH is ceil(1.1 x (video + audio)) and AVERAGE-BANDWIDTH is the plain sum", () => {
    const line = renderMasterPlaylist(input()).split("\n").find((l) => l.startsWith("#EXT-X-STREAM-INF"))!;
    // 8_000_000 + 384_000 = 8_384_000; x1.1 = 9_222_400 (already integral).
    expect(line).toContain("BANDWIDTH=9222400");
    expect(line).toContain("AVERAGE-BANDWIDTH=8384000");
  });

  it("BANDWIDTH is CEILED, never truncated (a peak estimate must not under-state)", () => {
    const text = renderMasterPlaylist(
      input({ ladder: [{ heightPx: 360, videoBitrateBps: 801_111, audioBitrateBps: 0, codec: "h264" }] }),
    );
    // 801_111 x 1.1 = 881_222.1 -> 881_223
    expect(text).toContain("BANDWIDTH=881223");
  });

  it("RESOLUTION uses the arg builder's OWN scale-width arithmetic (source aspect, even-rounded)", () => {
    const text = renderMasterPlaylist(input());
    // 1920x1080 source: 720p -> round(720*1920/1080/2)*2 = round(640)= 640;
    // 360p -> round(360*1920/1080/2)*2 = 640 -> 640x360.
    expect(text).toContain("RESOLUTION=1920x1080");
    expect(text).toContain("RESOLUTION=1280x720");
    expect(text).toContain("RESOLUTION=640x360");
  });

  it("an ODD-aspect source still yields EVEN widths (ffmpeg's scale=-2 contract)", () => {
    const text = renderMasterPlaylist(
      input({
        video: { widthPx: 1919, heightPx: 1080, frameRate: 25, bitDepth: 8, codec: "h264" },
        ladder: [{ heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" }],
      }),
    );
    const res = /RESOLUTION=(\d+)x720/.exec(text)!;
    expect(Number(res[1]) % 2).toBe(0);
  });

  it("a rung at or above the source height keeps the SOURCE width (no upscale is ever emitted)", () => {
    const text = renderMasterPlaylist(
      input({
        video: { widthPx: 1920, heightPx: 1080, frameRate: 25, bitDepth: 8, codec: "h264" },
        ladder: [{ heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" }],
      }),
    );
    expect(text).toContain("RESOLUTION=1920x1080");
  });

  it("FRAME-RATE is the selected stream's, trimmed of trailing zeros", () => {
    expect(renderMasterPlaylist(input())).toContain("FRAME-RATE=23.976");
    expect(
      renderMasterPlaylist(input({ video: { ...VIDEO_1080P, frameRate: 25 } })),
    ).toContain("FRAME-RATE=25");
  });

  it("EXT-X-INDEPENDENT-SEGMENTS is always emitted (every encoded segment opens on an IDR, §6)", () => {
    expect(renderMasterPlaylist(input())).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
  });

  it("variant URIs are v{K}/media.m3u8 with K = the rung's index in plan.ladder", () => {
    const lines = renderMasterPlaylist(input()).split("\n");
    expect(lines.filter((l) => l.startsWith("v"))).toEqual(["v0/media.m3u8", "v1/media.m3u8", "v2/media.m3u8"]);
  });
});

describe("renderMasterPlaylist: CODECS table (§9.1.1 — execution-fenced, never assumed)", () => {
  const codecsOf = (text: string): string[] =>
    text
      .split("\n")
      .filter((l) => l.startsWith("#EXT-X-STREAM-INF"))
      .map((l) => /CODECS="([^"]*)"/.exec(l)?.[1] ?? "");

  it("h264 8-bit is High profile with a HEIGHT-keyed level", () => {
    const text = renderMasterPlaylist(
      input({
        video: { widthPx: 3840, heightPx: 2160, frameRate: 25, bitDepth: 8, codec: "h264" },
        ladder: [
          { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 160_000, codec: "h264" },
          { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 160_000, codec: "h264" },
          { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
        ],
      }),
    );
    expect(codecsOf(text)).toEqual([
      "avc1.640033,mp4a.40.2", // High@5.1
      "avc1.640028,mp4a.40.2", // High@4.0
      "avc1.64001f,mp4a.40.2", // High@3.1
    ]);
  });

  it("h264 10-bit is High10 (a 10-bit stream declared as High would be rejected by a Main/High-only decoder)", () => {
    const text = renderMasterPlaylist(
      input({
        video: { ...VIDEO_1080P, bitDepth: 10 },
        ladder: [{ heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 160_000, codec: "h264" }],
      }),
    );
    expect(codecsOf(text)).toEqual(["avc1.6e0028,mp4a.40.2"]);
  });

  it("hevc is Main / Main10 by bit depth, hvc1 (matching §6's -tag:v hvc1)", () => {
    const eight = renderMasterPlaylist(
      input({ ladder: [{ heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 160_000, codec: "hevc" }] }),
    );
    const ten = renderMasterPlaylist(
      input({
        video: { ...VIDEO_1080P, bitDepth: 10 },
        ladder: [{ heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 160_000, codec: "hevc" }],
      }),
    );
    expect(codecsOf(eight)).toEqual(["hvc1.1.6.L120.B0,mp4a.40.2"]);
    expect(codecsOf(ten)).toEqual(["hvc1.2.4.L120.B0,mp4a.40.2"]);
  });

  it("av1 carries an explicit seq_level_idx from the height table (§6 M emits no -level)", () => {
    const text = renderMasterPlaylist(
      input({
        video: { ...VIDEO_1080P, bitDepth: 10 },
        ladder: [
          { heightPx: 1080, videoBitrateBps: 2_400_000, audioBitrateBps: 160_000, codec: "av1" },
          { heightPx: 360, videoBitrateBps: 480_000, audioBitrateBps: 160_000, codec: "av1" },
        ],
      }),
    );
    expect(codecsOf(text)).toEqual(["av01.0.08M.10,mp4a.40.2", "av01.0.04M.10,mp4a.40.2"]);
  });

  it("the audio half follows the codec the client will actually RECEIVE", () => {
    const opus = renderMasterPlaylist(input({ audio: { codec: "opus", bitrateBps: 128_000 } }));
    expect(codecsOf(opus)[0]).toBe("avc1.640028,opus");
    const eac3 = renderMasterPlaylist(input({ audio: { codec: "eac3", bitrateBps: 640_000 } }));
    expect(codecsOf(eac3)[0]).toBe("avc1.640028,ec-3");
  });

  it("an UNKNOWN codec is OMITTED rather than guessed — a wrong string is worse than none", () => {
    const text = renderMasterPlaylist(input({ audio: { codec: "dts", bitrateBps: 1_500_000 } }));
    expect(codecsOf(text)[0]).toBe("avc1.640028");
  });

  it("no audio at all leaves only the video codec", () => {
    expect(codecsOf(renderMasterPlaylist(input({ audio: null })))[0]).toBe("avc1.640028");
  });

  it("a ladder-empty COPY master states the SOURCE codecs, and omits CODECS entirely when unmappable", () => {
    const vp9 = renderMasterPlaylist(
      input({ ladder: [], video: { ...VIDEO_1080P, codec: "vp9" }, overallBitrateBps: 6_000_000 }),
    );
    expect(codecsOf(vp9)).toEqual(["vp09.00.10.08,mp4a.40.2"]);
    const mpeg2 = renderMasterPlaylist(
      input({ ladder: [], video: { ...VIDEO_1080P, codec: "mpeg2" }, audio: null, overallBitrateBps: 6_000_000 }),
    );
    // Nothing at all is mappable — the attribute is absent, not "".
    expect(mpeg2).not.toContain("CODECS=");
  });
});

describe("renderMasterPlaylist: totality (it must NEVER 503, so it must never throw)", () => {
  it("survives a zero-height/zero-width video fact without dividing by zero", () => {
    const text = renderMasterPlaylist(
      input({ video: { widthPx: 0, heightPx: 0, frameRate: 0, bitDepth: 8, codec: "h264" } }),
    );
    expect(text.startsWith("#EXTM3U")).toBe(true);
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
  });

  it("survives a ladder-empty session with no bitrate facts at all", () => {
    const text = renderMasterPlaylist({ ladder: [], video: null, audio: null, overallBitrateBps: null });
    expect(text).toContain("v0/media.m3u8");
    expect(text).not.toContain("NaN");
  });

  it("is deterministic — the same input renders byte-identically twice", () => {
    expect(renderMasterPlaylist(input())).toBe(renderMasterPlaylist(input()));
  });

  it("ends with exactly one trailing newline", () => {
    const text = renderMasterPlaylist(input());
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});
