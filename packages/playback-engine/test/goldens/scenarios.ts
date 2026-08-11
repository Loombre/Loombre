// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The 34 canonical golden scenarios for src/args/builder.ts (docs/PLAYBACK.md
 * §6, Phase 3 §11 step 4's 25 + step 7b fix F4's two vaapi burn-in
 * scenarios, 26/27, + the step-7 owner-smoke VT tone-map real-execution
 * fix's hybrid-deinterlace scenario, 28, + the four scenarios that landed
 * with interpretation D's generalization to every §8.3 hw backend, 29-32, +
 * the open-GOP HEVC seek-restart strip pair (interpretation K, 2026-08-10),
 * 33/34). Inputs are constructed HERE, in
 * test code — never read
 * from disk — per the step-4 mandate ("inputs constructed in test code,
 * snapshots as .json arrays checked in"). `goldens.spec.ts` (sibling) loads
 * each scenario, calls `buildFfmpegArgs`, and asserts deep equality against
 * its checked-in `test/goldens/<id>.json` snapshot.
 *
 * Coverage (this step's instruction 9's explicit list): direct-stream copy
 * fmp4 + ts; remux; software h264 + hevc transcodes; videotoolbox/nvenc/qsv/
 * vaapi hw encodes; cpu-zscale + cuda + opencl + vulkan + videotoolbox
 * tone-maps; deinterlace; scale-down rung; deinterlace+scale+tonemap
 * combined order proof; embedded PGS burn-in; external SRT burn-in (second
 * -i + overlay); embed text sub map; audio-only transcode (opus + aac);
 * downmix -ac; resample >48k; seek variant; GOP high-fps rounding (folded
 * into scenario 04 — a 59.94fps source proves 59.94*2=119.88 -> round 120
 * without needing its own dedicated 26th scenario); hevc hvc1 tag (folded
 * into scenario 05); level cap emission (folded into scenario 08). Step 7b
 * fix F4 adds the two vaapi burn-in scenarios (§8.3's hwdownload → overlay
 * → hwupload one-device exception): 26 embedded PGS, 27 external SRT. The
 * step-7 owner-smoke VT real-execution fix (builder.ts interpretation D)
 * changes scenario 14 (route (a) gains -hwaccel_output_format
 * videotoolbox_vld) and adds 28 (route (b), the hybrid fallback: VT
 * tone-map + deinterlace drops the whole graph to software with the
 * cpu-zscale chain in the tonemap position, VT still encoding). Generalizing
 * interpretation D to every §8.3 hw backend changes 11/12/13 (each gains its
 * own -hwaccel_output_format) and adds 29-31 (route (a) with a rung
 * downscale on cuda/qsv/vaapi — the backend's own hw scaler, never software
 * `scale`) plus 32 (route (b) on a non-VT backend). Interpretation K
 * (2026-08-10, ffmpeg-verified) adds 33 (video-COPY, hevc openGop:true,
 * withSeek:true -> the `-bsf:v filter_units=remove_types=8-9` strip is
 * present) and its sibling 34 (same shape, withSeek:false -> the bsf is
 * ABSENT — a fresh run starts at the file's true IDR) — 34 files total
 * (golden discipline: each graph change landed with its goldens in the same
 * PR).
 */
import type {
  AudioStream,
  DeviceProfile,
  LadderRung,
  MediaInfo,
  PlanInput,
  SubtitleStream,
  VideoStream,
} from "../../src/types.js";
import type { BuildFfmpegArgsOptions, FfmpegPlanShape } from "../../src/args/builder.js";

export interface GoldenScenario {
  /** Matches the checked-in snapshot's file stem, test/goldens/<id>.json. */
  id: string;
  /** Human-readable header — also the checked-in snapshot's own `scenario`
   *  field (this step's instruction 9: "a HEADER comment in each snapshot's
   *  scenario name field"; JSON has no comment syntax, so this field IS the
   *  header). */
  scenario: string;
  input: PlanInput;
  planShape: FfmpegPlanShape;
  options: BuildFfmpegArgsOptions;
}

function videoStream(overrides: Partial<VideoStream> = {}): VideoStream {
  return {
    index: 0,
    codec: "h264",
    profile: "high",
    level: 41,
    width: 1920,
    height: 1080,
    bitDepth: 8,
    frameRate: 24,
    bitrateBps: 5_000_000,
    hdr: "none",
    dvProfile: null,
    dvBlCompatId: null,
    interlaced: false,
    openGop: false,
    ...overrides,
  };
}

function audioStream(overrides: Partial<AudioStream> = {}): AudioStream {
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

function subtitleStream(overrides: Partial<SubtitleStream> = {}): SubtitleStream {
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

function media(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    fileId: "golden-file",
    container: "mkv",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: 5_160_000,
    video: [videoStream()],
    audio: [audioStream()],
    subtitle: [],
    ...overrides,
  };
}

function device(videoEntries: DeviceProfile["video"] = [], overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    profileId: "golden-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: videoEntries,
    hdr: { hdr10: true, hlg: true, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 6, passthrough: false }],
    subtitles: { renderText: ["subrip", "webvtt"], hlsVtt: true, renderImage: true },
    maxStreamBitrateBps: null,
    ...overrides,
  };
}

function input(overrides: {
  media: MediaInfo;
  device: DeviceProfile;
  selection: PlanInput["selection"];
}): PlanInput {
  return {
    media: overrides.media,
    device: overrides.device,
    network: { maxBitrateBps: 100_000_000, isLocal: true },
    policy: {
      allowTranscode: true,
      allowToneMapCpu: "always",
      tier: 1,
      preferredTextSubMode: "hls-vtt",
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"],
      maxSimultaneousTranscodes: 1,
      ladderRungs: [],
      segmentDurationSec: 6,
      hevcEncodePreferred: false,
    },
    caps: { backends: [{ backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1_750_000_000_000 }] },
    selection: overrides.selection,
    mode: "stream",
  };
}

const SEL_V0_A1 = { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null };
const SEL_V0_A1_S2 = { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 };

const RUNG_1080P_H264: LadderRung = { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" };
const RUNG_2160P_HEVC: LadderRung = { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" };
const RUNG_720P_H264: LadderRung = { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" };

const H264_DEVICE_ENTRY = { codec: "h264" as const, maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null };
const HEVC_DEVICE_ENTRY = { codec: "hevc" as const, maxProfile: "main10", maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null };

export const GOLDEN_SCENARIOS: GoldenScenario[] = [
  {
    id: "01-direct-stream-copy-fmp4",
    scenario: "direct-stream, all streams copy, fmp4 HLS segment type (device.hls.supportsFmp4 true)",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: { container: "fmp4-hls", video: { action: "copy" }, audio: { action: "copy" }, subtitle: { strategy: "none" } },
    options: { withSeek: false },
  },
  {
    id: "02-direct-stream-copy-ts",
    scenario: "direct-stream, all streams copy, mpegts HLS segment type (device.hls.supportsFmp4 false)",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: { container: "ts-hls", video: { action: "copy" }, audio: { action: "copy" }, subtitle: { strategy: "none" } },
    options: { withSeek: false },
  },
  {
    id: "03-remux-progressive-mp4",
    scenario: "remux (download mode, container-only change) — progressive mp4 output, no HLS muxer",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: { container: "mp4", video: { action: "copy" }, audio: { action: "copy" }, subtitle: { strategy: "none" } },
    options: { withSeek: false },
  },
  {
    id: "04-software-h264-transcode-gop-highfps",
    scenario: "software libx264 transcode, no filtergraph needed (rung matches source height) — 59.94fps source proves GOP rounding 2x59.94=119.88 -> round 120",
    input: input({
      media: media({ video: [videoStream({ frameRate: 59.94 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "05-software-hevc-transcode-hvc1-tag",
    scenario: "software libx265 transcode at 2160p (rung matches source height, no scale) — hevc target always adds -tag:v hvc1",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", height: 2160, width: 3840, frameRate: 23.976 })] }),
      device: device([HEVC_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "hevc", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_2160P_HEVC,
    },
    options: { withSeek: false },
  },
  {
    id: "06-videotoolbox-hw-encode",
    scenario: "videotoolbox hardware encode, h264 target — -hwaccel videotoolbox, h264_videotoolbox encoder, no tone-map",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "videotoolbox" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "07-nvenc-hw-encode",
    scenario: "nvenc hardware encode, h264 target — -hwaccel cuda, h264_nvenc encoder, -preset p4",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "nvenc" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "08-qsv-hw-encode-level-cap",
    scenario: "qsv hardware encode, h264 target — -hwaccel qsv, h264_qsv encoder; device declares a non-null maxLevel -> -level emitted",
    input: input({
      media: media(),
      device: device([{ ...H264_DEVICE_ENTRY, maxLevel: 52 }]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "qsv" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "09-vaapi-hw-encode",
    scenario: "vaapi hardware encode, h264 target — -hwaccel vaapi, h264_vaapi encoder",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "vaapi" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "10-cpu-zscale-tonemap",
    scenario: "software route, cpu-zscale HDR10-to-SDR tone-map — 2160p hevc source/target (rung matches source height, isolates the tonemap filter alone), hvc1 tag",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", height: 2160, width: 3840, hdr: "hdr10", bitDepth: 10 })] }),
      device: device([HEVC_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "hevc", encoder: "software", toneMap: "cpu-zscale" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_2160P_HEVC,
    },
    options: { withSeek: false },
  },
  {
    id: "11-cuda-tonemap",
    scenario:
      "nvenc route, cuda tone-map — pure-hw route (a): -hwaccel_output_format cuda keeps decode on the cuda surface for tonemap_cuda (rung matches source height, isolates the tonemap filter alone)",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "nvenc", toneMap: "cuda" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "12-opencl-tonemap",
    scenario:
      "qsv route, opencl tone-map (§8.3's preferred half of qsv/vaapi -> opencl(else vulkan)) — pure-hw route (a): -hwaccel_output_format qsv pins the decode surface",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "qsv", toneMap: "opencl" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "13-vulkan-tonemap",
    scenario:
      "vaapi route, vulkan tone-map (§8.3's 'else vulkan' half) — pure-hw route (a): -hwaccel_output_format vaapi pins the decode surface",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "vaapi", toneMap: "vulkan" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "14-videotoolbox-tonemap",
    scenario:
      "videotoolbox route, videotoolbox tone-map — pure-hw route (a): -hwaccel_output_format videotoolbox_vld keeps decode on the VT surface, scale_vt tone-maps in hw (bare form — rung matches source height, no downscale to fold)",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "videotoolbox", toneMap: "videotoolbox" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "15-deinterlace-only",
    scenario: "software transcode, interlaced source, rung matches source height — filtergraph is 'yadif' alone",
    input: input({
      media: media({ video: [videoStream({ interlaced: true })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "ts-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "16-scale-down-rung",
    scenario: "software transcode, 2160p source down to a 720p rung, not interlaced, no tone-map — filtergraph is 'scale=-2:720' alone",
    input: input({
      media: media({ video: [videoStream({ height: 2160, width: 3840 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_720P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "17-deinterlace-scale-tonemap-order-proof",
    scenario: "software transcode, interlaced 2160p HDR source down to a 1080p rung with cpu-zscale — proves the FIXED filter order deinterlace -> scale -> tonemap",
    input: input({
      media: media({ video: [videoStream({ interlaced: true, height: 2160, width: 3840, hdr: "hdr10", bitDepth: 10 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software", toneMap: "cpu-zscale" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "18-embedded-pgs-burn-in",
    scenario: "embedded PGS (image) subtitle burn-in — no second input, overlay consumes [0:s:0]; forces video transcode",
    input: input({
      media: media({
        video: [videoStream()],
        subtitle: [subtitleStream({ index: 2, codec: "pgs" })],
      }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1_S2,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "burn-in", streamIndex: 2 },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "19-external-srt-burn-in",
    scenario: "external SRT sidecar burn-in — second -i {SUBTITLE_SIDECAR} input, overlay consumes [1:s:0]",
    input: input({
      media: media({
        video: [videoStream()],
        subtitle: [subtitleStream({ index: 2, codec: "subrip", isExternal: true, externalPath: "/sidecars/movie.srt" })],
      }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1_S2,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "burn-in", streamIndex: 2 },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "20-embed-text-sub-map",
    scenario: "embed strategy (mux-copy, e.g. webvtt) — -map 0:s:0 in the mapping segment, -c:s copy at the END of the audio block",
    input: input({
      media: media({
        video: [videoStream()],
        subtitle: [subtitleStream({ index: 2, codec: "webvtt" })],
      }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1_S2,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "copy" },
      subtitle: { strategy: "embed", streamIndex: 2 },
    },
    options: { withSeek: false },
  },
  {
    id: "21-audio-only-transcode-opus",
    scenario: "audio-only file (no video stream at all) transcoding to opus — no video segments (2/5-video/6/7) at all",
    input: input({
      media: media({ container: "flac", video: [], audio: [audioStream({ index: 0, codec: "flac", channels: 2, sampleRate: 44100 })], subtitle: [] }),
      device: device([]),
      selection: { videoStreamIndex: null, audioStreamIndex: 0, subtitleStreamIndex: null },
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "none" },
      audio: { action: "transcode", targetCodec: "opus", targetChannels: 2, targetBitrateBps: 120_000 },
      subtitle: { strategy: "none" },
    },
    options: { withSeek: false },
  },
  {
    id: "22-audio-only-transcode-aac",
    scenario: "audio-only file transcoding to aac, 6-channel band — no video segments at all",
    input: input({
      media: media({ container: "flac", video: [], audio: [audioStream({ index: 0, codec: "flac", channels: 6, sampleRate: 44100 })], subtitle: [] }),
      device: device([]),
      selection: { videoStreamIndex: null, audioStreamIndex: 0, subtitleStreamIndex: null },
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "none" },
      audio: { action: "transcode", targetCodec: "aac", targetChannels: 6, targetBitrateBps: 384_000 },
      subtitle: { strategy: "none" },
    },
    options: { withSeek: false },
  },
  {
    id: "23-downmix-ac",
    scenario: "video copy + audio downmix (6ch source -> 2ch target, -ac 2) — proves -ac reflects the DOWNMIXED target, not the source channel count",
    input: input({
      media: media({ audio: [audioStream({ codec: "ac3", channels: 6, sampleRate: 48000 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "transcode", targetCodec: "aac", targetChannels: 2, targetBitrateBps: 160_000 },
      subtitle: { strategy: "none" },
    },
    options: { withSeek: false },
  },
  {
    id: "24-resample-over-48k",
    scenario: "video copy + audio transcode from a >48kHz source (96000) — -ar 48000 appended after -ac",
    input: input({
      media: media({ audio: [audioStream({ codec: "flac", channels: 2, sampleRate: 96000 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "copy" },
      audio: { action: "transcode", targetCodec: "opus", targetChannels: 2, targetBitrateBps: 120_000 },
      subtitle: { strategy: "none" },
    },
    options: { withSeek: false },
  },
  {
    id: "25-seek-variant",
    scenario: "session-layer seek-restart regeneration (withSeek: true) — -ss {SEEK_SECONDS} before -i; -start_number {START_SEG} still present (BIND: always present regardless of withSeek)",
    input: input({ media: media(), device: device([H264_DEVICE_ENTRY]), selection: SEL_V0_A1 }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "software" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: true },
  },
  {
    id: "26-vaapi-embedded-pgs-burn-in",
    scenario:
      "vaapi embedded PGS burn-in (step 7b fix F4, §8.3 one-device exception) — [0:v:0]hwdownload,format=nv12[vfilt];[vfilt][0:s:0]overlay,hwupload[vout], exactly one download/upload round-trip",
    input: input({
      media: media({
        video: [videoStream()],
        subtitle: [subtitleStream({ index: 2, codec: "pgs" })],
      }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1_S2,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "vaapi" },
      audio: { action: "copy" },
      subtitle: { strategy: "burn-in", streamIndex: 2 },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "27-vaapi-external-srt-burn-in",
    scenario:
      "vaapi external SRT sidecar burn-in (step 7b fix F4) — second -i {SUBTITLE_SIDECAR}, [0:v:0]hwdownload,format=nv12[vfilt];[vfilt][1:s:0]overlay,hwupload[vout]",
    input: input({
      media: media({
        video: [videoStream()],
        subtitle: [subtitleStream({ index: 2, codec: "subrip", isExternal: true, externalPath: "/sidecars/movie.srt" })],
      }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1_S2,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "vaapi" },
      audio: { action: "copy" },
      subtitle: { strategy: "burn-in", streamIndex: 2 },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "28-videotoolbox-tonemap-hybrid-deinterlace",
    scenario:
      "videotoolbox tone-map hybrid fallback, route (b) — interlaced 2160p HDR10 source needs yadif (a software-only filter), so NO -hwaccel_output_format and NO scale_vt: plain -hwaccel videotoolbox auto-downloads frames once, the whole §6 chain runs in software with the cpu-zscale string in the tonemap position, VideoToolbox still encodes",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", interlaced: true, height: 2160, width: 3840, hdr: "hdr10", bitDepth: 10 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "videotoolbox", toneMap: "videotoolbox" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "29-cuda-tonemap-hw-downscale",
    scenario:
      "nvenc route (a) WITH a rung downscale — the pinned cuda surface forbids the software `scale` filter, so scale_cuda takes §6's scale position ahead of tonemap_cuda (nvenc's analogue of videotoolbox's scale_vt fold)",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", height: 2160, width: 3840, hdr: "hdr10", bitDepth: 10 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "nvenc", toneMap: "cuda" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "30-opencl-tonemap-hw-downscale",
    scenario: "qsv route (a) WITH a rung downscale — scale_qsv takes §6's scale position ahead of tonemap_opencl",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", height: 2160, width: 3840, hdr: "hdr10", bitDepth: 10 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "qsv", toneMap: "opencl" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "31-vulkan-tonemap-hw-downscale",
    scenario: "vaapi route (a) WITH a rung downscale — scale_vaapi takes §6's scale position ahead of libplacebo",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", height: 2160, width: 3840, hdr: "hdr10", bitDepth: 10 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "vaapi", toneMap: "vulkan" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "32-cuda-tonemap-hybrid-deinterlace",
    scenario:
      "nvenc tone-map hybrid fallback, route (b) — the non-VT counterpart of scenario 28: yadif (a software-only filter) means NO -hwaccel_output_format and NO tonemap_cuda/scale_cuda, so plain -hwaccel cuda auto-downloads frames once and the whole §6 chain runs in software with the cpu-zscale string in the tonemap position, nvenc still encoding",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", interlaced: true, height: 2160, width: 3840, hdr: "hdr10", bitDepth: 10 })] }),
      device: device([H264_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "h264", encoder: "nvenc", toneMap: "cuda" },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
      rung: RUNG_1080P_H264,
    },
    options: { withSeek: false },
  },
  {
    id: "33-seek-copy-opengop-strip",
    scenario:
      "session-layer seek-restart regeneration of a video-COPY plan carrying an open-GOP hevc stream (video.openGop true, withSeek:true) — interpretation K: -bsf:v filter_units=remove_types=8-9 strips the RASL leading pictures the seek-restart join can't reference",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", openGop: true })] }),
      device: device([HEVC_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "copy", openGop: true },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    },
    options: { withSeek: true },
  },
  {
    id: "34-seek-off-copy-opengop-no-strip",
    scenario:
      "sibling of scenario 33, same video-COPY openGop:true plan but NOT a seek-restart (withSeek:false, plan()'s own default-args call) — the -bsf:v strip is ABSENT: a fresh run starts at the file's true IDR, nothing to fix",
    input: input({
      media: media({ video: [videoStream({ codec: "hevc", openGop: true })] }),
      device: device([HEVC_DEVICE_ENTRY]),
      selection: SEL_V0_A1,
    }),
    planShape: {
      container: "fmp4-hls",
      video: { action: "copy", openGop: true },
      audio: { action: "copy" },
      subtitle: { strategy: "none" },
    },
    options: { withSeek: false },
  },
];
