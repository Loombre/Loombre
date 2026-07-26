// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure raw-ffprobe-JSON → MediaInfo extraction. No I/O, no process spawning
 * — mirrors packages/playback-engine's purity discipline (CLAUDE.md
 * invariant 2) even though this module lives in apps/worker: `plan()`
 * downstream depends on `MediaInfo` being exactly reproducible from the
 * same probe JSON, byte for byte, every time.
 *
 * Every non-obvious mapping rule is documented at its call site below,
 * with the empirical/spec source it was verified against. Where
 * docs/PLAYBACK.md §2.1 is ambiguous or under-specified, the resolution is
 * called out explicitly with "DECISION:" — the orchestrator should treat
 * those as flagged, not silently assumed.
 */

import { ProbeError } from "./errors.js";
import type {
  AudioCodec,
  AudioStream,
  Container,
  ExtractContext,
  HdrMode,
  MediaInfo,
  RawSideData,
  RawStream,
  SubtitleCodec,
  SubtitleStream,
  VideoCodec,
  VideoStream,
} from "./types.js";
import type { RawProbeResult } from "./types.js";

// ---------------------------------------------------------------------------
// small numeric/string helpers
// ---------------------------------------------------------------------------

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(value: string | number | undefined): number | null {
  const n = toNumber(value);
  return n === null ? null : Math.round(n);
}

/** Language tag normalization: ffprobe reports 'und' for genuinely unset
 * language tags (a real ISO 639-2 code, not an error), and sometimes omits
 * `tags.language` altogether. §2.1 says `language: string | null`, so both
 * cases collapse to null — 'und' is not information callers need to act on. */
function normalizeLanguage(language: string | undefined): string | null {
  if (!language) return null;
  const trimmed = language.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "und") return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// container
// ---------------------------------------------------------------------------

const SIMPLE_CONTAINER_MAP: Record<string, Container> = {
  mpegts: "ts",
  avi: "avi",
  flac: "flac",
  mp3: "mp3",
  ogg: "ogg",
  wav: "wav",
};

/**
 * Map ffprobe's `format.format_name` to the closed Container union.
 *
 * ffprobe reports format_name as a comma-separated list of format-probe
 * aliases for two container families, and BOTH are ambiguous against the
 * §2.1 Container union:
 *
 *  - `'matroska,webm'` covers both .mkv and .webm (verified: ffmpeg 8.1.1
 *    reports the identical string for an mkv-muxed h264/aac file and a
 *    webm-muxed vp9/opus file).
 *  - `'mov,mp4,m4a,3gp,3g2,mj2'` covers .mp4, .mov, AND .m4a (verified the
 *    same way — a plain mp4 mux and an m4a-suffixed audio-only mux report
 *    the identical format_name).
 *
 * DECISION (flagged — PLAYBACK.md only calls out the mkv/webm case, not
 * mp4/mov/m4a, and only prescribes "filename extension passed in or stream
 * heuristics" without picking one): this module tries, in order:
 *   1. `filenameHint` extension, when the caller supplies one (exact).
 *   2. `format.tags.major_brand`, for the mp4/mov/m4a family — verified
 *      empirically: real ffmpeg-muxed output tags 'qt  ' for .mov and
 *      'M4A ' for .m4a; anything else (isom, mp42, ...) defaults to mp4.
 *   3. Stream-codec heuristics, for the mkv/webm family — WebM's spec caps
 *      allowed codecs to {vp8,vp9,av1} video and {opus,vorbis} audio (plus
 *      webvtt text); if every present video/audio stream fits that set,
 *      classify as webm, else mkv (mkv is the container superset, so it's
 *      the safe default when heuristics can't prove webm).
 *   4. Falls back to 'mkv' / 'mp4' (the superset/most-common member of
 *      each ambiguous family) when nothing else disambiguates.
 */
