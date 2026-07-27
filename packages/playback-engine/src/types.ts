// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Input/output type contracts for the pure `plan()` decision function.
 * Copied verbatim (field-for-field) from docs/PLAYBACK.md §2 (inputs) and §5
 * (output). This file is the authoritative TypeScript source of these
 * contracts — docs/PLAYBACK.md wins on any future disagreement, and any
 * change here is a spec PR against that document first (docs/PLAYBACK.md
 * header + CLAUDE.md invariant 2).
 *
 * Zero I/O, zero framework imports — see docs/PLAYBACK.md §0 "Design laws".
 */
import type { PlanReason } from "./reasons.js";

// ---------------------------------------------------------------------------
// §2.1 MediaInfo
// ---------------------------------------------------------------------------

// v1.1 widening (STATE.md H3, docs/PLAYBACK.md §2.1): asf/mpeg/flv/aac/aiff
// admit legacy-format ingestion (wmv/wma->asf, mpg/mpeg/vob->mpeg, flv, bare
// ADTS aac, aiff) — none is ever direct-playable (no DeviceProfile declares
// them), so Stage A routes them like any other non-direct-playable
// container; zero decision-rule changes elsewhere.
export type Container =
  | "mp4"
  | "mkv"
  | "webm"
  | "avi"
  | "ts"
  | "mov"
  | "flac"
  | "mp3"
  | "ogg"
  | "m4a"
  | "wav"
  | "asf"
  | "mpeg"
  | "flv"
  | "aac"
  | "aiff";

export interface MediaInfo {
  fileId: string;
  container: Container;
  durationMs: number;
  sizeBytes: number;
  /** size/duration derived if probe lacks it */
  overallBitrateBps: number;
  /** may be empty (music) */
  video: VideoStream[];
  audio: AudioStream[];
  subtitle: SubtitleStream[];
}

export type VideoCodec =
  | "h264"
  | "hevc"
  | "av1"
  | "vp9"
  | "mpeg2"
  | "vc1"
  | "mpeg4"
  | "unknown";

export type HdrKind = "none" | "hdr10" | "hlg" | "dv";

export interface VideoStream {
  index: number;
  codec: VideoCodec;
  /** e.g. 'high','main10' */
  profile: string | null;
  /** e.g. 41 for 4.1 */
  level: number | null;
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12;
  /** rational resolved to float, 3 decimals */
  frameRate: number;
  bitrateBps: number | null;
  /** from color_transfer + side data */
  hdr: HdrKind;
  /** 5|7|8 when hdr==='dv' */
  dvProfile: number | null;
  /** 8.1 HDR10-compatible base layer detection */
  dvBlCompatId: number | null;
  interlaced: boolean;
}

export type AudioCodec =
  | "aac"
  | "ac3"
  | "eac3"
  | "truehd"
  | "dts"
  | "dtshd"
  | "flac"
  | "opus"
  | "mp3"
  | "vorbis"
  | "pcm"
  | "unknown";

export interface AudioStream {
  index: number;
  codec: AudioCodec;
  channels: number;
  sampleRate: number;
  bitrateBps: number | null;
  /** ISO 639-2 */
  language: string | null;
  isDefault: boolean;
  /** TrueHD/EAC3 JOC side data */
  hasAtmos: boolean;
}

export type SubtitleCodec =
  | "subrip"
  | "ass"
  | "webvtt"
  | "mov_text"
  | "pgs"
  | "vobsub"
  | "dvbsub"
  | "unknown";

export interface SubtitleStream {
  index: number;
  codec: SubtitleCodec;
  language: string | null;
  isForced: boolean;
  isDefault: boolean;
  isExternal: boolean;
  /** sidecar files, pre-resolved by caller */
  externalPath: string | null;
}

// ---------------------------------------------------------------------------
// §2.2 DeviceProfile (client-declared at login; server-validated against schema)
// ---------------------------------------------------------------------------

export interface DeviceProfileVideoEntry {
  codec: VideoCodec;
  maxProfile: string | null;
  maxLevel: number | null;
  maxBitDepth: 8 | 10;
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
  maxBitrateBps: number | null;
}

export interface DeviceProfileAudioEntry {
  codec: AudioCodec;
  maxChannels: number;
  /** bitstream passthrough (TrueHD/DTS-HD) */
  passthrough: boolean;
}

export interface DeviceProfile {
  /** e.g. 'web-chrome', 'web-safari' */
  profileId: string;
  directPlayContainers: Container[];
  hls: {
    container: "fmp4" | "ts";
    supportsFmp4: boolean;
    lowLatency: boolean;
  };
  video: DeviceProfileVideoEntry[];
  hdr: { hdr10: boolean; hlg: boolean; dolbyVision: boolean };
  audio: DeviceProfileAudioEntry[];
  subtitles: {
    renderText: SubtitleCodec[];
    hlsVtt: boolean;
    renderImage: boolean;
  };
  /** device hard cap (TV SoC limits) */
  maxStreamBitrateBps: number | null;
}

// ---------------------------------------------------------------------------
// §2.3 NetworkConditions
// ---------------------------------------------------------------------------

