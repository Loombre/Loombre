// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/master-playlist.ts
//
// The §9.1.1 MASTER playlist: one `#EXT-X-STREAM-INF` per rung of the
// session's stored plan, whose variant URIs are `v{K}/media.m3u8` with K =
// the rung's index in `plan.ladder`.
//
// PURE, AND THAT IS THE POINT. It reads the stored plan and the probed
// MediaInfo and returns a string — no filesystem, no worker, no clock, no
// db handle. Two consequences the contract depends on:
//
//   1. The route NEVER 503s (§9.1.2 item 1). Unlike the media playlist,
//      which cannot exist until ffmpeg has produced a segment, a master
//      playlist is fully determined the moment the session row exists. A
//      client can therefore attach immediately and start its own retry
//      cycle against the VARIANT playlist, where the 503/Retry-After
//      contract already lives.
//   2. It cannot melt a Tier-0 box. CLAUDE.md invariant 9 (request paths do
//      no CPU-heavy work) is satisfied structurally: this is string
//      assembly over an array of at most six rungs.
//
// WHY VARIANT IDENTITY LIVES ONLY IN THE URL: every `v{K}/media.m3u8`
// serves the SAME served-playlist bytes, and its relative segment URIs
// resolve to `v{K}/runN/sNNNNNN.m4s` against the same on-disk files. There
// is one pipeline and one playlist; the `v{K}` prefix is a signal to the
// server, not a different resource. RFC 8216's cross-variant obligations
// (matching media sequence numbers, discontinuity structure, timelines) are
// therefore met trivially — the variants ARE one playlist.
//
// EXECUTION FENCE ON `CODECS` (§9.1.1, stated here because this is where
// the strings are written): a wrong CODECS string does not fail loudly. MSE
// simply reports the variant unsupported and hls.js silently drops it, so a
// one-hex-digit drift degrades quality with no error anywhere. The table
// below is therefore pinned by full-text goldens
// (master-playlist.spec.ts) AND checked against ffprobe of REAL encoder
// output by apps/worker/test/transcode/codecs-string-fence.integration.spec.ts.
// Goldens alone can only prove this file is self-consistent.

import { scaledWidthForHeight } from "@loombre/playback-engine";

/** The rungs of the stored plan's ladder, structurally (declared locally so
 *  this module needs no engine type import beyond the shared helper). */
export interface MasterPlaylistRung {
  heightPx: number;
  videoBitrateBps: number;
  audioBitrateBps: number;
  codec: "h264" | "hevc" | "av1";
}

/** The probed SOURCE video facts. `codec` is only consulted for the
 *  ladder-empty (copy) master — an encoded rung states its own codec. */
export interface MasterVideoFacts {
  widthPx: number;
  heightPx: number;
  frameRate: number;
  bitDepth: number;
  codec: string;
}

/** The audio the client will actually RECEIVE: the plan's target codec on
 *  an audio transcode, the probed source codec on a copy. */
export interface MasterAudioFacts {
  codec: string;
  bitrateBps: number | null;
}

export interface MasterPlaylistInput {
  ladder: readonly MasterPlaylistRung[];
  video: MasterVideoFacts | null;
  audio: MasterAudioFacts | null;
  /** Whole-file bitrate — the ladder-empty COPY master's BANDWIDTH basis. */
  overallBitrateBps: number | null;
}

/**
 * §9.1.1: "BANDWIDTH = ceil(1.1 x (videoBitrateBps + audioBitrateBps))".
 * CEILED, never truncated: BANDWIDTH is the PEAK a client must sustain, and
 * an under-stated peak is the direction that causes rebuffering.
 *
 * Applied as `x11/10` rather than `x1.1` deliberately. `3_160_000 * 1.1`
 * is 3476000.0000000005 in IEEE-754, so `Math.ceil` would return 3476001 —
 * a value that is correct-ish but arbitrary, would differ from the number
 * any reviewer computes by hand, and would silently change if the rung
 * table ever moved. Integer arithmetic gives the exact 3476000.
 */
function withHeadroom(totalBps: number): number {
  return Math.ceil((totalBps * 11) / 10);
}

/**
 * H.264 level, as the single hex byte an `avc1.PPCCLL` string carries,
 * keyed by the rung's height. §6's encode block emits `-level` from the
 * DEVICE's own cap rather than from the rung, so there is no single number
 * to copy from the args; a height table is the deterministic answer, and it
 * is chosen to be the level the encoder's own output really carries for a
 * stream of that size at these bitrates (execution-fenced).
 */
