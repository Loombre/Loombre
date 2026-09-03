// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/args/builder.ts (the deterministic ffmpeg arg builder —
 * docs/PLAYBACK.md §6, Phase 3 §11 step 4). Lives in the package's NORMAL
 * (non-matrix) test project (vitest.config.ts's `include` covers
 * `test/**\/*.spec.ts`).
 *
 * Coverage (per this step's instructions): the type-relative mapping
 * correctness trap (constructed explicitly with a file whose absolute
 * indexes are video=0, audio=2 — a single audio stream, so its
 * TYPE-RELATIVE position is 0 despite an absolute index of 2), token
 * closure (every emitted arg containing '{' matches exactly one of the
 * closed five-name §6 token set), canonical segment-order assertions, and
 * determinism (double-run byte-equality via JSON.stringify — this package's
 * `stableStringify` isn't needed here since `string[]` has no key-ordering
 * ambiguity).
 *
 * The 28 golden scenarios themselves (full canonical-order snapshots,
 * including the mandatory cpu-zscale tone-map example, step 7b F4's two
 * vaapi burn-in graphs, and the VT tone-map hybrid fallback) live in
 * test/goldens/ + goldens.spec.ts — this file is the FOCUSED unit suite,
 * not a duplicate of that coverage.
 */
import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, type FfmpegPlanShape } from "../../src/args/builder.js";
import type {
  AudioStream,
  DeviceProfile,
  LadderRung,
  MediaInfo,
  PlanInput,
  SubtitleStream,
  VideoStream,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Shared fixture builders (mirrors this package's other test files' style —
// test/stages/hardware.spec.ts, test/plan.spec.ts).
// ---------------------------------------------------------------------------

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
    openGop: false,
    ...overrides,
  };
}

function makeAudioStream(overrides: Partial<AudioStream> = {}): AudioStream {
  return {
    index: 1,
    codec: "aac",
    channels: 2,
    sampleRate: 48000,
    bitrateBps: 160_000,
    language: "eng",
    isDefault: true,
    hasAtmos: false,
    ...overrides,
  };
}

function makeSubtitleStream(overrides: Partial<SubtitleStream> = {}): SubtitleStream {
  return {
    index: 2,
    codec: "subrip",
    language: "eng",
    isForced: false,
    isDefault: false,
    isExternal: false,
    externalPath: null,
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    fileId: "file-1",
    container: "mp4",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: 5_160_000,
    video: [makeVideoStream()],
    audio: [makeAudioStream()],
    subtitle: [],
    ...overrides,
  };
}

