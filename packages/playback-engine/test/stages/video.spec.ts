// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/stages/video.ts (Stage B — docs/PLAYBACK.md §3, Phase 3
 * Step 2b). Lives in the package's NORMAL (non-matrix) test project
 * (vitest.config.ts's `include` covers `test/**\/*.spec.ts`), separate from
 * matrix/'s case-file burn-up.
 *
 * Coverage (per this step's instructions): every rule (1 interlaced, 2
 * codec-unsupported, 3 per-axis, 4 copy), every null-vacuous branch, the
 * documented profile ladder's boundary behavior, multi-axis reason
 * ordering, and the multi-entry-per-codec "most permissive" fallback.
 */
import { describe, expect, it } from "vitest";
import { evaluateVideo } from "../../src/stages/video.js";
import type { DeviceProfile, DeviceProfileVideoEntry, MediaInfo, VideoStream } from "../../src/types.js";

function makeVideoStream(overrides: Partial<VideoStream> = {}): VideoStream {
  return {
    index: 0,
    codec: "h264",
    profile: "high",
    level: 41,
    width: 1920,
    height: 1080,
    bitDepth: 8,
    frameRate: 23.976,
    bitrateBps: 5_000_000,
    hdr: "none",
    dvProfile: null,
    dvBlCompatId: null,
    interlaced: false,
    ...overrides,
  };
}

function makeMedia(video: VideoStream[]): MediaInfo {
  return {
    fileId: "file-1",
    container: "mp4",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: 8_000_000,
    video,
    audio: [],
    subtitle: [],
  };
}

function makeVideoEntry(overrides: Partial<DeviceProfileVideoEntry> = {}): DeviceProfileVideoEntry {
  return {
    codec: "h264",
    maxProfile: "high",
    maxLevel: 41,
    maxBitDepth: 8,
    maxWidth: 1920,
    maxHeight: 1080,
    maxFrameRate: 60,
    maxBitrateBps: null,
    ...overrides,
  };
}

function makeDevice(video: DeviceProfileVideoEntry[]): DeviceProfile {
  return {
    profileId: "test-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video,
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

describe("Stage B: evaluateVideo — selection / vacuous-pass branches", () => {
  it("videoStreamIndex null -> verdict direct-play, reasons [] (vacuous pass)", () => {
    const media = makeMedia([makeVideoStream({ codec: "hevc" })]); // unsupported codec, but unselected
    const device = makeDevice([makeVideoEntry({ codec: "h264" })]);
    expect(evaluateVideo(media, device, null)).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("media.video is empty (music mode) -> verdict direct-play, reasons [] regardless of index", () => {
    const media = makeMedia([]);
    const device = makeDevice([]);
    expect(evaluateVideo(media, device, 0)).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("selection index does not resolve to any stream (defensive) -> vacuous pass, never throws", () => {
    const media = makeMedia([makeVideoStream({ index: 0 })]);
    const device = makeDevice([makeVideoEntry()]);
    expect(evaluateVideo(media, device, 7)).toEqual({ verdict: "direct-play", reasons: [] });
  });
});

describe("Stage B: rule 4 — fully within caps -> copy", () => {
  it("codec supported, every axis within caps, not interlaced -> direct-play, reasons []", () => {
    const media = makeMedia([makeVideoStream()]);
    const device = makeDevice([makeVideoEntry()]);
    expect(evaluateVideo(media, device, 0)).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("every axis exactly AT the device ceiling passes (boundary equality is never 'exceeds')", () => {
    const media = makeMedia([
      makeVideoStream({ profile: "high", level: 41, bitDepth: 8, width: 1920, height: 1080, frameRate: 60 }),
    ]);
    const device = makeDevice([
      makeVideoEntry({ maxProfile: "high", maxLevel: 41, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 }),
    ]);
    expect(evaluateVideo(media, device, 0)).toEqual({ verdict: "direct-play", reasons: [] });
  });
});

describe("Stage B: rule 1 — interlaced (independent of rule 2, per seed case 007)", () => {
  it("interlaced + codec otherwise fully supported -> transcode, [video-interlaced] only", () => {
    const media = makeMedia([makeVideoStream({ interlaced: true })]);
    const device = makeDevice([makeVideoEntry()]);
    expect(evaluateVideo(media, device, 0)).toEqual({
      verdict: "transcode",
      reasons: [{ code: "video-interlaced", streamIndex: 0 }],
    });
  });

  it("interlaced AND codec unsupported both fire, interlaced first (matrix seed 007's exact interaction)", () => {
    const media = makeMedia([makeVideoStream({ codec: "mpeg2", profile: "main", level: null, interlaced: true })]);
    const device = makeDevice([makeVideoEntry({ codec: "h264" })]); // no mpeg2 entry
    const result = evaluateVideo(media, device, 0);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toEqual(["video-interlaced", "video-codec-unsupported"]);
  });
});

describe("Stage B: rule 2 — codec-unsupported short-circuits rule 3 (matrix seed 002's exact interaction)", () => {
  it("codec absent from device.video -> transcode, [video-codec-unsupported] ONLY, no axis reasons", () => {
    const media = makeMedia([
      // Every axis would ALSO exceed the h264 entry below, if it were even
      // consulted — proving rule 2 short-circuits rule 3 rather than rule 3
      // happening not to fire for unrelated reasons.
      makeVideoStream({ codec: "hevc", profile: "main10", level: 999, bitDepth: 12, width: 7680, height: 4320, frameRate: 120 }),
    ]);
    const device = makeDevice([makeVideoEntry({ codec: "h264" })]);
    expect(evaluateVideo(media, device, 0)).toEqual({
      verdict: "transcode",
      reasons: [{ code: "video-codec-unsupported", streamIndex: 0, detail: "codec=hevc" }],
    });
  });

  it("empty device.video array -> always video-codec-unsupported", () => {
    const media = makeMedia([makeVideoStream()]);
    const device = makeDevice([]);
    const result = evaluateVideo(media, device, 0);
    expect(result.reasons).toEqual([{ code: "video-codec-unsupported", streamIndex: 0, detail: "codec=h264" }]);
  });
});

describe("Stage B: rule 3 — profile axis (documented ladder + null-vacuous + boundary)", () => {
  it("h264 ladder: stream profile ranked above device maxProfile -> video-profile-unsupported", () => {
    const media = makeMedia([makeVideoStream({ profile: "high10" })]);
    const device = makeDevice([makeVideoEntry({ maxProfile: "high" })]);
    const result = evaluateVideo(media, device, 0);
    expect(result.reasons).toEqual([
      { code: "video-profile-unsupported", streamIndex: 0, detail: "profile=high10 max=high" },
    ]);
  });

  it("h264 ladder: stream profile ranked at-or-below device maxProfile -> passes", () => {
    const media = makeMedia([makeVideoStream({ profile: "main" })]);
    const device = makeDevice([makeVideoEntry({ maxProfile: "high" })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });

  it("hevc ladder boundary: main10 stream vs a device declaring only 'main' -> exceeds", () => {
    const media = makeMedia([makeVideoStream({ codec: "hevc", profile: "main10", level: 123, bitDepth: 10 })]);
    const device = makeDevice([
      makeVideoEntry({ codec: "hevc", maxProfile: "main", maxLevel: 153, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 }),
    ]);
    const result = evaluateVideo(media, device, 0);
    expect(result.reasons).toEqual([
      { code: "video-profile-unsupported", streamIndex: 0, detail: "profile=main10 max=main" },
    ]);
  });

  it("exact-equal profile string always passes, even off-ladder ('weird-profile' both sides)", () => {
    const media = makeMedia([makeVideoStream({ profile: "weird-profile" })]);
    const device = makeDevice([makeVideoEntry({ maxProfile: "weird-profile" })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });

  it("stream profile null -> vacuous pass regardless of device maxProfile", () => {
    const media = makeMedia([makeVideoStream({ profile: null })]);
    const device = makeDevice([makeVideoEntry({ maxProfile: "baseline" })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });

  it("device maxProfile null -> vacuous pass regardless of stream profile", () => {
    const media = makeMedia([makeVideoStream({ profile: "high10" })]);
    const device = makeDevice([makeVideoEntry({ maxProfile: null })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });

  it("conservative rule 5: stream profile not in the codec's ladder and != maxProfile -> unsupported, detail names both", () => {
    const media = makeMedia([makeVideoStream({ profile: "exotic-profile" })]);
    const device = makeDevice([makeVideoEntry({ maxProfile: "high" })]);
    const result = evaluateVideo(media, device, 0);
    expect(result.reasons).toEqual([
      { code: "video-profile-unsupported", streamIndex: 0, detail: "profile=exotic-profile max=high" },
    ]);
  });

  it("codec with no documented ladder (av1): exact-string-match-or-exceeds — mismatch fires", () => {
    const media = makeMedia([makeVideoStream({ codec: "av1", profile: "main" })]);
    const device = makeDevice([makeVideoEntry({ codec: "av1", maxProfile: "high" })]);
    const result = evaluateVideo(media, device, 0);
    expect(result.reasons).toEqual([
      { code: "video-profile-unsupported", streamIndex: 0, detail: "profile=main max=high" },
    ]);
  });

  it("codec with no documented ladder (av1): exact match passes", () => {
    const media = makeMedia([makeVideoStream({ codec: "av1", profile: "main" })]);
    const device = makeDevice([makeVideoEntry({ codec: "av1", maxProfile: "main" })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });
});

describe("Stage B: rule 3 — level axis (null-vacuous + boundary + exceeds)", () => {
  it("level exceeds device maxLevel -> video-level-exceeds-device", () => {
    const media = makeMedia([makeVideoStream({ level: 52 })]);
    const device = makeDevice([makeVideoEntry({ maxLevel: 41 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([
      { code: "video-level-exceeds-device", streamIndex: 0, detail: "level=52 max=41" },
    ]);
  });

  it("level exactly equal to maxLevel -> passes", () => {
    const media = makeMedia([makeVideoStream({ level: 41 })]);
    const device = makeDevice([makeVideoEntry({ maxLevel: 41 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });

  it("stream level null -> vacuous pass", () => {
    const media = makeMedia([makeVideoStream({ level: null })]);
    const device = makeDevice([makeVideoEntry({ maxLevel: 30 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });

  it("device maxLevel null -> vacuous pass", () => {
    const media = makeMedia([makeVideoStream({ level: 999 })]);
    const device = makeDevice([makeVideoEntry({ maxLevel: null })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });
});

describe("Stage B: rule 3 — bitDepth axis (always present, boundary + exceeds + 12-bit)", () => {
  it("bitDepth exceeds device maxBitDepth -> video-bitdepth-unsupported", () => {
    const media = makeMedia([makeVideoStream({ bitDepth: 10 })]);
    const device = makeDevice([makeVideoEntry({ maxBitDepth: 8 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([
      { code: "video-bitdepth-unsupported", streamIndex: 0, detail: "bitDepth=10 max=8" },
    ]);
  });

  it("12-bit stream vs a 10-bit-max device -> video-bitdepth-unsupported", () => {
    const media = makeMedia([makeVideoStream({ bitDepth: 12 })]);
    const device = makeDevice([makeVideoEntry({ maxBitDepth: 10 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([
      { code: "video-bitdepth-unsupported", streamIndex: 0, detail: "bitDepth=12 max=10" },
    ]);
  });

  it("bitDepth exactly equal to maxBitDepth -> passes", () => {
    const media = makeMedia([makeVideoStream({ bitDepth: 8 })]);
    const device = makeDevice([makeVideoEntry({ maxBitDepth: 8 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });
});

describe("Stage B: rule 3 — resolution axis (single reason, width-or-height, boundary)", () => {
  it("width exceeds -> ONE video-resolution-exceeds-device reason", () => {
    const media = makeMedia([makeVideoStream({ width: 3840, height: 1080 })]);
    const device = makeDevice([makeVideoEntry({ maxWidth: 1920, maxHeight: 1080 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([
      { code: "video-resolution-exceeds-device", streamIndex: 0, detail: "3840x1080 max=1920x1080" },
    ]);
  });

  it("height exceeds -> ONE video-resolution-exceeds-device reason", () => {
    const media = makeMedia([makeVideoStream({ width: 1920, height: 2160 })]);
    const device = makeDevice([makeVideoEntry({ maxWidth: 1920, maxHeight: 1080 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([
      { code: "video-resolution-exceeds-device", streamIndex: 0, detail: "1920x2160 max=1920x1080" },
    ]);
  });

  it("BOTH width and height exceed -> still exactly ONE reason, never two", () => {
    const media = makeMedia([makeVideoStream({ width: 3840, height: 2160 })]);
    const device = makeDevice([makeVideoEntry({ maxWidth: 1920, maxHeight: 1080 })]);
    const result = evaluateVideo(media, device, 0);
    expect(result.reasons.filter((r) => r.code === "video-resolution-exceeds-device")).toHaveLength(1);
  });

  it("exactly at the device's width/height ceiling -> passes", () => {
    const media = makeMedia([makeVideoStream({ width: 3840, height: 2160 })]);
    const device = makeDevice([makeVideoEntry({ maxWidth: 3840, maxHeight: 2160 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });
});

describe("Stage B: rule 3 — frameRate axis (boundary + exceeds)", () => {
  it("frameRate exceeds device maxFrameRate -> video-framerate-exceeds-device", () => {
    const media = makeMedia([makeVideoStream({ frameRate: 60 })]);
    const device = makeDevice([makeVideoEntry({ maxFrameRate: 30 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([
      { code: "video-framerate-exceeds-device", streamIndex: 0, detail: "frameRate=60 max=30" },
    ]);
  });

  it("frameRate exactly equal to maxFrameRate -> passes", () => {
    const media = makeMedia([makeVideoStream({ frameRate: 60 })]);
    const device = makeDevice([makeVideoEntry({ maxFrameRate: 60 })]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });
});

describe("Stage B: multi-axis reason ordering — profile, level, bitDepth, resolution, framerate", () => {
  it("every axis fails simultaneously -> reasons appear in exactly that order", () => {
    const media = makeMedia([
      makeVideoStream({ profile: "high10", level: 52, bitDepth: 10, width: 3840, height: 2160, frameRate: 60 }),
    ]);
    const device = makeDevice([
      makeVideoEntry({ maxProfile: "high", maxLevel: 41, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 }),
    ]);
    const result = evaluateVideo(media, device, 0);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toEqual([
      "video-profile-unsupported",
      "video-level-exceeds-device",
      "video-bitdepth-unsupported",
      "video-resolution-exceeds-device",
      "video-framerate-exceeds-device",
    ]);
  });

  it("interlaced + multiple axis failures -> video-interlaced still leads", () => {
    const media = makeMedia([makeVideoStream({ interlaced: true, level: 52, frameRate: 60 })]);
    const device = makeDevice([makeVideoEntry({ maxLevel: 41, maxFrameRate: 30 })]);
    const result = evaluateVideo(media, device, 0);
    expect(result.reasons.map((r) => r.code)).toEqual([
      "video-interlaced",
      "video-level-exceeds-device",
      "video-framerate-exceeds-device",
    ]);
  });
});

describe("Stage B: multiple device.video entries for the same codec (binding interpretation constraint 6)", () => {
  it("stream fails entry #1 but entry #2 fully accommodates it -> passes (ANY entry rule)", () => {
    const media = makeMedia([makeVideoStream({ level: 50 })]);
    const device = makeDevice([
      makeVideoEntry({ maxLevel: 41 }), // fails
      makeVideoEntry({ maxLevel: 51 }), // accommodates
    ]);
    expect(evaluateVideo(media, device, 0).reasons).toEqual([]);
  });

  it("per-axis merge would show zero reasons (quirk) — the entries[0] fallback prevents a false pass", () => {
    // Entry 1 covers level but not resolution; entry 2 covers resolution
    // but not level. Neither entry alone accommodates the stream, so the
    // stream must NOT pass (constraint 6: "passes if ANY entry accommodates
    // every axis") — but the per-axis "most permissive" merge (maxLevel
    // from entry 1, maxWidth/maxHeight from entry 2) DOES cover every axis,
    // which would (incorrectly) report zero reasons if taken at face value.
    // The stage's defensive fallback (src/stages/video.ts) detects this and
    // reports against entries[0] instead, guaranteeing a non-empty,
    // resolution-only reason set and preserving reason completeness
    // (docs/PLAYBACK.md §10 property 4) instead of silently downgrading to
    // direct-play.
    const media = makeMedia([makeVideoStream({ level: 45, width: 3840, height: 2160 })]);
    const device = makeDevice([
      makeVideoEntry({ maxLevel: 51, maxWidth: 1920, maxHeight: 1080 }),
      makeVideoEntry({ maxLevel: 41, maxWidth: 3840, maxHeight: 2160 }),
    ]);
    const result = evaluateVideo(media, device, 0);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons).toEqual([
      { code: "video-resolution-exceeds-device", streamIndex: 0, detail: "3840x2160 max=1920x1080" },
    ]);
  });

  it("no single entry accommodates every axis, and the per-axis merge can't either -> reasons reflect the failing axis", () => {
    // Both entries fail resolution (neither's maxWidth/maxHeight covers
    // 3840x2160), so the per-axis merge fails resolution too — this is the
    // "normal" (non-fallback) multi-entry path: the merge itself already
    // yields a non-empty, correct reason set.
    const media = makeMedia([makeVideoStream({ level: 30, width: 3840, height: 2160 })]);
    const device = makeDevice([
      makeVideoEntry({ maxLevel: 51, maxWidth: 1280, maxHeight: 720 }),
      makeVideoEntry({ maxLevel: 41, maxWidth: 1920, maxHeight: 1080 }),
    ]);
    const result = evaluateVideo(media, device, 0);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.every((r) => r.code === "video-resolution-exceeds-device")).toBe(true);
  });
});

describe("Stage B: purity / determinism", () => {
  it("is deterministic: identical inputs produce a deep-equal result across calls", () => {
    const media = makeMedia([makeVideoStream({ level: 52 })]);
    const device = makeDevice([makeVideoEntry({ maxLevel: 41 })]);
    const first = evaluateVideo(media, device, 0);
    const second = evaluateVideo(media, device, 0);
    expect(second).toEqual(first);
  });
});