export interface NetworkConditions {
  /** min(user setting, measured estimate, device cap) */
  maxBitrateBps: number;
  /** RFC1918/loopback source — relaxes bitrate rung cap only */
  isLocal: boolean;
}

// ---------------------------------------------------------------------------
// §2.4 ServerPolicy (resolved defaults noted per-field)
// ---------------------------------------------------------------------------

export interface ServerPolicy {
  /** true */
  allowTranscode: boolean;
  /** 'tier-gated' (T0 -> never) */
  allowToneMapCpu: "always" | "never" | "tier-gated";
  tier: 0 | 1 | 2;
  /** 'hls-vtt' */
  preferredTextSubMode: "hls-vtt" | "burn-in";
  /** false -> ASS converts to VTT */
  preserveAssStyling: boolean;
  /** ['opus','aac'] filtered by device */
  audioTranscodeCodecPriority: ("opus" | "aac")[];
  /** tier-derived, overridable */
  maxSimultaneousTranscodes: number;
  /** instance ladder table (§7) */
  ladderRungs: LadderRung[];
  /** fixed v1 */
  segmentDurationSec: 6;
  /** true when caps verify hevc encode */
  hevcEncodePreferred: boolean;
}

// ---------------------------------------------------------------------------
// §2.5 VerifiedCapabilities (see docs/PLAYBACK.md §8 for how it is produced)
// ---------------------------------------------------------------------------

export type HardwareBackend =
  | "videotoolbox"
  | "qsv"
  | "vaapi"
  | "nvenc"
  | "amf"
  | "d3d11va"
  | "software";

export interface VerifiedBackendCapability {
  backend: HardwareBackend;
  decode: VideoCodec[];
  encode: ("h264" | "hevc" | "av1")[];
  toneMap: ("opencl" | "vulkan" | "videotoolbox" | "cuda" | "none")[];
  verifiedAtMs: number;
}

export interface VerifiedCapabilities {
  backends: VerifiedBackendCapability[];
}

// ---------------------------------------------------------------------------
// §2.6 TrackSelection (resolved by the session service BEFORE plan(); emits no
// reasons — it is input). Field shape: the stream index selected per kind,
// null when nothing is selected (e.g. no subtitle chosen).
// ---------------------------------------------------------------------------

export interface TrackSelection {
  videoStreamIndex: number | null;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number | null;
}

// ---------------------------------------------------------------------------
// §1 Function signature
// ---------------------------------------------------------------------------

export interface PlanInput {
  /** from media_files + media_streams rows */
  media: MediaInfo;
  /** client-declared, validated, cached on devices.profile */
  device: DeviceProfile;
  network: NetworkConditions;
  /** instance + per-user knobs, resolved by caller */
  policy: ServerPolicy;
  /** hardware self-test results snapshot */
  caps: VerifiedCapabilities;
  /** resolved BEFORE plan() (see §3.0) */
  selection: TrackSelection;
  /** download reserved: may emit 'remux' */
  mode: "stream" | "download";
}

// ---------------------------------------------------------------------------
// §7 Bitrate ladder
// ---------------------------------------------------------------------------

export interface LadderRung {
  heightPx: number;
  videoBitrateBps: number;
  audioBitrateBps: number;
  codec: "h264" | "hevc";
}

// ---------------------------------------------------------------------------
// §5 Output contract
// ---------------------------------------------------------------------------

export type PlanDecision = "direct-play" | "direct-stream" | "remux" | "transcode";

/**
 * Method used for HDR->SDR tone mapping. Backend preference per §8.3:
 * videotoolbox -> 'videotoolbox'; nvenc -> 'cuda'; qsv/vaapi -> 'opencl'
 * (else 'vulkan'); software -> 'cpu-zscale' only when policy allows it.
 */
export type ToneMapMethod = "opencl" | "vulkan" | "videotoolbox" | "cuda" | "cpu-zscale";

export interface PlaybackPlanVideo {
  action: "copy" | "transcode" | "none";
  targetCodec?: "h264" | "hevc";
  encoder?: HardwareBackend;
  toneMap?: ToneMapMethod;
}

export interface PlaybackPlanAudio {
  action: "copy" | "transcode" | "none";
  targetCodec?: AudioCodec;
  targetChannels?: number;
  targetBitrateBps?: number;
}

export type SubtitleStrategy = "none" | "embed" | "hls-vtt" | "burn-in";

export interface PlaybackPlanSubtitle {
  strategy: SubtitleStrategy;
  streamIndex?: number;
}

export interface PlaybackPlan {
  decision: PlanDecision;
  /** REQUIRED, may be [] only for direct-play */
  reasons: PlanReason[];
  container: "source" | "fmp4-hls" | "ts-hls" | "mp4";
  video: PlaybackPlanVideo;
  audio: PlaybackPlanAudio;
  subtitle: PlaybackPlanSubtitle;
  ladder: LadderRung[];
  /** tokens, not paths — see docs/PLAYBACK.md §6 */
  ffmpegArgs: string[];
  /** semver of the decision ruleset, for audit rows */
  engineVersion: string;
}