function makeDevice(videoEntries: DeviceProfile["video"] = []): DeviceProfile {
  return {
    profileId: "test-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: videoEntries,
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 6, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

function makeInput(overrides: {
  media?: MediaInfo;
  device?: DeviceProfile;
  selection?: PlanInput["selection"];
} = {}): PlanInput {
  return {
    media: overrides.media ?? makeMedia(),
    device: overrides.device ?? makeDevice(),
    network: { maxBitrateBps: 100_000_000, isLocal: true },
    policy: {
      allowTranscode: true,
      allowToneMapCpu: "tier-gated",
      tier: 0,
      preferredTextSubMode: "hls-vtt",
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"],
      maxSimultaneousTranscodes: 1,
      ladderRungs: [],
      segmentDurationSec: 2,
      hevcEncodePreferred: false,
      av1EncodePreferred: false,
    },
    caps: { backends: [{ backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 }] },
    selection: overrides.selection ?? { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    mode: "stream",
  };
}

const RUNG_1080P_H264: LadderRung = {
  heightPx: 1080,
  videoBitrateBps: 4_000_000,
  audioBitrateBps: 160_000,
  codec: "h264",
};

// The CLOSED five-token set (docs/PLAYBACK.md §6) — every `{...}` form this
// builder may ever emit, standalone or embedded.
const CLOSED_TOKENS = ["{INPUT}", "{SESSION_DIR}", "{SEEK_SECONDS}", "{START_SEG}", "{SEG_DUR}"];

describe("buildFfmpegArgs: type-relative mapping trap (docs/PLAYBACK.md §6 segment 5)", () => {
  it("a file whose ABSOLUTE indexes are video=0, audio=2 (one audio stream only) maps to TYPE-RELATIVE 0:a:0, never 0:a:2", () => {
    // Absolute index 2 on a SINGLE audio stream models a real file where
    // stream 1 is something this package's MediaInfo never enumerates (a
    // data/attachment track ffprobe still assigned an index to) — the
    // audio stream's TYPE-RELATIVE position among audio.length===1 is
    // always 0, regardless of its absolute `.index` value. A naive
    // implementation that passed the raw absolute index straight into
    // `-map 0:a:{n}` would wrongly emit `0:a:2`, which (ffmpeg's `a:N`
    // specifier is ALREADY type-relative) would try to select a THIRD
    // audio-type stream that doesn't exist.
    const media = makeMedia({
      video: [makeVideoStream({ index: 0 })],
      audio: [makeAudioStream({ index: 2 })],
    });
    const input = makeInput({ media, selection: { videoStreamIndex: 0, audioStreamIndex: 2, subtitleStreamIndex: null } });
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    const args = buildFfmpegArgs(input, planShape, { withSeek: false });

    expect(args).toContain("0:v:0");
    expect(args).toContain("0:a:0");
    expect(args).not.toContain("0:a:2");
  });

  it("TWO audio streams at absolute indexes 1 and 2, selecting the SECOND, maps to type-relative 0:a:1", () => {
    const media = makeMedia({
      video: [makeVideoStream({ index: 0 })],
      audio: [makeAudioStream({ index: 1, language: "eng" }), makeAudioStream({ index: 2, language: "spa" })],
    });
    const input = makeInput({
      media,
      selection: { videoStreamIndex: 0, audioStreamIndex: 2, subtitleStreamIndex: null },
    });
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    const args = buildFfmpegArgs(input, planShape, { withSeek: false });

    expect(args).toContain("0:a:1");
    expect(args).not.toContain("0:a:2");
  });

  it("subtitle embed map is ALSO type-relative (three subtitle streams, selecting the third)", () => {
    const media = makeMedia({
      subtitle: [
        makeSubtitleStream({ index: 3, codec: "webvtt" }),
        makeSubtitleStream({ index: 5, codec: "webvtt" }),
        makeSubtitleStream({ index: 7, codec: "webvtt" }),
      ],
    });
    const input = makeInput({
      media,
      selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 7 },
    });
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "embed", streamIndex: 7 },
    };
    const args = buildFfmpegArgs(input, planShape, { withSeek: false });

    expect(args).toContain("0:s:2");
    expect(args).not.toContain("0:s:7");
  });
});

