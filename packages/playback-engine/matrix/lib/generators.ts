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

/**
 * Wave C1 (LD-7 / §10 property 5): ADMIN-CONFIGURED ladder tables carrying
 * explicit `av1` rows. §7.1(g)'s demotion normalization is the ONLY thing
 * standing between these and an av1 rung on a box that cannot encode one,
 * so the property generators must actually produce them — an unreachability
 * proof over inputs that never ask for AV1 proves nothing. Three shapes:
 * an all-av1 table, a mixed table, and a 2160p av1 rung (which the swap can
 * never produce, so only an explicit row can express it).
 */
const AV1_LADDER_TABLES: LadderRung[][] = [
  [
    { heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 384_000, codec: "av1" },
    { heightPx: 720, videoBitrateBps: 2_500_000, audioBitrateBps: 160_000, codec: "av1" },
    { heightPx: 480, videoBitrateBps: 1_200_000, audioBitrateBps: 160_000, codec: "av1" },
  ],
  [
    { heightPx: 2160, videoBitrateBps: 12_000_000, audioBitrateBps: 384_000, codec: "av1" },
    { heightPx: 1080, videoBitrateBps: 5_000_000, audioBitrateBps: 384_000, codec: "hevc" },
    { heightPx: 720, videoBitrateBps: 2_000_000, audioBitrateBps: 160_000, codec: "h264" },
  ],
  [
    { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "av1" },
    { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "hevc" },
    { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
  ],
];

const ALL_LADDER_TABLES: LadderRung[][] = [LADDER_TABLE, ...AV1_LADDER_TABLES];

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
    // §2.1 fact (added 2026-08-10) — randomized here so the full-space
    // property suites (determinism/totality/reason-completeness) exercise
    // the open-gop-leading-pictures-stripped assembly in src/plan.ts across
    // every codec, not just hevc (plan.ts's own hevc codec gate, opus-review
    // Finding C, makes the flag/reason a no-op for every other codec).
    openGop: bool(rng, 0.2),
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
    // Wave C1: av1-bearing tables enter the FULL random space so
    // properties (1)/(3)/(4) exercise §7.1(g)'s normalization too, and so
    // property (5)'s restricted generator below is not the only place an
    // explicit av1 rung is ever seen.
    ladderRungs: pick(rng, ALL_LADDER_TABLES),
    segmentDurationSec: 2,
    hevcEncodePreferred: bool(rng, 0.3),
    // The operator opt-in (§2.4), sampled at both settings — the engine's
    // own §7.2 gate is what decides whether it can mean anything.
    av1EncodePreferred: bool(rng, 0.4),
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
    segmentDurationSec: 2,
    hevcEncodePreferred: false,
    // Randomized deliberately: property (2) asserts a DIRECT-PLAY outcome,
    // and §7.1's copy-preference guarantee says no ladder rule may ever
    // influence that — flipping this flag under a passing direct-play input
    // must change nothing at all.
    av1EncodePreferred: bool(rng, 0.5),
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
    // Deliberately false, not randomized — every device this generator
    // builds declares the SAME container as `directPlayContainers` below,
    // so no repackage ever occurs regardless of this value; false keeps
    // that "every stage passes by construction" property (this file's own
    // header) legible on its face.
    openGop: false,
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

// ---------------------------------------------------------------------------
// genAv1Tier0Input — docs/PLAYBACK.md §10 property 5 (LD-16 unreachability)
// ---------------------------------------------------------------------------

/**
 * A random input RESTRICTED to property 5's hypothesis: `policy.tier === 0`
 * AND no non-software backend with `'av1' ∈ encode`. Everything else is
 * sampled as adversarially as the type space allows — the operator opt-in
 * is biased ON, ladder tables are biased toward explicit av1 rows, the
 * software backend often DOES verify av1 encode (the exact trap: a box that
 * genuinely could software-encode AV1 and is being asked to), and devices
 * frequently declare an av1 entry with fmp4 support. Under those conditions
 * §7.2 says `plan()` cannot emit av1 BY CONSTRUCTION; properties.spec.ts
 * quantifies exactly that.
 *
 * Built by CONSTRAINING `genRandomPlanInput`'s output rather than
 * duplicating it, so every future widening of the base generator is
 * inherited here automatically instead of silently bypassing the property.
 */
export function genAv1Tier0Input(rng: Rng): PlanInput {
  const base = genRandomPlanInput(rng);

  // The software row may or may not verify av1 (both are in scope); NO
  // hardware backend ever may — that is the hypothesis, not an assumption
  // about the machine.
  const softwareVerifiesAv1 = bool(rng, 0.6);
  const backends = base.caps.backends.map((b) => ({
    ...b,
    encode:
      b.backend === "software"
        ? softwareVerifiesAv1
          ? (Array.from(new Set([...b.encode, "av1"])) as ("h264" | "hevc" | "av1")[])
          : b.encode.filter((c) => c !== "av1")
        : b.encode.filter((c) => c !== "av1"),
  }));
  // A software row is added when the fixture had none, so the 'software'
  // arm is genuinely exercised rather than vacuously absent.
  if (softwareVerifiesAv1 && !backends.some((b) => b.backend === "software")) {
    backends.push({
      backend: "software",
      decode: ["h264", "hevc", "av1", "vp9", "mpeg2"],
      encode: ["h264", "hevc", "av1"],
      toneMap: [],
      verifiedAtMs: 1_750_000_000_000,
    });
  }

  const device: DeviceProfile = bool(rng, 0.7)
    ? {
        ...base.device,
        hls: { ...base.device.hls, supportsFmp4: true },
        video: base.device.video.some((v) => v.codec === "av1")
          ? base.device.video
          : [
              ...base.device.video,
              {
                codec: "av1",
                maxProfile: null,
                maxLevel: null,
                maxBitDepth: 10,
                maxWidth: 3840,
                maxHeight: 2160,
                maxFrameRate: 60,
                maxBitrateBps: null,
              },
            ],
      }
    : base.device;

  return {
    ...base,
    device,
    caps: { backends },
    policy: {
      ...base.policy,
      tier: 0,
      // Never disabled: a transcode-disabled plan carries an empty ladder
      // and would satisfy the property vacuously.
      allowTranscode: true,
      av1EncodePreferred: bool(rng, 0.8),
      ladderRungs: bool(rng, 0.6) ? pick(rng, AV1_LADDER_TABLES) : LADDER_TABLE,
    },
  };
}

// ---------------------------------------------------------------------------
// genAv1Tier0UnrestrictedCapsInput — docs/PLAYBACK.md §10 property 6
// (§7.2's Stage-G residual guard; C1 review finding 2)
// ---------------------------------------------------------------------------

/**
 * The hardware-encode shapes property 6 needs to sample. `genAv1Tier0Input`
 * (property 5) DELETES av1 from every hardware `encode` list, so the whole
 * leg-4 corner — eligibility `'hw'`, route still collapsing to rule (iii)
 * — is outside its space by construction. This one samples that corner
 * deliberately:
 *   - `'none'`      — no hw av1 encoder at all (property 5's own subspace,
 *                     kept in scope so the two properties overlap rather
 *                     than partitioning: a regression that moved the bug
 *                     across the boundary cannot hide in the gap).
 *   - `'full'`      — the hw backend encodes everything INCLUDING av1, so
 *                     §8.3 rule (i)/(ii) really can take it. This is the
 *                     arm that proves av1 is REACHABLE in this space; a
 *                     property that never sees an av1 rung anywhere proves
 *                     nothing about the software route specifically.
 *   - `'av1-only'`  — the reviewer's shape: `encode: ['av1']`. Enough for
 *                     eligibility `'hw'` (so the §7.1 swap admits av1
 *                     rungs even at tier 0), never enough to cover a mixed
 *                     `{av1, hevc}`/`{av1, h264}` target set, so the route
 *                     collapses to rule (iii) — where only the residual
 *                     guard stands between a Tier-0 box and a software AV1
 *                     encode.
 *   - `'av1-h264'`  — the same collapse one notch wider (a ladder needing
 *                     hevc still escapes coverage).
 */
const HW_AV1_ENCODE_SHAPES = ["none", "full", "av1-only", "av1-h264"] as const;

/**
 * A random input restricted ONLY to `policy.tier === 0` — caps are
 * UNRESTRICTED, hardware AV1 encoders explicitly allowed (docs/PLAYBACK.md
 * §10 property 6, the companion the C1 fable review asked for). Property 5
 * quantifies §7.2's unreachability legs 1-3 over a space where no av1 rung
 * could ever be admitted; this generator samples the space where av1 rungs
 * ARE admitted by the eligibility gate, so the ONLY thing keeping av1 off a
 * software route is the Stage-G residual guard itself. Same construction
 * discipline as `genAv1Tier0Input`: constrain `genRandomPlanInput` rather
 * than duplicate it.
 */
export function genAv1Tier0UnrestrictedCapsInput(rng: Rng): PlanInput {
  const base = genRandomPlanInput(rng);

  const hwShape = pick(rng, HW_AV1_ENCODE_SHAPES);
  const softwareVerifiesAv1 = bool(rng, 0.5);
  const backends = base.caps.backends.map((b) => {
    if (b.backend === "software") {
      return {
        ...b,
        encode: softwareVerifiesAv1
          ? (Array.from(new Set([...b.encode, "av1"])) as ("h264" | "hevc" | "av1")[])
          : b.encode.filter((c) => c !== "av1"),
      };
    }
    // Two backends can NEVER carry av1 encode on any real machine, and
    // the arg builder's interpretation-J guard says so out loud rather
    // than emitting a nonexistent encoder name: `d3d11va` is decode-only
    // (§8.2, no row in the encoder-name table at all) and `videotoolbox`
    // has no `av1_videotoolbox` encoder in any ffmpeg release (§7.3 — the
    // probe battery reports the capability absent BY CONSTRUCTION, which
    // is what makes the Tier-0 refusal path verifiable on Apple Silicon).
    // Manufacturing those rows would sample inputs no probe can produce
    // and no plan is defined for, so this generator honors the same two
    // facts the battery does.
    if (b.backend === "d3d11va") return b;
    if (b.backend === "videotoolbox") return { ...b, encode: b.encode.filter((c) => c !== "av1") };
    switch (hwShape) {
      case "none":
        return { ...b, encode: b.encode.filter((c) => c !== "av1") };
      case "full":
        return { ...b, encode: Array.from(new Set([...b.encode, "av1"])) as ("h264" | "hevc" | "av1")[] };
      case "av1-only":
        return { ...b, encode: ["av1"] as ("h264" | "hevc" | "av1")[] };
      default:
        return { ...b, encode: ["av1", "h264"] as ("h264" | "hevc" | "av1")[] };
    }
  });

  // A hardware row is INJECTED when the drawn fixture had none (several are
  // software-only), so the av1-bearing hw shapes are genuinely sampled
  // rather than silently collapsing back into property 5's space.
  if (hwShape !== "none" && !backends.some((b) => b.backend !== "software")) {
    backends.unshift({
      backend: "nvenc",
      decode: ["h264", "hevc", "av1", "vp9", "mpeg2"],
      encode: hwShape === "full" ? ["h264", "hevc", "av1"] : hwShape === "av1-only" ? ["av1"] : ["av1", "h264"],
      toneMap: ["cuda"],
      verifiedAtMs: 1_750_000_000_000,
    });
  }

  const device: DeviceProfile = bool(rng, 0.75)
    ? {
        ...base.device,
        hls: { ...base.device.hls, supportsFmp4: true },
        video: base.device.video.some((v) => v.codec === "av1")
          ? base.device.video
          : [
              ...base.device.video,
              {
                codec: "av1",
                maxProfile: null,
                maxLevel: null,
                maxBitDepth: 10,
                maxWidth: 3840,
                maxHeight: 2160,
                maxFrameRate: 60,
                maxBitrateBps: null,
              },
            ],
      }
    : base.device;

  return {
    ...base,
    device,
    caps: { backends },
    policy: {
      ...base.policy,
      tier: 0,
      // Never disabled, for the same reason property 5's generator says so:
      // a transcode-disabled plan carries an empty ladder and would satisfy
      // the property vacuously.
      allowTranscode: true,
      av1EncodePreferred: bool(rng, 0.8),
      ladderRungs: bool(rng, 0.6) ? pick(rng, AV1_LADDER_TABLES) : LADDER_TABLE,
    },
  };
}
