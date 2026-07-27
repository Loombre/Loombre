// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Random VALID PlanInput generators for the property-test harness
 * (docs/PLAYBACK.md §10 "Mandatory property tests" / §11 step 1). Every
 * generator is a pure function of a seeded `Rng` (matrix/lib/prng.ts) — no
 * unseeded Math.random anywhere in this file.
 *
 * Two families:
 *   - `genRandomPlanInput` — samples across the FULL §2 type space (every
 *     container, every video/audio/subtitle codec including the closed
 *     enums' edge members like 'unknown', dv with profiles 5/7/8 +
 *     dvBlCompatId, degenerate empty device arrays, transcode-disabled +
 *     tier 0/1/2 policies, all four caps fixture sets, null selection
 *     indexes, both modes). Used by properties (1) determinism, (3)
 *     totality, and (4) reason completeness — it deliberately does NOT try
 *     to avoid triggering stage reasons; totality/reason-completeness need
 *     inputs that DO escalate past direct-play.
 *   - `genDirectPlayInput` — a CONSTRUCTIVE generator: every stream it
 *     places is deliberately within its device's limits, so every stage
 *     must verdict copy/none. Used by property (2), direct-play bias,
 *     which docs/PLAYBACK.md P3.1 calls out as expected to go green
 *     starting Stage A specifically.
 */