describe("buildFfmpegArgs: token closure (every '{' arg matches the closed five-name §6 set)", () => {
  function assertTokenClosure(args: string[]): void {
    for (const arg of args) {
      if (!arg.includes("{")) continue;
      const matched = CLOSED_TOKENS.some((token) => arg.includes(token));
      expect(matched, `arg "${arg}" contains '{' but no closed §6 token`).toBe(true);
    }
  }

  it("direct-stream fmp4-hls args", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    assertTokenClosure(buildFfmpegArgs(makeInput(), planShape, { withSeek: false }));
  });

  it("direct-stream ts-hls args", () => {
    const planShape: FfmpegPlanShape = {
      container: "ts-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    assertTokenClosure(buildFfmpegArgs(makeInput(), planShape, { withSeek: false }));
  });

  it("remux args", () => {
    const planShape: FfmpegPlanShape = {
      container: "mp4",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    assertTokenClosure(buildFfmpegArgs(makeInput(), planShape, { withSeek: false }));
  });

  it("transcode args, withSeek true (exercises {SEEK_SECONDS} + {START_SEG} + {SEG_DUR} + {INPUT} + {SESSION_DIR} all at once)", () => {
    const device = makeDevice([
      { codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ]);
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    assertTokenClosure(buildFfmpegArgs(makeInput({ device }), planShape, { withSeek: true }));
  });

  it("every emitted token is one of the exact five names, standalone or embedded — no sixth token ever invented", () => {
    const device = makeDevice([
      { codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ]);
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    const args = buildFfmpegArgs(makeInput({ device }), planShape, { withSeek: true });
    const braceArgs = args.filter((a) => a.includes("{"));
    expect(braceArgs.length).toBeGreaterThan(0);
    for (const arg of braceArgs) {
      const tokensFound = CLOSED_TOKENS.filter((token) => arg.includes(token));
      expect(tokensFound.length, `arg "${arg}" matched tokens: ${JSON.stringify(tokensFound)}`).toBeGreaterThan(0);
    }
  });
});

describe("buildFfmpegArgs: -noaccurate_seek on mixed copy/transcode seek-restarts (V8 live-QA fix, 2026-08-20)", () => {
  // ffmpeg's accurate input seek trims DECODED (transcoded) streams at the
  // exact -ss target while a COPIED stream can only start at the preceding
  // keyframe — so a mixed copy/transcode restart opens with a leading hole
  // in whichever track was trimmed (up to a full GOP), which stalls MSE
  // playback at the hard-seek landing and skews A/V by the hole's width
  // (ffmpeg-verified 2026-08-20: audio pts 0.638 vs video pts 0.083 on a
  // video-copy + audio-opus 6177.232s seek). `-noaccurate_seek` makes every
  // stream start together at the demuxer's keyframe snap point (within
  // ≤1 audio frame), inside the §9.1.5 rule 7 ≤1-GOP PDT bound.

  const H264_DEVICE = makeDevice([
    { codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
  ]);

  function expectFlagImmediatelyBeforeSs(args: string[]): void {
    const at = args.indexOf("-noaccurate_seek");
    expect(at, "flag present").toBeGreaterThan(-1);
    expect(args[at + 1], "immediately before -ss").toBe("-ss");
    expect(args[at + 2]).toBe("{SEEK_SECONDS}");
  }

  it("video COPY + audio TRANSCODE, withSeek: flag present immediately before -ss (the QA shape — golden 43)", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "transcode", targetCodec: "opus", targetBitrateBps: 120000, targetChannels: 2 },
      subtitle: { strategy: "none" },
    };
    expectFlagImmediatelyBeforeSs(buildFfmpegArgs(makeInput(), planShape, { withSeek: true }));
  });

  it("video TRANSCODE + audio COPY, withSeek: flag present (the mirror hole — copied audio starts at the keyframe while trimmed video starts at the target)", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    expectFlagImmediatelyBeforeSs(buildFfmpegArgs(makeInput({ device: H264_DEVICE }), planShape, { withSeek: true }));
  });

  it("BOTH transcode, withSeek: flag ABSENT — accurate trim aligns both tracks at the exact target (and keeps the run's PDT origin exact)", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "transcode", targetCodec: "opus", targetBitrateBps: 120000, targetChannels: 2 },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    const args = buildFfmpegArgs(makeInput({ device: H264_DEVICE }), planShape, { withSeek: true });
    expect(args).not.toContain("-noaccurate_seek");
  });

  it("withSeek false: flag never emitted, copies or not (a fresh run has no -ss to modify)", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "transcode", targetCodec: "opus", targetBitrateBps: 120000, targetChannels: 2 },
      subtitle: { strategy: "none" },
    };
    const args = buildFfmpegArgs(makeInput(), planShape, { withSeek: false });
    expect(args).not.toContain("-noaccurate_seek");
    expect(args).not.toContain("-ss");
  });
});

