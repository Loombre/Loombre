// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/device-profile.ts
//
// Builds the DeviceProfile sent as LoginRequest.deviceProfile (docs/PLAYBACK.md
// §2.2), by real MSE/canPlayType probing in the browser. The server
// Ajv-validates this shape strictly (apps/server/src/common/device-profile-
// validator.ts — 422 on anything that doesn't match, never "best-guessed"),
// so this module must produce every required field with the right types,
// and must be HONEST: only claim a capability the browser's own APIs
// actually confirmed, never an optimistic guess.
//
// Testability: all real browser globals (HTMLVideoElement.canPlayType,
// HTMLAudioElement.canPlayType, MediaSource.isTypeSupported, matchMedia,
// navigator.mediaCapabilities) are read through a `ProbeEnv` that can be
// fully mocked in unit tests (see device-profile.test.ts) — no jsdom media
// stack is required or trusted (jsdom's canPlayType always returns '' since
// it has no real codecs, so tests inject fakes instead of relying on it).

import type { components } from "@loombre/sdk";

export type DeviceProfile = components["schemas"]["DeviceProfile"];
type Container = components["schemas"]["Container"];

/** `HTMLMediaElement.canPlayType`'s return type, spelled out for the mocks. */
export type CanPlayTypeResult = "" | "maybe" | "probably";

export interface MediaCapabilitiesLike {
  decodingInfo(config: {
    type: "media-source" | "file";
    video?: {
      contentType: string;
      width: number;
      height: number;
      bitrate: number;
      framerate: number;
    };
  }): Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }>;
}

export interface ProbeEnv {
  userAgent: string;
  videoCanPlayType: (type: string) => CanPlayTypeResult;
  audioCanPlayType: (type: string) => CanPlayTypeResult;
  isTypeSupported: (type: string) => boolean;
  matchesHighDynamicRange: () => boolean;
  mediaCapabilities: MediaCapabilitiesLike | undefined;
}

function truthy(result: CanPlayTypeResult): boolean {
  return result === "maybe" || result === "probably";
}

/** Constructs a `ProbeEnv` from the real browser globals. Must only be
 *  called client-side (`typeof document !== 'undefined'`); the login page
 *  guards this. */
export function realProbeEnv(): ProbeEnv {
  const video = document.createElement("video");
  const audio = document.createElement("audio");
  const hasMediaSource = typeof MediaSource !== "undefined";
  return {
    userAgent: navigator.userAgent,
    videoCanPlayType: (type) => video.canPlayType(type) as CanPlayTypeResult,
    audioCanPlayType: (type) => audio.canPlayType(type) as CanPlayTypeResult,
    isTypeSupported: (type) => (hasMediaSource ? MediaSource.isTypeSupported(type) : false),
    matchesHighDynamicRange: () =>
      typeof matchMedia !== "undefined" && matchMedia("(dynamic-range: high)").matches,
    mediaCapabilities: (navigator as Navigator & { mediaCapabilities?: MediaCapabilitiesLike })
      .mediaCapabilities,
  };
}

/** `profileId` per PLAYBACK.md §2.2 example values ('web-chrome',
 *  'web-safari'); a minimal, order-sensitive UA sniff (Chrome's UA also
 *  contains "Safari", so Chrome/Edg/Firefox must be checked first). */
function detectProfileId(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes("edg/")) return "web-edge";
  if (ua.includes("firefox/")) return "web-firefox";
  if (ua.includes("chrome/") || ua.includes("chromium/")) return "web-chrome";
  if (ua.includes("safari/")) return "web-safari";
  return "web-unknown";
}

// H.264 High-profile level -> resolution/framerate ceiling. This is a
// spec-defined mapping (the level number IS a decode-capability ceiling,
// not a guess) — Annex A of the H.264 spec. Only used once the browser has
// actually confirmed it supports that exact codec string via MSE.
const H264_LEVELS: ReadonlyArray<{
  level: number;
  codec: string;
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
}> = [
  { level: 30, codec: "avc1.64001e", maxWidth: 720, maxHeight: 480, maxFrameRate: 30 },
  { level: 31, codec: "avc1.640020", maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 },
  { level: 40, codec: "avc1.640028", maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 },
  { level: 41, codec: "avc1.640029", maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 },
  { level: 42, codec: "avc1.64002a", maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 },
  { level: 50, codec: "avc1.640032", maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30 },
  { level: 51, codec: "avc1.640033", maxWidth: 4096, maxHeight: 2160, maxFrameRate: 30 },
];