import { bool, int, pick, pickN, type Rng } from "./prng.js";
import { loadCapsFixtures } from "./caps-fixtures.js";
import type {
  AudioCodec,
  AudioStream,
  Container,
  DeviceProfile,
  DeviceProfileAudioEntry,
  DeviceProfileVideoEntry,
  HdrKind,
  LadderRung,
  MediaInfo,
  PlanInput,
  ServerPolicy,
  SubtitleCodec,
  SubtitleStream,
  TrackSelection,
  VerifiedCapabilities,
  VideoCodec,
  VideoStream,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Shared value pools (docs/PLAYBACK.md §2 closed enums, full type space)
// ---------------------------------------------------------------------------

// v1.1 widening (STATE.md H3, docs/PLAYBACK.md §2.1): asf/mpeg/flv/aac/aiff.
// Sampled here (genRandomPlanInput's totality/determinism/reason-
// completeness property coverage) but deliberately NOT added to
// DIRECT_PLAY_VIDEO_CONTAINERS/DIRECT_PLAY_MUSIC_OPTIONS below — no device
// ever declares these direct-playable (adjudicated: "new containers are
// simply never direct-playable" — ingestion generosity, not a playback
// capability), so the constructive direct-play generator must never
// synthesize one either.
const ALL_CONTAINERS: Container[] = [
  "mp4",
  "mkv",
  "webm",
  "avi",
  "ts",
  "mov",
  "flac",
  "mp3",
  "ogg",
  "m4a",
  "wav",
  "asf",
  "mpeg",
  "flv",
  "aac",
  "aiff",
];

const ALL_VIDEO_CODECS: VideoCodec[] = ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4", "unknown"];
const ALL_HDR_KINDS: HdrKind[] = ["none", "hdr10", "hlg", "dv"];
const DV_PROFILES = [5, 7, 8] as const;
const DV_BL_COMPAT_IDS = [1, 2, 4] as const;
const PROFILE_NAMES = ["baseline", "main", "high", "main10", "profile0", "profile2"] as const;
const LEVELS = [30, 31, 40, 41, 50, 51, 52, 123, 153] as const;
const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;
const RESOLUTIONS = [
  [640, 360],
  [1280, 720],
  [1920, 1080],
  [3840, 2160],
] as const;

const ALL_AUDIO_CODECS: AudioCodec[] = [
  "aac",
  "ac3",
  "eac3",
  "truehd",
  "dts",
  "dtshd",
  "flac",
  "opus",
  "mp3",
  "vorbis",
  "pcm",
  "unknown",
];
const CHANNEL_COUNTS = [1, 2, 6, 8] as const;
const SAMPLE_RATES = [44100, 48000, 96000] as const;
const LANGUAGES = ["eng", "spa", "fre", "jpn", "und"] as const;

const ALL_SUBTITLE_CODECS: SubtitleCodec[] = [
  "subrip",
  "ass",
  "webvtt",
  "mov_text",
  "pgs",
  "vobsub",
  "dvbsub",
  "unknown",
];

const AUDIO_PRIORITY_OPTIONS: readonly ("opus" | "aac")[][] = [
  ["opus", "aac"],
  ["aac", "opus"],
  ["aac"],
  ["opus"],
];

const LADDER_TABLE: LadderRung[] = [
  { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
  { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" },
  { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
];

/** Degenerate-empty-array probability shared across device-profile fields
 *  (docs/PLAYBACK.md §2.2 — "device profiles incl. degenerate empty
 *  arrays" is an explicit §10/step-1 coverage requirement). */
const EMPTY_CHANCE = 0.15;

function genRandomCaps(rng: Rng): VerifiedCapabilities {
  const fixtures = loadCapsFixtures();
  const names = Object.keys(fixtures);
  const name = pick(rng, names);
  const value = fixtures[name];
  if (!value) throw new Error(`genRandomCaps: fixture "${name}" missing from caps.yaml`);
  return value;
}

// ---------------------------------------------------------------------------
// genRandomPlanInput — full §2 type space, no bias toward direct-play
// ---------------------------------------------------------------------------

function genRandomVideoStream(rng: Rng, index: number): VideoStream {
  const codec = pick(rng, ALL_VIDEO_CODECS);
  const bitDepth = pick(rng, [8, 10, 12] as const);
  const hdr = pick(rng, ALL_HDR_KINDS);
  const [width, height] = pick(rng, RESOLUTIONS);

  let dvProfile: number | null = null;
  let dvBlCompatId: number | null = null;
  if (hdr === "dv") {
    dvProfile = pick(rng, DV_PROFILES);
    // dvBlCompatId (8.1 HDR10-compatible base layer) only applies to
    // profiles 7/8, never profile 5 (docs/PLAYBACK.md §2.1/§3).
    dvBlCompatId = dvProfile !== 5 && bool(rng, 0.5) ? pick(rng, DV_BL_COMPAT_IDS) : null;
  }

  return {
    index,
    codec,
    profile: bool(rng, 0.7) ? pick(rng, PROFILE_NAMES) : null,
    level: bool(rng, 0.7) ? pick(rng, LEVELS) : null,
    width,
    height,
    bitDepth,
    frameRate: pick(rng, FRAME_RATES),
    bitrateBps: bool(rng, 0.9) ? int(rng, 200_000, 100_000_000) : null,
    hdr,
    dvProfile,
    dvBlCompatId,
    interlaced: bool(rng, 0.15),
  };
}

function genRandomAudioStream(rng: Rng, index: number): AudioStream {
  const codec = pick(rng, ALL_AUDIO_CODECS);
  return {
    index,
    codec,
    channels: pick(rng, CHANNEL_COUNTS),
    sampleRate: pick(rng, SAMPLE_RATES),
    bitrateBps: bool(rng, 0.9) ? int(rng, 64_000, 5_000_000) : null,
    language: bool(rng, 0.8) ? pick(rng, LANGUAGES) : null,
    isDefault: bool(rng, 0.7),
    hasAtmos: (codec === "truehd" || codec === "eac3") && bool(rng, 0.4),
  };
}

function genRandomSubtitleStream(rng: Rng, index: number): SubtitleStream {
  const codec = pick(rng, ALL_SUBTITLE_CODECS);
  const isExternal = bool(rng, 0.2);
  return {
    index,
    codec,
    language: bool(rng, 0.8) ? pick(rng, LANGUAGES) : null,
    isForced: bool(rng, 0.2),
    isDefault: bool(rng, 0.3),
    isExternal,
    externalPath: isExternal ? `/sidecars/gen-${index}.srt` : null,
  };
}

function genRandomDeviceVideoEntry(rng: Rng): DeviceProfileVideoEntry {
  return {
    codec: pick(rng, ALL_VIDEO_CODECS),
    maxProfile: bool(rng, 0.5) ? pick(rng, ["baseline", "main", "high", "main10"] as const) : null,
    maxLevel: bool(rng, 0.5) ? pick(rng, LEVELS) : null,
    maxBitDepth: pick(rng, [8, 10] as const),
    maxWidth: pick(rng, [1280, 1920, 3840] as const),
    maxHeight: pick(rng, [720, 1080, 2160] as const),
    maxFrameRate: pick(rng, [30, 60] as const),
    maxBitrateBps: bool(rng, 0.5) ? int(rng, 1_000_000, 100_000_000) : null,
  };
}

function genRandomDeviceAudioEntry(rng: Rng): DeviceProfileAudioEntry {
  return {
    codec: pick(rng, ALL_AUDIO_CODECS),
    maxChannels: pick(rng, [2, 6, 8] as const),
    passthrough: bool(rng, 0.3),
  };
}

function genRandomDeviceProfile(rng: Rng): DeviceProfile {
  return {
    profileId: `gen-device-${int(rng, 0, 1_000_000)}`,
    directPlayContainers: bool(rng, EMPTY_CHANCE) ? [] : pickN(rng, ALL_CONTAINERS, int(rng, 1, 4)),
    hls: {
      container: pick(rng, ["fmp4", "ts"] as const),
      supportsFmp4: bool(rng, 0.7),
      lowLatency: bool(rng, 0.2),
    },
    video: bool(rng, EMPTY_CHANCE) ? [] : Array.from({ length: int(rng, 0, 3) }, () => genRandomDeviceVideoEntry(rng)),
    hdr: { hdr10: bool(rng, 0.5), hlg: bool(rng, 0.5), dolbyVision: bool(rng, 0.3) },
    audio: bool(rng, EMPTY_CHANCE) ? [] : Array.from({ length: int(rng, 1, 3) }, () => genRandomDeviceAudioEntry(rng)),
    subtitles: {
      renderText: bool(rng, EMPTY_CHANCE)
        ? []
        : pickN(rng, ["subrip", "ass", "webvtt", "mov_text"] as const, int(rng, 0, 3)),
      hlsVtt: bool(rng, 0.6),
      renderImage: bool(rng, 0.3),
    },
    maxStreamBitrateBps: bool(rng, 0.5) ? int(rng, 1_000_000, 100_000_000) : null,
  };
}

function genRandomNetwork(rng: Rng) {
  return {
    maxBitrateBps: int(rng, 500_000, 100_000_000),
    isLocal: bool(rng, 0.3),
  };
}

function genRandomPolicy(rng: Rng): ServerPolicy {
  return {
    // transcode-disabled coverage (docs/PLAYBACK.md §10 policy dimension).
    allowTranscode: bool(rng, 0.85),
    allowToneMapCpu: pick(rng, ["always", "never", "tier-gated"] as const),
    tier: pick(rng, [0, 1, 2] as const),
    preferredTextSubMode: pick(rng, ["hls-vtt", "burn-in"] as const),
    preserveAssStyling: bool(rng, 0.3),
    audioTranscodeCodecPriority: pick(rng, AUDIO_PRIORITY_OPTIONS),
    maxSimultaneousTranscodes: int(rng, 1, 4),
    ladderRungs: LADDER_TABLE,
    segmentDurationSec: 6,
    hevcEncodePreferred: bool(rng, 0.3),
  };
}

/**
 * A random, structurally-valid PlanInput sampling the full §2 type space —
 * every container/codec/hdr-kind/subtitle-kind, degenerate empty device
 * arrays, every policy/tier combination including transcode-disabled, every
 * caps fixture set, null selection indexes, and both modes. No attempt is
 * made to bias toward (or away from) direct-play — properties (1)/(3)/(4)
 * want the FULL space, including inputs that escalate every which way.
 */
export function genRandomPlanInput(rng: Rng): PlanInput {
  const hasVideo = bool(rng, 0.8);
  const hasAudio = bool(rng, 0.9);
  const hasSubtitle = bool(rng, 0.5);

  let nextIndex = 0;

  let video: VideoStream[] = [];
  let selectedVideoIndex: number | null = null;
  if (hasVideo) {
    const v = genRandomVideoStream(rng, nextIndex++);
    video = [v];
    selectedVideoIndex = bool(rng, 0.9) ? v.index : null;
  }

  let audio: AudioStream[] = [];
  let selectedAudioIndex: number | null = null;
  if (hasAudio) {
    const a = genRandomAudioStream(rng, nextIndex++);
    audio = [a];
    selectedAudioIndex = bool(rng, 0.9) ? a.index : null;
  }

  let subtitle: SubtitleStream[] = [];
  let selectedSubtitleIndex: number | null = null;
  if (hasSubtitle) {
    const s = genRandomSubtitleStream(rng, nextIndex++);
    subtitle = [s];
    selectedSubtitleIndex = bool(rng, 0.7) ? s.index : null;
  }

  const container = pick(rng, ALL_CONTAINERS);
  const media: MediaInfo = {
    fileId: `gen-${int(rng, 0, 1_000_000_000)}`,
    container,
    durationMs: int(rng, 1000, 3 * 60 * 60 * 1000),
    sizeBytes: int(rng, 1_000_000, 50_000_000_000),
    overallBitrateBps: int(rng, 100_000, 100_000_000),
    video,
    audio,
    subtitle,
  };

  const selection: TrackSelection = {
    videoStreamIndex: selectedVideoIndex,
    audioStreamIndex: selectedAudioIndex,
    subtitleStreamIndex: selectedSubtitleIndex,
  };

  return {
    media,
    device: genRandomDeviceProfile(rng),
    network: genRandomNetwork(rng),
    policy: genRandomPolicy(rng),
    caps: genRandomCaps(rng),
    selection,
    mode: pick(rng, ["stream", "download"] as const),
  };
}

// ---------------------------------------------------------------------------
// genDirectPlayInput — constructive generator: every stage passes by design
// ---------------------------------------------------------------------------

function genPermissivePolicy(rng: Rng): ServerPolicy {
  return {
    allowTranscode: true,
    allowToneMapCpu: pick(rng, ["always", "never", "tier-gated"] as const),
    tier: pick(rng, [0, 1, 2] as const),
    preferredTextSubMode: "hls-vtt",
    preserveAssStyling: false,
    audioTranscodeCodecPriority: ["opus", "aac"],
    maxSimultaneousTranscodes: 1,
    ladderRungs: LADDER_TABLE,
    segmentDurationSec: 6,
    hevcEncodePreferred: false,
  };
}

const DIRECT_PLAY_MUSIC_OPTIONS: { container: Container; codec: AudioCodec }[] = [
  { container: "flac", codec: "flac" },
  { container: "mp3", codec: "mp3" },
  { container: "m4a", codec: "aac" },
  { container: "ogg", codec: "vorbis" },
  { container: "wav", codec: "pcm" },
];

function genDirectPlayMusicInput(rng: Rng): PlanInput {
  const { container, codec } = pick(rng, DIRECT_PLAY_MUSIC_OPTIONS);
  const channels = pick(rng, [1, 2] as const);
  const bitrateBps = int(rng, 96_000, 1_000_000);

  const audio: AudioStream = {
    index: 0,
    codec,
    channels,
    sampleRate: pick(rng, [44100, 48000] as const),
    bitrateBps,
    language: "eng",
    isDefault: true,
    hasAtmos: false,
  };

  const media: MediaInfo = {
    fileId: `gen-dp-music-${int(rng, 0, 1_000_000_000)}`,
    container,
    durationMs: int(rng, 60_000, 600_000),
    sizeBytes: int(rng, 1_000_000, 100_000_000),
    overallBitrateBps: bitrateBps,
    video: [],
    audio: [audio],
    subtitle: [],
  };

  const device: DeviceProfile = {
    profileId: "gen-dp-audio-device",
    directPlayContainers: [container],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    // Generous cap: always >= the source's channel count, never truehd/dts
    // so passthrough never enters the picture.
    audio: [{ codec, maxChannels: 2, passthrough: true }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
  };

  return {
    media,
    device,
    network: { maxBitrateBps: 100_000_000, isLocal: true },
    policy: genPermissivePolicy(rng),
    caps: genRandomCaps(rng),
    selection: { videoStreamIndex: null, audioStreamIndex: 0, subtitleStreamIndex: null },
    mode: pick(rng, ["stream", "download"] as const),
  };
}

const DIRECT_PLAY_VIDEO_CONTAINERS: Container[] = ["mp4", "mkv", "webm", "avi", "ts", "mov"];
const DIRECT_PLAY_VIDEO_CODECS: VideoCodec[] = ["h264", "hevc", "av1", "vp9"];
const DIRECT_PLAY_AUDIO_CODECS: AudioCodec[] = ["aac", "opus", "ac3", "eac3", "flac"];
const DIRECT_PLAY_RESOLUTIONS = [
  [1280, 720],
  [1920, 1080],
  [3840, 2160],
] as const;
const DIRECT_PLAY_FRAME_RATES = [23.976, 24, 25, 29.97, 30] as const;

function genDirectPlayVideoInput(rng: Rng): PlanInput {
  const container = pick(rng, DIRECT_PLAY_VIDEO_CONTAINERS);
  const videoCodec = pick(rng, DIRECT_PLAY_VIDEO_CODECS);
  const bitDepth = pick(rng, [8, 10] as const);
  const [width, height] = pick(rng, DIRECT_PLAY_RESOLUTIONS);

  const video: VideoStream = {
    index: 0,
    codec: videoCodec,
    // null profile/level => the device's null maxProfile/maxLevel below
    // never compares (docs/PLAYBACK.md §3 Stage B.3's "exceeds" checks are
    // vacuous when the device places no cap on that axis) — deliberately
    // sidesteps profile-table modeling this generator has no business
    // doing; totality/reason-completeness (genRandomPlanInput) exercise
    // profile mismatches instead.
    profile: null,
    level: null,
    width,
    height,
    bitDepth,
    frameRate: pick(rng, DIRECT_PLAY_FRAME_RATES),
    bitrateBps: int(rng, 1_000_000, 15_000_000),
    hdr: "none",
    dvProfile: null,
    dvBlCompatId: null,
    interlaced: false,
  };

  const audioCodec = pick(rng, DIRECT_PLAY_AUDIO_CODECS);
  const channels = pick(rng, [1, 2, 6] as const);
  const audio: AudioStream = {
    index: 1,
    codec: audioCodec,
    channels,
    sampleRate: 48000,
    bitrateBps: int(rng, 96_000, 512_000),
    language: "eng",
    isDefault: true,
    hasAtmos: false,
  };

  const media: MediaInfo = {
    fileId: `gen-dp-video-${int(rng, 0, 1_000_000_000)}`,
    container,
    durationMs: int(rng, 60_000, 2 * 60 * 60 * 1000),
    sizeBytes: int(rng, 10_000_000, 20_000_000_000),
    overallBitrateBps: (video.bitrateBps ?? 0) + (audio.bitrateBps ?? 0),
    video: [video],
    audio: [audio],
    // No subtitle stream at all: Stage E verdicts 'none' (copy-equivalent)
    // without needing to reconstruct exact embed-vs-hls-vtt-vs-burn-in
    // logic here — reserved for the general generator's coverage.
    subtitle: [],
  };

  const device: DeviceProfile = {
    profileId: "gen-dp-video-device",
    directPlayContainers: [container],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: videoCodec,
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: 60,
        maxBitrateBps: null,
      },
    ],
    hdr: { hdr10: true, hlg: true, dolbyVision: true },
    audio: [{ codec: audioCodec, maxChannels: 8, passthrough: true }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
  };

  return {
    media,
    device,
    network: { maxBitrateBps: 200_000_000, isLocal: true },
    policy: genPermissivePolicy(rng),
    caps: genRandomCaps(rng),
    selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    mode: pick(rng, ["stream", "download"] as const),
  };
}

/**
 * Constructive "every stage passes" generator for property (2), direct-play
 * bias (docs/PLAYBACK.md §0 design law 2 / §10). Every axis it places is
 * deliberately within the paired device's declared limits, so a correct
 * plan() must verdict copy/none at every stage and the final decision must
 * be 'direct-play' with reasons === [].
 */
export function genDirectPlayInput(rng: Rng): PlanInput {
  return bool(rng, 0.25) ? genDirectPlayMusicInput(rng) : genDirectPlayVideoInput(rng);
}