describe("buildFfmpegArgs: canonical segment ORDER (docs/PLAYBACK.md §6, literal 1-9)", () => {
  it("global flags always come first, in the exact order", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    const args = buildFfmpegArgs(makeInput(), planShape, { withSeek: false });
    expect(args.slice(0, 4)).toEqual(["-hide_banner", "-loglevel", "warning", "-nostdin"]);
  });

  it("decode accel (segment 2) precedes -ss (segment 3), which precedes -i (segment 4)", () => {
    const device = makeDevice([
      { codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ]);
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "nvenc" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    const args = buildFfmpegArgs(makeInput({ device }), planShape, { withSeek: true });

    const hwaccelIdx = args.indexOf("-hwaccel");
    const seekIdx = args.indexOf("-ss");
    const inputIdx = args.indexOf("-i");
    expect(hwaccelIdx).toBeGreaterThanOrEqual(0);
    expect(seekIdx).toBeGreaterThan(hwaccelIdx);
    expect(inputIdx).toBeGreaterThan(seekIdx);
    expect(args[seekIdx + 1]).toBe("{SEEK_SECONDS}");
  });

  it("no -hwaccel at all when video isn't transcoding (segment 2 fully absent)", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    const args = buildFfmpegArgs(makeInput(), planShape, { withSeek: false });
    expect(args).not.toContain("-hwaccel");
  });

  it("no -hwaccel for a software backend even while transcoding (table has no entry for it)", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    const args = buildFfmpegArgs(makeInput(), planShape, { withSeek: false });
    expect(args).not.toContain("-hwaccel");
  });

  it("mapping (segment 5) precedes -filter_complex (segment 6) precedes the video encode flags (segment 7)", () => {
    const media = makeMedia({ video: [makeVideoStream({ interlaced: true, height: 2160 })] });
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264, // heightPx 1080 < source 2160 -> scale also fires
    };
    const args = buildFfmpegArgs(makeInput({ media }), planShape, { withSeek: false });

    const mapAudioIdx = args.indexOf("0:a:0") - 1; // the preceding "-map"
    const filterComplexIdx = args.indexOf("-filter_complex");
    const cvIdx = args.indexOf("-c:v");
    expect(args[mapAudioIdx]).toBe("-map");
    expect(filterComplexIdx).toBeGreaterThan(mapAudioIdx);
    expect(cvIdx).toBeGreaterThan(filterComplexIdx);
    // filter chain order EXACT: deinterlace -> scale -> tonemap (none here) -> overlay (none here).
    const filterArg = args[filterComplexIdx + 1]!;
    expect(filterArg.indexOf("yadif")).toBeLessThan(filterArg.indexOf("scale=-2:1080"));
  });

  it("audio block (segment 8) precedes output (segment 9)", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    const args = buildFfmpegArgs(makeInput(), planShape, { withSeek: false });
    const caIdx = args.indexOf("-c:a");
    const outputIdx = args.indexOf("-f");
    expect(caIdx).toBeGreaterThanOrEqual(0);
    expect(outputIdx).toBeGreaterThan(caIdx);
  });

  it("embed subtitle's -c:s copy sits at the END of the audio block, before -f (this step's placement BIND)", () => {
    const media = makeMedia({ subtitle: [makeSubtitleStream({ index: 2, codec: "webvtt" })] });
    const input = makeInput({ media, selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 } });
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "embed", streamIndex: 2 },
    };
    const args = buildFfmpegArgs(input, planShape, { withSeek: false });

    const csIdx = args.indexOf("-c:s");
    const caIdx = args.indexOf("-c:a");
    const outputIdx = args.indexOf("-f");
    expect(caIdx).toBeGreaterThanOrEqual(0);
    expect(csIdx).toBeGreaterThan(caIdx);
    expect(outputIdx).toBeGreaterThan(csIdx);
  });

  it("output block (segment 9) is always the final segment", () => {
    const planShape: FfmpegPlanShape = {
      container: "ts-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    const args = buildFfmpegArgs(makeInput(), planShape, { withSeek: false });
    expect(args[args.length - 1]).toBe("{SESSION_DIR}/media.m3u8");
  });

  it("remux's output block is always the final segment too", () => {
    const planShape: FfmpegPlanShape = {
      container: "mp4",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    const args = buildFfmpegArgs(makeInput(), planShape, { withSeek: false });
    expect(args.slice(-3)).toEqual(["-f", "mp4", "{SESSION_DIR}/download.mp4"]);
  });
});