function probeH264(env: ProbeEnv): DeviceProfile["video"][number] | undefined {
  let best: (typeof H264_LEVELS)[number] | undefined;
  for (const entry of H264_LEVELS) {
    if (env.isTypeSupported(`video/mp4; codecs="${entry.codec}"`)) best = entry;
  }
  if (!best) return undefined;
  return {
    codec: "h264",
    maxProfile: "high",
    maxLevel: best.level,
    maxBitDepth: 8, // High Profile (avc1.64*) is 8-bit only; browsers never expose 10-bit H.264.
    maxWidth: best.maxWidth,
    maxHeight: best.maxHeight,
    maxFrameRate: best.maxFrameRate,
    maxBitrateBps: null, // not derivable from a codec-string probe; left honestly unknown.
  };
}

/** hevc/vp9/av1 share a shape: probe an 8-bit baseline string and a 10-bit
 *  (HDR-capable) string; if supported, use mediaCapabilities.decodingInfo
 *  (when available) to check whether 4K decode is actually reported
 *  smooth+supported before claiming a 4K ceiling — otherwise stay at the
 *  1080p tier we can defend without a resolution-specific check. */
async function probeResolutionAware(
  env: ProbeEnv,
  codec: DeviceProfile["video"][number]["codec"],
  container: "mp4" | "webm",
  eightBitCodecString: string,
  tenBitCodecString: string | undefined,
): Promise<DeviceProfile["video"][number] | undefined> {
  const mime = container === "mp4" ? "video/mp4" : "video/webm";
  const supports8Bit = env.isTypeSupported(`${mime}; codecs="${eightBitCodecString}"`);
  const supports10Bit = tenBitCodecString
    ? env.isTypeSupported(`${mime}; codecs="${tenBitCodecString}"`)
    : false;
  if (!supports8Bit && !supports10Bit) return undefined;

  const bitDepth: 8 | 10 = supports10Bit ? 10 : 8;
  const codecString = supports10Bit ? tenBitCodecString! : eightBitCodecString;

  let maxWidth = 1920;
  let maxHeight = 1080;
  const maxFrameRate = 30;

  if (env.mediaCapabilities) {
    try {
      const uhd = await env.mediaCapabilities.decodingInfo({
        type: "media-source",
        video: {
          contentType: `${mime}; codecs="${codecString}"`,
          width: 3840,
          height: 2160,
          bitrate: 20_000_000,
          framerate: 30,
        },
      });
      if (uhd.supported && uhd.smooth) {
        maxWidth = 3840;
        maxHeight = 2160;
      }
    } catch {
      // decodingInfo threw (unsupported config shape on this browser) —
      // stay at the defensible 1080p ceiling rather than guess.
    }
  }

  return {
    codec,
    maxProfile: null, // vp9/av1/hevc profiles aren't cleanly derived from a single codec string here.
    maxLevel: null,
    maxBitDepth: bitDepth,
    maxWidth,
    maxHeight,
    maxFrameRate,
    maxBitrateBps: null,
  };
}

async function probeVideo(env: ProbeEnv): Promise<DeviceProfile["video"]> {
  const entries: DeviceProfile["video"] = [];

  const h264 = probeH264(env);
  if (h264) entries.push(h264);

  const hevc = await probeResolutionAware(
    env,
    "hevc",
    "mp4",
    "hvc1.1.6.L153.B0", // Main
    "hvc1.2.4.L153.B0", // Main10
  );
  if (hevc) entries.push(hevc);

  const vp9 = await probeResolutionAware(
    env,
    "vp9",
    "webm",
    "vp09.00.10.08", // Profile 0, 8-bit
    "vp09.02.10.10", // Profile 2, 10-bit
  );
  if (vp9) entries.push(vp9);

  const av1 = await probeResolutionAware(
    env,
    "av1",
    "mp4",
    "av01.0.04M.08",
    "av01.0.05M.10",
  );
  if (av1) entries.push(av1);

  return entries;
}