function resolveContainer(raw: RawProbeResult, context: ExtractContext): Container {
  const formatName = raw.format?.format_name ?? "";
  const hint = context.filenameHint?.toLowerCase() ?? "";
  const extMatch = /\.([a-z0-9]+)$/.exec(hint);
  const ext = extMatch?.[1];

  if (formatName === "matroska,webm") {
    if (ext === "webm") return "webm";
    if (ext === "mkv" || ext === "mka" || ext === "mk3d") return "mkv";

    const streams = raw.streams ?? [];
    const videoStreams = streams.filter((s) => s.codec_type === "video");
    const audioStreams = streams.filter((s) => s.codec_type === "audio");
    const webmVideoCodecs = new Set(["vp8", "vp9", "av1"]);
    const webmAudioCodecs = new Set(["opus", "vorbis"]);
    const videoFitsWebm = videoStreams.every((s) => webmVideoCodecs.has(s.codec_name ?? ""));
    const audioFitsWebm = audioStreams.every((s) => webmAudioCodecs.has(s.codec_name ?? ""));
    if (videoFitsWebm && audioFitsWebm) return "webm";
    return "mkv";
  }

  if (formatName === "mov,mp4,m4a,3gp,3g2,mj2") {
    if (ext === "mov" || ext === "qt") return "mov";
    if (ext === "m4a") return "m4a";
    if (ext === "mp4" || ext === "m4v") return "mp4";

    const majorBrand = raw.format?.tags?.["major_brand"];
    if (majorBrand === "qt  ") return "mov";
    if (majorBrand === "M4A ") return "m4a";
    return "mp4";
  }

  const simple = SIMPLE_CONTAINER_MAP[formatName];
  if (simple) return simple;

  // Container is a closed union with no 'unknown' escape hatch (unlike the
  // codec unions, which all have one) — an unmappable format_name is a
  // hard extraction failure, not a silent guess.
  throw new ProbeError("unsupported-container", `unrecognized ffprobe format_name '${formatName}'`, {
    formatName,
  });
}

// ---------------------------------------------------------------------------
// video
// ---------------------------------------------------------------------------

const VIDEO_CODEC_MAP: Record<string, VideoCodec> = {
  h264: "h264",
  hevc: "hevc",
  av1: "av1",
  vp9: "vp9",
  mpeg2video: "mpeg2",
  vc1: "vc1",
  mpeg4: "mpeg4",
};

function mapVideoCodec(codecName: string | undefined): VideoCodec {
  return VIDEO_CODEC_MAP[codecName ?? ""] ?? "unknown";
}

/** VideoStream.profile normalization: §2.1 gives the examples 'high' and
 * 'main10' — but real ffprobe reports 'High' and 'Main 10' (space included).
 * DECISION (flagged): normalize by lowercasing AND stripping whitespace, so
 * 'High' -> 'high' and 'Main 10' -> 'main10' match the documented examples
 * exactly, rather than lowercasing alone (which would leave 'main 10'). */