describe("buildFfmpegArgs: vaapi burn-in hwdownload/hwupload wrap (step 7b fix F4 — §8.3's one-device exception)", () => {
  function burnInShape(encoder: "vaapi" | "nvenc" | "software", withToneMap = false): FfmpegPlanShape {
    return {
      container: "fmp4-hls",
      video: withToneMap
        ? { action: "transcode", targetCodec: "h264", encoder, toneMap: "vulkan" }
        : { action: "transcode", targetCodec: "h264", encoder },
      audio: { action: "copy" },
      subtitle: { strategy: "burn-in", streamIndex: 2 },
      rung: RUNG_1080P_H264,
    };
  }

  function pgsInput(videoOverrides: Partial<VideoStream> = {}): PlanInput {
    const media = makeMedia({
      video: [makeVideoStream(videoOverrides)],
      subtitle: [makeSubtitleStream({ index: 2, codec: "pgs" })],
    });
    return makeInput({ media, selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 } });
  }

  it("vaapi + embedded burn-in, no linear filters: [0:v:0]hwdownload,format=nv12[vfilt];[vfilt][0:s:0]overlay,hwupload[vout]", () => {
    const args = buildFfmpegArgs(pgsInput(), burnInShape("vaapi"), { withSeek: false });
    const filterArg = args[args.indexOf("-filter_complex") + 1]!;
    expect(filterArg).toBe("[0:v:0]hwdownload,format=nv12[vfilt];[vfilt][0:s:0]overlay,hwupload[vout]");
  });

  it("vaapi + burn-in + FULL linear chain: every linear filter runs INSIDE the download window, fixed order preserved, exactly ONE hwdownload and ONE hwupload", () => {
    const args = buildFfmpegArgs(
      pgsInput({ interlaced: true, height: 2160, width: 3840 }),
      burnInShape("vaapi", true),
      { withSeek: false },
    );
    const filterArg = args[args.indexOf("-filter_complex") + 1]!;
    // The burn-in overlay is a software-only filter, so this is
    // interpretation D's route (b): everything inside the download window
    // is system-memory, which is precisely why the tonemap position holds
    // the cpu-zscale chain and not `libplacebo` (a hw filter that cannot
    // consume the downloaded frames).
    expect(filterArg).toBe(
      "[0:v:0]hwdownload,format=nv12,yadif,scale=-2:1080,zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p[vfilt];[vfilt][0:s:0]overlay,hwupload[vout]",
    );
    expect(filterArg.split("hwdownload").length - 1).toBe(1);
    expect(filterArg.split("hwupload").length - 1).toBe(1);
  });

  it("NON-vaapi burn-in is completely unchanged — no hwdownload/hwupload anywhere (nvenc and software)", () => {
    for (const encoder of ["nvenc", "software"] as const) {
      const args = buildFfmpegArgs(pgsInput(), burnInShape(encoder), { withSeek: false });
      const filterArg = args[args.indexOf("-filter_complex") + 1]!;
      expect(filterArg, encoder).toBe("[0:v:0][0:s:0]overlay[vout]");
    }
  });

  it("vaapi WITHOUT burn-in is completely unchanged — no hwdownload/hwupload for a plain vaapi transcode filtergraph", () => {
    const media = makeMedia({ video: [makeVideoStream({ interlaced: true })] });
    const input = makeInput({ media });
    const shape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "vaapi" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    const args = buildFfmpegArgs(input, shape, { withSeek: false });
    const filterArg = args[args.indexOf("-filter_complex") + 1]!;
    expect(filterArg).toBe("[0:v:0]yadif[vout]");
  });
});