const H264_LEVEL_BY_HEIGHT: readonly { maxHeight: number; level: number }[] = [
  { maxHeight: 480, level: 0x1e }, // 3.0
  { maxHeight: 720, level: 0x1f }, // 3.1
  { maxHeight: 1080, level: 0x28 }, // 4.0
  { maxHeight: Number.POSITIVE_INFINITY, level: 0x33 }, // 5.1
];

/** HEVC `general_level_idc`, which is level x 30 (so 4.0 -> 120). */
const HEVC_LEVEL_BY_HEIGHT: readonly { maxHeight: number; level: number }[] = [
  { maxHeight: 480, level: 90 }, // 3.0
  { maxHeight: 720, level: 93 }, // 3.1
  { maxHeight: 1080, level: 120 }, // 4.0
  { maxHeight: Number.POSITIVE_INFINITY, level: 153 }, // 5.1
];

/** AV1 `seq_level_idx` (0 = 2.0 ... 8 = 4.0 ... 13 = 5.1). §6 interp. M
 *  emits NO `-level` for av1 at all — AV1's ordinals do not correspond to
 *  H.264/HEVC decimal levels and a device profile's av1 entry declares
 *  `maxLevel: null` — so this table is the ONLY source for the field. */
const AV1_LEVEL_BY_HEIGHT: readonly { maxHeight: number; level: number }[] = [
  { maxHeight: 480, level: 4 }, // 3.0
  { maxHeight: 720, level: 5 }, // 3.1
  { maxHeight: 1080, level: 8 }, // 4.0
  { maxHeight: Number.POSITIVE_INFINITY, level: 13 }, // 5.1
];