function normalizeVideoProfile(profile: string | undefined): string | null {
  if (!profile) return null;
  const normalized = profile.toLowerCase().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

/** level: ffprobe reports the raw codec-spec level_idc integer, and the
 * "units" differ per codec (h264: level_idc IS level*10, e.g. 41 = 4.1;
 * HEVC: general_level_idc = level*30, e.g. 63 = 2.1 — verified by encoding
 * a real HEVC Main10 stream and reading back level:63 for a 2.1 profile).
 * DECISION (flagged): PLAYBACK.md's "41 for 4.1" example only documents
 * the h264 convention; converting per codec would require an undocumented
 * table PLAYBACK.md doesn't provide. We pass ffprobe's raw integer through
 * unchanged for every codec — ffprobe is the single source of truth for
 * what "level" means, we don't reinterpret it. -99 (ffprobe's "unknown"
 * sentinel, seen on vp9) and any other negative value map to null. */
function normalizeLevel(level: number | undefined): number | null {
  if (level === undefined || level < 0) return null;
  return level;
}

/** bitDepth: prefer `bits_per_raw_sample` (authoritative when present),
 * else parse the pix_fmt suffix (yuv420p -> 8, yuv420p10le -> 10,
 * yuv420p12le -> 12), else default 8. */
function resolveBitDepth(stream: RawStream): 8 | 10 | 12 {
  const raw = toIntOrNull(stream.bits_per_raw_sample);
  if (raw === 8 || raw === 10 || raw === 12) return raw;

  const pixFmt = stream.pix_fmt ?? "";
  const match = /p(\d+)(?:le|be)?$/.exec(pixFmt);
  if (match) {
    const depth = Number.parseInt(match[1]!, 10);
    if (depth === 8 || depth === 10 || depth === 12) return depth;
  }
  return 8;
}

/** frameRate: resolve a "num/den" rational to a float, 3 decimals.
 * r_frame_rate is preferred (constant-frame-rate signal); avg_frame_rate is
 * the fallback for variable-frame-rate sources where r_frame_rate degrades
 * to a coarse guess. "0/0" (audio-only / not applicable) -> 0. */
function resolveFrameRate(stream: RawStream): number {
  const parseRational = (value: string | undefined): number | null => {
    if (!value) return null;
    const [numStr, denStr] = value.split("/");
    const num = Number.parseFloat(numStr ?? "");
    const den = Number.parseFloat(denStr ?? "");
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    return num / den;
  };
  const rate = parseRational(stream.r_frame_rate) ?? parseRational(stream.avg_frame_rate) ?? 0;
  return Math.round(rate * 1000) / 1000;
}

/** Find the Dolby Vision configuration record in a stream's side_data_list,
 * if present. Field names (dv_profile, dv_bl_signal_compatibility_id, etc.)
 * are FFmpeg's own struct field names from libavutil's DOVI metadata
 * (AVDOVIDecoderConfigurationRecord) as printed by ffprobe.c's side-data
 * writer. FLAGGED: this repo has no local means of generating a real
 * Dolby-Vision-tagged file, so this shape could not be verified against a
 * live ffprobe run — it is reproduced from well-established, widely-
 * reproduced community references (FFmpeg source + real-world ffprobe
 * output examples cited in apps/worker/test/probe/fixtures/README.md).
 * Confirm against a real DV sample before this ships. */
function findDoviSideData(stream: RawStream): RawSideData | null {
  const list = stream.side_data_list ?? [];
  return list.find((sd) => sd.side_data_type === "DOVI configuration record") ?? null;
}

/**
 * hdr: DOVI side data takes priority over color_transfer (a DV profile 8
 * stream also carries an HDR10-compatible color_transfer=smpte2084, but
 * it's still hdr:'dv' — the DV metadata is the more specific classification
 * and Stage C in PLAYBACK.md §3 branches on dvProfile/dvBlCompatId first).
 * Otherwise color_transfer: smpte2084 -> hdr10, arib-std-b67 -> hlg, else
 * none. Both transfer names verified via ffmpeg's own `-h full` color_trc
 * option table. */
function resolveHdr(stream: RawStream, dovi: RawSideData | null): HdrMode {
  if (dovi) return "dv";
  if (stream.color_transfer === "smpte2084") return "hdr10";
  if (stream.color_transfer === "arib-std-b67") return "hlg";
  return "none";
}

const INTERLACED_FIELD_ORDERS = new Set(["tt", "bb", "tb", "bt"]);

function resolveInterlaced(stream: RawStream): boolean {
  return INTERLACED_FIELD_ORDERS.has(stream.field_order ?? "");
}

function extractVideoStream(stream: RawStream): VideoStream {
  const dovi = findDoviSideData(stream);
  return {
    index: stream.index,
    codec: mapVideoCodec(stream.codec_name),
    profile: normalizeVideoProfile(stream.profile),
    level: normalizeLevel(stream.level),
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    bitDepth: resolveBitDepth(stream),
    frameRate: resolveFrameRate(stream),
    bitrateBps: toIntOrNull(stream.bit_rate),
    hdr: resolveHdr(stream, dovi),
    dvProfile: dovi?.dv_profile ?? null,
    dvBlCompatId: dovi?.dv_bl_signal_compatibility_id ?? null,
    interlaced: resolveInterlaced(stream),
  };
}

// ---------------------------------------------------------------------------
// audio
// ---------------------------------------------------------------------------

const AUDIO_CODEC_MAP: Record<string, AudioCodec> = {
  aac: "aac",
  ac3: "ac3",
  eac3: "eac3",
  truehd: "truehd",
  dts: "dts", // refined to 'dtshd' below when the profile says so
  flac: "flac",
  opus: "opus",
  mp3: "mp3",
  vorbis: "vorbis",
};

/** DTS vs DTS-HD: ffprobe's `profile` field distinguishes them at the
 * codec_name==='dts' level ("DTS", "DTS-ES", "DTS 96/24", "DTS Express" are
 * plain DTS; "DTS-HD HRA", "DTS-HD MA", "DTS-HD MA + DTS:X" contain the
 * literal substring "DTS-HD"). Verified base case ("DTS") against a real
 * ffprobe run of the `dca` encoder; the DTS-HD variants are FFmpeg's own
 * profile name table (libavcodec/profiles.c ff_dts_profiles) and could not
 * be verified locally (no local DTS-HD MA sample) — flagged, same caveat
 * as the DOVI shape above. */
function mapAudioCodec(stream: RawStream): AudioCodec {
  const codecName = stream.codec_name ?? "";
  if (codecName.startsWith("pcm_") || codecName === "pcm") return "pcm";
  if (codecName === "dts") {
    return (stream.profile ?? "").includes("DTS-HD") ? "dtshd" : "dts";
  }
  return AUDIO_CODEC_MAP[codecName] ?? "unknown";
}

/**
 * hasAtmos: FFmpeg has first-class Atmos-aware profile names for exactly
 * the two codecs that carry Atmos as an FFmpeg-parseable bitstream flag:
 * TrueHD -> "Dolby TrueHD + Dolby Atmos" (FF_PROFILE_TRUEHD_ATMOS) and
 * E-AC-3 JOC -> "Dolby Digital Plus + Dolby Atmos" (FF_PROFILE_EAC3_DDP_ATMOS),
 * both from libavcodec/profiles.c. Detecting `profile.includes('Atmos')`
 * covers both without hard-coding either exact string. FLAGGED: this repo's
 * ffmpeg build cannot encode Atmos-flagged TrueHD or JOC E-AC-3 (both need
 * proprietary encoders), so this rule is verified against FFmpeg's source
 * profile tables, not a locally-probed real file — see fixtures/README.md.
 * A defensive secondary check also scans side_data_list for an entry whose
 * side_data_type mentions "Atmos", in case a future ffmpeg version moves
 * the signal there; this branch is speculative and unverified either way. */
function resolveHasAtmos(stream: RawStream, codec: AudioCodec): boolean {
  if (codec !== "truehd" && codec !== "eac3") return false;
  if ((stream.profile ?? "").includes("Atmos")) return true;
  const sideData = stream.side_data_list ?? [];
  return sideData.some((sd) => (sd.side_data_type ?? "").includes("Atmos"));
}

function extractAudioStream(stream: RawStream): AudioStream {
  const codec = mapAudioCodec(stream);
  return {
    index: stream.index,
    codec,
    channels: stream.channels ?? 0,
    sampleRate: toIntOrNull(stream.sample_rate) ?? 0,
    bitrateBps: toIntOrNull(stream.bit_rate),
    language: normalizeLanguage(stream.tags?.language),
    isDefault: stream.disposition?.default === 1,
    hasAtmos: resolveHasAtmos(stream, codec),
  };
}

// ---------------------------------------------------------------------------
// subtitle
// ---------------------------------------------------------------------------

/** ffprobe/FFmpeg use a single codec ID (AV_CODEC_ID_ASS) for both legacy
 * .ssa (SubStation Alpha) and modern .ass (Advanced SubStation Alpha)
 * inputs, and always reports codec_name 'ass' for it — verified by encoding
 * a real .srt -> ass-muxed mkv track and reading codec_name:'ass' back. The
 * literal 'ssa' is included defensively in case an older ffmpeg build ever
 * reports it, but was not observed locally. */
const SUBTITLE_CODEC_MAP: Record<string, SubtitleCodec> = {
  subrip: "subrip",
  ass: "ass",
  ssa: "ass",
  webvtt: "webvtt",
  mov_text: "mov_text",
  hdmv_pgs_subtitle: "pgs",
  dvd_subtitle: "vobsub",
  dvb_subtitle: "dvbsub",
};

function mapSubtitleCodec(codecName: string | undefined): SubtitleCodec {
  return SUBTITLE_CODEC_MAP[codecName ?? ""] ?? "unknown";
}

function extractSubtitleStream(stream: RawStream): SubtitleStream {
  return {
    index: stream.index,
    codec: mapSubtitleCodec(stream.codec_name),
    language: normalizeLanguage(stream.tags?.language),
    isForced: stream.disposition?.forced === 1,
    isDefault: stream.disposition?.default === 1,
    // Sidecar/external subtitle resolution is a caller concern (§2.1 note:
    // "pre-resolved by caller") — this layer only ever sees muxed streams.
    isExternal: false,
    externalPath: null,
  };
}

// ---------------------------------------------------------------------------
// top level
// ---------------------------------------------------------------------------

/** durationMs: format.duration is seconds as a decimal string; convert to
 * milliseconds and round (§2.1: "Milliseconds everywhere" per CLAUDE.md
 * invariant 5, and format.duration s->ms per the deliverable spec). */
function resolveDurationMs(raw: RawProbeResult): number {
  const seconds = toNumber(raw.format?.duration) ?? 0;
  return Math.round(seconds * 1000);
}

/** overallBitrateBps: prefer format.bit_rate when ffprobe reports one;
 * else derive size*8/duration per the §2.1 note. sizeBytes is always the
 * caller-supplied filesystem size (context.sizeBytes), not ffprobe's
 * format.size — see resolveContainer-adjacent DECISION notes for why
 * context is authoritative for on-disk facts ffprobe can only estimate. */
function resolveOverallBitrateBps(raw: RawProbeResult, sizeBytes: number, durationMs: number): number {
  const reported = toIntOrNull(raw.format?.bit_rate);
  if (reported !== null && reported > 0) return reported;
  if (durationMs <= 0) return 0;
  return Math.round((sizeBytes * 8) / (durationMs / 1000));
}

function byIndex<T extends { index: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.index - b.index);
}