describe("buildFfmpegArgs: hardware tone-map routes (interpretation D, backend-agnostic — every §8.3 backend, not just videotoolbox)", () => {
  function toneMapShape(
    encoder: "videotoolbox" | "nvenc" | "qsv" | "vaapi" | "software",
    toneMap: "videotoolbox" | "cuda" | "opencl" | "vulkan" | "cpu-zscale",
  ): FfmpegPlanShape {
    return {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder, toneMap },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
  }

  function hdrInput(videoOverrides: Partial<VideoStream> = {}): PlanInput {
    return makeInput({
      media: makeMedia({ video: [makeVideoStream({ hdr: "hdr10", bitDepth: 10, ...videoOverrides })] }),
    });
  }

  function outputFormatOf(args: string[]): string | undefined {
    const idx = args.indexOf("-hwaccel_output_format");
    return idx === -1 ? undefined : args[idx + 1];
  }

  // The pure-hw route pins the decode surface for EVERY backend §8.3 names
  // a hw tone-map method for — `-hwaccel <name>` alone is only a HINT
  // (apps/worker/src/hwcaps/tables.ts's real-hardware finding 2), and
  // tonemap_cuda/tonemap_opencl/libplacebo/scale_vt all need frames that
  // actually stayed on the device.
  it.each([
    ["nvenc", "cuda", "cuda"],
    ["qsv", "opencl", "qsv"],
    ["vaapi", "vulkan", "vaapi"],
    ["videotoolbox", "videotoolbox", "videotoolbox_vld"],
  ] as const)("%s + %s tone-map pins the surface: -hwaccel_output_format %s immediately after -hwaccel", (encoder, method, expectedFormat) => {
    const args = buildFfmpegArgs(hdrInput(), toneMapShape(encoder, method), { withSeek: false });
    const hwaccelIdx = args.indexOf("-hwaccel");
    expect(hwaccelIdx).toBeGreaterThanOrEqual(0);
    expect(args[hwaccelIdx + 2]).toBe("-hwaccel_output_format");
    expect(args[hwaccelIdx + 3]).toBe(expectedFormat);
  });

  // Once the surface is pinned, the SOFTWARE `scale` filter can no longer
  // touch the frames — each backend's own hw scaler takes the §6 scale
  // position (videotoolbox instead folds the downscale INTO scale_vt).
  it.each([
    ["nvenc", "cuda", "scale_cuda=w=-2:h=1080,tonemap_cuda=format=yuv420p:tonemap=hable"],
    ["qsv", "opencl", "scale_qsv=w=-2:h=1080,tonemap_opencl=format=yuv420p:tonemap=hable"],
    ["vaapi", "vulkan", "scale_vaapi=w=-2:h=1080,libplacebo=tonemapping=hable:format=yuv420p"],
  ] as const)("%s + %s tone-map with a rung downscale uses the backend's OWN hw scaler, never software scale=", (encoder, method, expectedChain) => {
    const args = buildFfmpegArgs(
      hdrInput({ height: 2160, width: 3840 }),
      toneMapShape(encoder, method),
      { withSeek: false },
    );
    const filterArg = args[args.indexOf("-filter_complex") + 1]!;
    expect(filterArg).toBe(`[0:v:0]${expectedChain}[vout]`);
    expect(filterArg).not.toContain("scale=-2:");
  });

  // Route (b), generalized: a software-only filter in the same graph means
  // the frames must NOT be pinned (yadif/overlay cannot consume them), so
  // the whole chain drops to software with cpu-zscale in the tonemap
  // position — the hw encoder still encodes.
  const CPU_ZSCALE =
    "zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p";

  it.each([
    ["nvenc", "cuda"],
    ["qsv", "opencl"],
    ["vaapi", "vulkan"],
  ] as const)("%s + %s tone-map + deinterlace is the HYBRID route: no -hwaccel_output_format, cpu-zscale substitutes for the hw filter", (encoder, method) => {
    const args = buildFfmpegArgs(
      hdrInput({ interlaced: true, height: 2160, width: 3840 }),
      toneMapShape(encoder, method),
      { withSeek: false },
    );
    expect(args).toContain("-hwaccel");
    expect(outputFormatOf(args)).toBeUndefined();
    const filterArg = args[args.indexOf("-filter_complex") + 1]!;
    expect(filterArg).toBe(`[0:v:0]yadif,scale=-2:1080,${CPU_ZSCALE}[vout]`);
  });

  it("software backend with cpu-zscale never pins a surface (no -hwaccel, no -hwaccel_output_format)", () => {
    const args = buildFfmpegArgs(hdrInput(), toneMapShape("software", "cpu-zscale"), { withSeek: false });
    expect(args).not.toContain("-hwaccel");
    expect(outputFormatOf(args)).toBeUndefined();
  });

  it("an INCOHERENT backend/method pair (§8.3 never pairs them) falls through unpinned rather than forcing a format its filter can't consume", () => {
    const args = buildFfmpegArgs(hdrInput(), toneMapShape("nvenc", "opencl"), { withSeek: false });
    expect(args).toContain("-hwaccel");
    expect(outputFormatOf(args)).toBeUndefined();
  });

  it("a hw backend transcoding WITHOUT any tone-map is untouched — decode-accel hint only, no surface pin", () => {
    const shape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "nvenc" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    const args = buildFfmpegArgs(makeInput(), shape, { withSeek: false });
    expect(args).toContain("-hwaccel");
    expect(outputFormatOf(args)).toBeUndefined();
  });
});

describe("buildFfmpegArgs: determinism (docs/PLAYBACK.md §0 law 1 — identical inputs, byte-identical output)", () => {
  it("double-run on structurally cloned inputs produces a JSON-identical args array", () => {
    const device = makeDevice([
      { codec: "hevc", maxProfile: "main10", maxLevel: 153, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ]);
    const media = makeMedia({ video: [makeVideoStream({ interlaced: true, codec: "hevc", height: 2160 })] });
    const input = makeInput({ media, device });
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "hevc", encoder: "software", toneMap: "cpu-zscale" },
      audio: { action: "transcode", targetCodec: "opus", targetChannels: 2, targetBitrateBps: 120_000 },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };

    const first = buildFfmpegArgs(structuredClone(input), structuredClone(planShape), { withSeek: true });
    const second = buildFfmpegArgs(structuredClone(input), structuredClone(planShape), { withSeek: true });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(every(first, (a) => typeof a === "string")).toBe(true);
  });
});

function every<T>(arr: T[], pred: (t: T) => boolean): boolean {
  return arr.every(pred);
}

