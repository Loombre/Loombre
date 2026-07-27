// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Typed shapes for the probe pipeline.
 *
 * Two families of types live here:
 *  - `Raw*` types: a partial, defensive model of ffprobe's `-print_format
 *    json -show_format -show_streams -show_chapters` output. Only the
 *    fields extract.ts actually reads are typed; everything else ffprobe
 *    may emit is allowed through via index signatures so we never choke on
 *    build/version-specific extra keys.
 *  - The public `MediaInfo` family: docs/PLAYBACK.md §2.1, reproduced here
 *    VERBATIM as the extraction target. Do not add/remove/rename fields
 *    without a spec change — this is the exact contract playback-engine
 *    consumes.
 *
 * ffprobe JSON quirk (verified empirically against ffprobe 8.1.1, and true
 * of every ffprobe version in living memory): numeric-looking fields are
 * inconsistently typed. `width`, `height`, `level`, `channels` are real
 * JSON numbers; `duration`, `bit_rate`, `sample_rate`, `size` are always
 * JSON *strings* even though they hold numbers. The Raw types below follow
 * that split exactly so a TS compile error catches any drift.
 */

// ---------------------------------------------------------------------------
// Raw ffprobe JSON (input side)
// ---------------------------------------------------------------------------

export interface RawSideData {
  side_data_type?: string;
  // Dolby Vision (DOVI configuration record) fields, present when
  // side_data_type === "DOVI configuration record".
  dv_version_major?: number;
  dv_version_minor?: number;
  dv_profile?: number;
  dv_level?: number;
  rpu_present_flag?: number;
  el_present_flag?: number;
  bl_present_flag?: number;
  dv_bl_signal_compatibility_id?: number;
  [key: string]: unknown;
}

export interface RawDisposition {
  default?: number;
  forced?: number;
  [key: string]: unknown;
}

export interface RawTags {
  language?: string;
  [key: string]: unknown;
}

export interface RawStream {
  index: number;
  codec_name?: string;
  codec_type?: "video" | "audio" | "subtitle" | "attachment" | "data" | string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  field_order?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  channels?: number;
  sample_rate?: string;
  side_data_list?: RawSideData[];
  disposition?: RawDisposition;
  tags?: RawTags;
  [key: string]: unknown;
}

export interface RawFormat {
  filename?: string;
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  tags?: RawTags;
  [key: string]: unknown;
}

/** The full parsed JSON object ffprobe prints for
 * `-show_format -show_streams -show_chapters`. */
export interface RawProbeResult {
  streams?: RawStream[];
  format?: RawFormat;
  chapters?: unknown[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MediaInfo — docs/PLAYBACK.md §2.1, verbatim
// ---------------------------------------------------------------------------

// v1.1 widening (STATE.md H3, docs/PLAYBACK.md §2.1): asf/mpeg/flv/aac/aiff
// admit legacy-format ingestion (wmv/wma->asf, mpg/mpeg/vob->mpeg, flv, bare
// ADTS aac, aiff) — see apps/worker/src/probe/extract.ts's
// SIMPLE_CONTAINER_MAP for the format_name mapping and apps/worker/src/scan/
// parse/path-utils.ts for the extension sets this feeds.
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

export type VideoCodec =
  | "h264"
  | "hevc"
  | "av1"
  | "vp9"
  | "mpeg2"
  | "vc1"
  | "mpeg4"
  | "unknown";

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

export type SubtitleCodec =
  | "subrip"
  | "ass"
  | "webvtt"
  | "mov_text"
  | "pgs"
  | "vobsub"
  | "dvbsub"
  | "unknown";

export type HdrMode = "none" | "hdr10" | "hlg" | "dv";

export interface VideoStream {
  index: number;
  codec: VideoCodec;
  profile: string | null; // e.g. 'high', 'main10'
  level: number | null; // e.g. 41 for 4.1
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12;
  frameRate: number; // rational resolved to float, 3 decimals
  bitrateBps: number | null;
  hdr: HdrMode;
  dvProfile: number | null; // 5|7|8 when hdr==='dv'
  dvBlCompatId: number | null; // 8.1 HDR10-compatible base layer detection
  interlaced: boolean;
}

export interface AudioStream {
  index: number;
  codec: AudioCodec;
  channels: number;
  sampleRate: number;
  bitrateBps: number | null;
  language: string | null; // ISO 639-2
  isDefault: boolean;
  hasAtmos: boolean; // TrueHD/EAC3 JOC side data
}

export interface SubtitleStream {
  index: number;
  codec: SubtitleCodec;
  language: string | null;
  isForced: boolean;
  isDefault: boolean;
  isExternal: boolean;
  externalPath: string | null; // sidecar files, pre-resolved by caller
}

export interface MediaInfo {
  fileId: string;
  container: Container;
  durationMs: number;
  sizeBytes: number;
  overallBitrateBps: number; // size/duration derived if probe lacks it
  video: VideoStream[]; // may be empty (music)
  audio: AudioStream[];
  subtitle: SubtitleStream[];
}

/** Context supplied by the caller alongside the raw probe JSON.
 *
 * The task signature is `extractMediaInfo(rawProbeJson, {sizeBytes,
 * fileId})`; `filenameHint` is an ADDITIONAL optional field this module
 * introduces to resolve a real ambiguity ffprobe's `format_name` doesn't
 * settle on its own (see `resolveContainer` in extract.ts for the full
 * writeup): 'matroska,webm' covers both .mkv and .webm, and
 * 'mov,mp4,m4a,3gp,3g2,mj2' covers .mp4/.mov/.m4a. When the caller can
 * supply the original filename/path, pass its extension here for an exact
 * answer; when it can't (e.g. probing from a stream), extraction falls back
 * to codec-based heuristics documented alongside `resolveContainer`. */
export interface ExtractContext {
  sizeBytes: number;
  fileId: string;
  filenameHint?: string;
}