/**
 * Pure extraction: raw ffprobe JSON + caller context -> typed MediaInfo,
 * exactly matching docs/PLAYBACK.md §2.1. No I/O. Streams with
 * codec_type 'attachment' or 'data' are skipped entirely (cover art,
 * embedded fonts, timed metadata — none of which are playable tracks).
 * Video/audio/subtitle arrays are sorted by their original ffprobe stream
 * index for deterministic ordering, independent of ffprobe's own emission
 * order (which is stable in practice but not contractually guaranteed).
 */
export function extractMediaInfo(rawProbeJson: RawProbeResult, context: ExtractContext): MediaInfo {
  const streams = rawProbeJson.streams ?? [];

  const video = byIndex(
    streams.filter((s) => s.codec_type === "video").map((s) => extractVideoStream(s)),
  );
  const audio = byIndex(
    streams.filter((s) => s.codec_type === "audio").map((s) => extractAudioStream(s)),
  );
  const subtitle = byIndex(
    streams.filter((s) => s.codec_type === "subtitle").map((s) => extractSubtitleStream(s)),
  );

  const durationMs = resolveDurationMs(rawProbeJson);

  return {
    fileId: context.fileId,
    container: resolveContainer(rawProbeJson, context),
    durationMs,
    sizeBytes: context.sizeBytes,
    overallBitrateBps: resolveOverallBitrateBps(rawProbeJson, context.sizeBytes, durationMs),
    video,
    audio,
    subtitle,
  };
}