function levelFor(table: readonly { maxHeight: number; level: number }[], heightPx: number): number {
  for (const row of table) {
    if (heightPx <= row.maxHeight) return row.level;
  }
  return table[table.length - 1]!.level;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * The RFC 6381 codec string for an ENCODED rung, keyed by (rung codec, bit
 * depth) exactly as §9.1.1 specifies. Bit depth is load-bearing, not
 * cosmetic: a 10-bit stream advertised as 8-bit High/Main is accepted by a
 * decoder that then cannot play it, and a 10-bit-capable client shown an
 * 8-bit-profile string may reject a variant it could have played.
 */
function encodedVideoCodecString(rung: MasterPlaylistRung, bitDepth: number): string {
  switch (rung.codec) {
    case "h264": {
      // profile_idc: High (0x64) / High10 (0x6e); constraint byte 0x00.
      const profile = bitDepth >= 10 ? 0x6e : 0x64;
      return `avc1.${hex2(profile)}00${hex2(levelFor(H264_LEVEL_BY_HEIGHT, rung.heightPx))}`;
    }
    case "hevc": {
      // `hvc1` (not `hev1`) to match §6's own `-tag:v hvc1`: the sample
      // entry the muxer writes and the string the master advertises must
      // name the same thing.
      const profileSpace = bitDepth >= 10 ? "2.4" : "1.6";
      return `hvc1.${profileSpace}.L${levelFor(HEVC_LEVEL_BY_HEIGHT, rung.heightPx)}.B0`;
    }
    case "av1": {
      // av01.<profile>.<level><tier>.<bitDepth>: profile 0 (Main), Main
      // tier ("M"), depth as two digits.
      const level = String(levelFor(AV1_LEVEL_BY_HEIGHT, rung.heightPx)).padStart(2, "0");
      return `av01.0.${level}M.${bitDepth >= 10 ? "10" : "08"}`;
    }
  }
}

/**
 * The codec string for a COPIED source stream (the ladder-empty master).
 * Anything not in this table returns `undefined` and the attribute is
 * simply OMITTED — an absent CODECS is legal (the client just does not
 * pre-filter) whereas a WRONG one makes the client drop a variant it can
 * play. Never guess.
 */
function sourceVideoCodecString(codec: string, bitDepth: number): string | undefined {
  switch (codec) {
    case "h264":
      return `avc1.${bitDepth >= 10 ? "6e" : "64"}0028`;
    case "hevc":
      return `hvc1.${bitDepth >= 10 ? "2.4" : "1.6"}.L120.B0`;
    case "av1":
      return `av01.0.08M.${bitDepth >= 10 ? "10" : "08"}`;
    case "vp9":
      // vp09.<profile>.<level>.<bitDepth>; profile 0 is 8-bit 4:2:0,
      // profile 2 is 10-bit.
      return `vp09.${bitDepth >= 10 ? "02" : "00"}.10.${bitDepth >= 10 ? "10" : "08"}`;
    default:
      return undefined;
  }
}

function audioCodecString(codec: string): string | undefined {
  switch (codec) {
    case "aac":
      return "mp4a.40.2";
    case "opus":
      return "opus";
    case "ac3":
      return "ac-3";
    case "eac3":
      return "ec-3";
    case "flac":
      return "fLaC";
    case "mp3":
      return "mp4a.40.34";
    default:
      return undefined;
  }
}

/** RFC 8216 §4.3.4.2 wants a decimal-floating-point FRAME-RATE; trailing
 *  zeros carry no information and 23.976/59.94 must survive intact. */
function formatFrameRate(frameRate: number): string | undefined {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return undefined;
  return String(Number(frameRate.toFixed(3)));
}

function positiveOrUndefined(n: number | null | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

interface VariantLine {
  bandwidthBps: number;
  averageBandwidthBps: number;
  codecs: string | undefined;
  resolution: string | undefined;
  frameRate: string | undefined;
}

function streamInfLine(v: VariantLine): string {
  const attrs = [`BANDWIDTH=${v.bandwidthBps}`, `AVERAGE-BANDWIDTH=${v.averageBandwidthBps}`];
  if (v.codecs) attrs.push(`CODECS="${v.codecs}"`);
  if (v.resolution) attrs.push(`RESOLUTION=${v.resolution}`);
  if (v.frameRate) attrs.push(`FRAME-RATE=${v.frameRate}`);
  return `#EXT-X-STREAM-INF:${attrs.join(",")}`;
}

/**
 * Renders the master playlist for one session. TOTAL: every branch degrades
 * to "omit the attribute" rather than throwing, because §9.1.2 item 1 says
 * this route never 503s and a throw would become a 500 — strictly worse
 * than a master that states less than it could.
 */
export function renderMasterPlaylist(input: MasterPlaylistInput): string {
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    // §9.1.1: rung switches restart the pipeline at a segment boundary and
    // §6's `-force_key_frames` opens every segment of an encoded run with an
    // IDR, so every segment really is independently decodable.
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];

  const audioCodec = input.audio ? audioCodecString(input.audio.codec) : undefined;
  const frameRate = input.video ? formatFrameRate(input.video.frameRate) : undefined;

  if (input.ladder.length > 0) {
    const bitDepth = input.video?.bitDepth ?? 8;
    input.ladder.forEach((rung, index) => {
      const total = Math.max(0, rung.videoBitrateBps) + Math.max(0, rung.audioBitrateBps);
      const videoCodec = encodedVideoCodecString(rung, bitDepth);
      const widthPx = input.video
        ? scaledWidthForHeight(input.video.widthPx, input.video.heightPx, rung.heightPx)
        : undefined;
      // An unscaled rung reports the rung's height only when the source is
      // genuinely that tall; above the source height nothing is upscaled,
      // so the SOURCE dimensions are what the encoder emits.
      const heightPx = input.video ? Math.min(rung.heightPx, input.video.heightPx) : undefined;
      lines.push(
        streamInfLine({
          bandwidthBps: withHeadroom(total),
          averageBandwidthBps: total,
          codecs: [videoCodec, audioCodec].filter(Boolean).join(",") || undefined,
          resolution:
            positiveOrUndefined(widthPx) !== undefined && positiveOrUndefined(heightPx) !== undefined
              ? `${widthPx}x${heightPx}`
              : undefined,
          frameRate,
        }),
      );
      lines.push(`v${index}/media.m3u8`);
    });
    return `${lines.join("\n")}\n`;
  }

  // Ladder-empty (§9.1.1): direct-stream copy and audio-only transcode both
  // still get a master, so `manifestUrl` points at master.m3u8 for EVERY
  // HLS session (owner-decision V5 — one client path, no branch).
  const audioBitrate = positiveOrUndefined(input.audio?.bitrateBps) ?? 0;
  const total = positiveOrUndefined(input.overallBitrateBps) ?? audioBitrate;
  const videoCodec = input.video ? sourceVideoCodecString(input.video.codec, input.video.bitDepth) : undefined;
  const width = positiveOrUndefined(input.video?.widthPx);
  const height = positiveOrUndefined(input.video?.heightPx);
  lines.push(
    streamInfLine({
      bandwidthBps: withHeadroom(total),
      averageBandwidthBps: total,
      codecs: [videoCodec, audioCodec].filter(Boolean).join(",") || undefined,
      // No RESOLUTION at all when there is no video (audio-only transcode).
      resolution: width !== undefined && height !== undefined ? `${width}x${height}` : undefined,
      frameRate,
    }),
  );
  lines.push("v0/media.m3u8");
  return `${lines.join("\n")}\n`;
}