describe("buildFfmpegArgs: defensive/contract errors (never reachable through plan() — lower-level utility, not held to plan()'s TOTAL law)", () => {
  it("throws when called for a direct-play plan (container 'source')", () => {
    const planShape: FfmpegPlanShape = {
      container: "source",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    expect(() => buildFfmpegArgs(makeInput(), planShape, { withSeek: false })).toThrow(/direct-play/);
  });

  it("throws when video.action==='transcode' without a rung", () => {
    const planShape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    };
    expect(() => buildFfmpegArgs(makeInput(), planShape, { withSeek: false })).toThrow(/rung/);
  });
});

// ---------------------------------------------------------------------------
// Wave C1 — §6 INTERPRETATION M (AV1 encode targets, LD-7). The encoder-name
// table gains its `av1` column; the C8 probe/ladder-inconsistency comment
// retires with it. Everything else in the encode block is codec-agnostic and
// must stay byte-identical (goldens 39-41 snapshot the full argv; these are
// the focused per-rule pins).
// ---------------------------------------------------------------------------

const RUNG_1080P_AV1: LadderRung = {
  heightPx: 1080,
  videoBitrateBps: 2_400_000,
  audioBitrateBps: 160_000,
  codec: "av1",
};

const AV1_DEVICE_ENTRY: DeviceProfile["video"][number] = {
  codec: "av1",
  maxProfile: null,
  // NON-NULL deliberately: `-level` must be suppressed for av1 even when the
  // device declares one, since AV1 seq_level_idx ordinals do not correspond
  // to the H.264/HEVC decimal levels this field carries.
  maxLevel: 40,
  maxBitDepth: 10,
  maxWidth: 3840,
  maxHeight: 2160,
  maxFrameRate: 60,
  maxBitrateBps: null,
};

function av1Shape(encoder: FfmpegPlanShape["video"]["encoder"], container: FfmpegPlanShape["container"] = "fmp4-hls"): FfmpegPlanShape {
  return {
    container,
    video: { action: "transcode", targetCodec: "av1", encoder },
    audio: { action: "copy" },
    subtitle: { strategy: "none" },
    rung: RUNG_1080P_AV1,
  };
}

function av1Args(encoder: FfmpegPlanShape["video"]["encoder"]): string[] {
  return buildFfmpegArgs(makeInput({ device: makeDevice([AV1_DEVICE_ENTRY]) }), av1Shape(encoder), { withSeek: false });
}

describe("buildFfmpegArgs: interpretation M — the av1 encoder-name column", () => {
  it("maps each backend to its ONE fixed av1 encoder name", () => {
    const expected: Record<string, string> = {
      software: "libsvtav1",
      nvenc: "av1_nvenc",
      qsv: "av1_qsv",
      vaapi: "av1_vaapi",
      amf: "av1_amf",
    };
    for (const [backend, encoderName] of Object.entries(expected)) {
      const args = av1Args(backend as FfmpegPlanShape["video"]["encoder"]);
      expect(args[args.indexOf("-c:v") + 1], backend).toBe(encoderName);
    }
  });

  it("videotoolbox has NO av1 entry — no av1_videotoolbox encoder exists, so the shape is inconsistent and throws descriptively", () => {
    expect(() => av1Args("videotoolbox")).toThrow(/av1/);
    expect(() => av1Args("videotoolbox")).toThrow(/videotoolbox/);
  });

  it("h264/hevc encoder names are untouched by the new column", () => {
    const shape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "hevc", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "hevc" },
    };
    const args = buildFfmpegArgs(makeInput(), shape, { withSeek: false });
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx265");
  });
});