const CONTAINER_PROBES: ReadonlyArray<{ container: Container; test: (env: ProbeEnv) => boolean }> = [
  {
    container: "mp4",
    test: (env) =>
      truthy(env.videoCanPlayType('video/mp4; codecs="avc1.640028"')) ||
      truthy(env.audioCanPlayType('audio/mp4; codecs="mp4a.40.2"')),
  },
  {
    container: "webm",
    test: (env) =>
      truthy(env.videoCanPlayType('video/webm; codecs="vp9"')) ||
      truthy(env.audioCanPlayType('audio/webm; codecs="opus"')),
  },
  // mkv/avi: no mainstream browser's <video>/MSE advertises native support
  // for these containers (Matroska/AVI demuxing is not implemented) — never
  // claimed, however common the files are in real libraries.
  { container: "mkv", test: () => false },
  { container: "avi", test: () => false },
  { container: "ts", test: (env) => truthy(env.videoCanPlayType("video/mp2t")) },
  { container: "mov", test: (env) => truthy(env.videoCanPlayType("video/quicktime")) },
  { container: "flac", test: (env) => truthy(env.audioCanPlayType("audio/flac")) },
  { container: "mp3", test: (env) => truthy(env.audioCanPlayType("audio/mpeg")) },
  { container: "ogg", test: (env) => truthy(env.audioCanPlayType('audio/ogg; codecs="vorbis"')) },
  { container: "m4a", test: (env) => truthy(env.audioCanPlayType('audio/mp4; codecs="mp4a.40.2"')) },
  { container: "wav", test: (env) => truthy(env.audioCanPlayType("audio/wav")) },
];

function probeDirectPlayContainers(env: ProbeEnv): Container[] {
  return CONTAINER_PROBES.filter((p) => p.test(env)).map((p) => p.container);
}

function probeAudio(env: ProbeEnv): DeviceProfile["audio"] {
  const candidates: Array<{ codec: DeviceProfile["audio"][number]["codec"]; test: () => boolean }> = [
    { codec: "aac", test: () => truthy(env.audioCanPlayType('audio/mp4; codecs="mp4a.40.2"')) },
    { codec: "mp3", test: () => truthy(env.audioCanPlayType("audio/mpeg")) },
    { codec: "flac", test: () => truthy(env.audioCanPlayType("audio/flac")) },
    { codec: "opus", test: () => truthy(env.audioCanPlayType('audio/webm; codecs="opus"')) },
    { codec: "vorbis", test: () => truthy(env.audioCanPlayType('audio/ogg; codecs="vorbis"')) },
  ];
  return candidates
    .filter((c) => c.test())
    .map((c) => ({
      codec: c.codec,
      // Browsers do not expose surround/multichannel decode capability via
      // canPlayType or MSE — we can confirm stereo decode, not 5.1/7.1, so
      // this stays at 2 rather than optimistically claiming more.
      maxChannels: 2,
      // No web API exposes bitstream passthrough (TrueHD/DTS-HD); the
      // browser always decodes to PCM. Never true on web.
      passthrough: false,
    }));
}

/** Builds the full DeviceProfile via real browser probing. Pass a mock
 *  `ProbeEnv` in tests; defaults to `realProbeEnv()` in the browser. */
export async function buildDeviceProfile(env: ProbeEnv = realProbeEnv()): Promise<DeviceProfile> {
  const video = await probeVideo(env);
  const hasHdrCapableVideo = video.some((v) => v.maxBitDepth === 10);
  const displayReportsHdr = env.matchesHighDynamicRange();
  // Neither HDR10 nor HLG is distinguishable from the other via any web API
  // — both stay tied to the same (display-capable AND 10-bit-decode-capable)
  // signal rather than pretending we can tell them apart. Dolby Vision has
  // no web decode/detection surface at all, so it is always false.
  const hdrSupported = displayReportsHdr && hasHdrCapableVideo;

  return {
    profileId: detectProfileId(env.userAgent),
    directPlayContainers: probeDirectPlayContainers(env),
    hls: {
      container: "fmp4",
      supportsFmp4: env.isTypeSupported('video/mp4; codecs="avc1.640028"'),
      lowLatency: false, // LL-HLS chunked parsing isn't implemented client-side yet.
    },
    video,
    hdr: {
      hdr10: hdrSupported,
      hlg: hdrSupported,
      dolbyVision: false,
    },
    audio: probeAudio(env),
    subtitles: {
      // The player lane renders SRT/VTT cues itself (converting SRT text to
      // cues in JS); ASS styling and mov_text extraction aren't implemented
      // by any surface built so far, so they're honestly left out.
      renderText: ["subrip", "webvtt"],
      hlsVtt: true,
      renderImage: false, // image-based subs (PGS/VOBSUB/DVBSUB) need burn-in; no web render path.
    },
    maxStreamBitrateBps: null,
  };
}