describe("buildFfmpegArgs: interpretation M — per-codec flag differences", () => {
  it("software av1 takes the NUMERIC SVT-AV1 preset 10, never libx264's 'veryfast' (not a legal SVT-AV1 value)", () => {
    const args = av1Args("software");
    expect(args[args.indexOf("-preset") + 1]).toBe("10");
    expect(args).not.toContain("veryfast");
  });

  it("software h264/hevc keep -preset veryfast — the per-encoder split cuts only av1", () => {
    const shape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    const args = buildFfmpegArgs(makeInput(), shape, { withSeek: false });
    expect(args[args.indexOf("-preset") + 1]).toBe("veryfast");
  });

  it("nvenc's -preset p4 is codec-agnostic and unchanged for av1", () => {
    const args = av1Args("nvenc");
    expect(args[args.indexOf("-preset") + 1]).toBe("p4");
  });

  it("qsv/vaapi/amf emit NO -preset for av1, exactly as they emit none for h264/hevc", () => {
    for (const backend of ["qsv", "vaapi", "amf"] as const) {
      expect(av1Args(backend), backend).not.toContain("-preset");
    }
  });

  it("-level is NEVER emitted for an av1 target, even against a device declaring maxLevel 40", () => {
    for (const backend of ["software", "nvenc", "qsv", "vaapi", "amf"] as const) {
      expect(av1Args(backend), backend).not.toContain("-level");
    }
  });

  it("CONTROL: the same non-null device maxLevel DOES produce -level for an h264 target", () => {
    const device = makeDevice([{ ...AV1_DEVICE_ENTRY, codec: "h264", maxLevel: 40 }]);
    const shape: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    const args = buildFfmpegArgs(makeInput({ device }), shape, { withSeek: false });
    expect(args[args.indexOf("-level") + 1]).toBe("40");
  });

  it("-tag:v stays hevc-only — an fmp4 AV1 track's av01 sample entry is correct by default", () => {
    for (const backend of ["software", "nvenc", "qsv", "vaapi", "amf"] as const) {
      expect(av1Args(backend), backend).not.toContain("-tag:v");
    }
  });

  it("bitrate and GOP flags keep their shape and values for a HARDWARE av1 target", () => {
    const args = av1Args("nvenc");
    expect(args[args.indexOf("-b:v") + 1]).toBe("2400000");
    expect(args[args.indexOf("-maxrate") + 1]).toBe("2400000");
    expect(args[args.indexOf("-bufsize") + 1]).toBe("4800000");
    expect(args[args.indexOf("-g") + 1]).toBe("48"); // round(23.976 * 2)
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe("expr:gte(t,n_forced*{SEG_DUR})");
  });

  // REAL-EXECUTION CORRECTION (2026-08-11, SVT-AV1 v4.1.0) — see the
  // emission site in src/args/builder.ts. ffmpeg's libsvtav1 wrapper reads
  // bitrate == maxrate as CBR, SVT-AV1 refuses CBR for RANDOM_ACCESS, the
  // encoder never opens, and NOTHING is written. Isolated by running all
  // three variants: `-b:v` alone and `-b:v` + `-bufsize` both succeed;
  // adding `-maxrate` is what fails.
  it("SOFTWARE av1 omits -maxrate — libsvtav1 refuses it, and the whole encode fails when it is present", () => {
    const args = av1Args("software");
    expect(args).not.toContain("-maxrate");
    expect(args[args.indexOf("-b:v") + 1]).toBe("2400000");
    expect(args[args.indexOf("-bufsize") + 1]).toBe("4800000");
  });

  it("the omission is scoped to libsvtav1 alone — every hw av1 backend keeps -maxrate, as do software h264/hevc", () => {
    for (const backend of ["nvenc", "qsv", "vaapi", "amf"] as const) {
      expect(av1Args(backend), backend).toContain("-maxrate");
    }
    const softwareH264: FfmpegPlanShape = {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    expect(buildFfmpegArgs(makeInput(), softwareH264, { withSeek: false })).toContain("-maxrate");
  });
});

describe("buildFfmpegArgs: interpretation M — av1 can never ride MPEG-TS", () => {
  it("an av1 target paired with ts-hls is an internally-inconsistent planShape -> descriptive throw", () => {
    const input = makeInput({ device: makeDevice([AV1_DEVICE_ENTRY]) });
    expect(() => buildFfmpegArgs(input, av1Shape("software", "ts-hls"), { withSeek: false })).toThrow(/av1/);
    expect(() => buildFfmpegArgs(input, av1Shape("software", "ts-hls"), { withSeek: false })).toThrow(/ts-hls/);
  });

  it("the SAME shape on fmp4-hls builds cleanly — only the container is inconsistent", () => {
    const input = makeInput({ device: makeDevice([AV1_DEVICE_ENTRY]) });
    expect(() => buildFfmpegArgs(input, av1Shape("software", "fmp4-hls"), { withSeek: false })).not.toThrow();
  });

  it("h264/hevc targets on ts-hls are completely unaffected", () => {
    const shape: FfmpegPlanShape = {
      container: "ts-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    };
    expect(() => buildFfmpegArgs(makeInput(), shape, { withSeek: false })).not.toThrow();
  });
});
