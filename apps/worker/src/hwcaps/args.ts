// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure ffmpeg argv construction for every self-test in the battery. No I/O
 * — every function here just returns a `string[]`, handed to the injected
 * `CommandRunner`. Kept separate from battery.ts's orchestration/
 * interpretation logic so each argv shape is independently unit-testable.
 *
 * The HDR10 synthetic-source recipe (buildHdrSourceArgs) is NOT the naive
 * "-color_primaries/-color_trc/-colorspace as plain output flags" approach
 * scripts/gen-media-fixtures.mjs uses for its own grid_*_hdr10 fixtures —
 * verified empirically (this box, ffmpeg 8.1.1) that those three flags are
 * silently dropped to "unknown" by an auto-inserted swscale colorspace-
 * negotiation step even though `-colorspace` itself survives (asymmetric,
 * reproducible on the repo's OWN existing grid_mkv_hevc_10bit_hdr10_p.mkv
 * fixture — its color_transfer/color_primaries are absent from ffprobe's
 * output despite the generator passing those exact flags: a pre-existing,
 * previously-unverified gap in that generator, surfaced as a side effect
 * of building this battery, reported per this step's "surprises"
 * instruction). The `zscale=tin=...:t=...:pin=...:p=...` relabel-only
 * filter form (input assumptions == output targets, so zscale performs an
 * identity transform rather than a real conversion) reliably tags the
 * stream: confirmed via `ffprobe` on the resulting file
 * (color_transfer=smpte2084, color_primaries=bt2020, color_space=bt2020nc).
 */
import { TEST_CLIP_DURATION_SEC, TEST_CLIP_RATE } from "./tables.js";
import {
  HWACCEL_BY_BACKEND,
  HWACCEL_OUTPUT_FORMAT_BY_BACKEND,
  SOFTWARE_DECODE_SOURCE_ENCODER,
  TONE_MAP_FILTERS,
  VIDEO_ENCODER_NAMES,
} from "./tables.js";
import type { HwBackend, ProbeEncodeCodec, ProbeVideoCodec, TestableToneMapMethod } from "./types.js";

const LAVFI_TESTSRC = `testsrc2=size=320x240:rate=${TEST_CLIP_RATE}:duration=${TEST_CLIP_DURATION_SEC}`;
const LAVFI_TESTSRC_10BIT = `${LAVFI_TESTSRC},format=yuv420p10le`;

/** The ONE software AV1 encoder the plan's arg builder will ever name
 *  (packages/playback-engine/src/args/builder.ts's VIDEO_ENCODER_NAMES,
 *  docs/PLAYBACK.md §6 interpretation M). Kept as a named constant so the
 *  D4 narrowing below is visibly tied to that fact rather than to taste. */
const BUILDER_SOFTWARE_AV1_ENCODER = "libsvtav1";

/** libsvtav1 preferred (faster) over libaom-av1, matching scripts/
 *  gen-media-fixtures.mjs's own AV1 preference order. `null` when neither
 *  is present in the resolved ffmpeg's `-encoders` listing.
 *
 *  SCOPE NARROWED by owner-decision D4 (docs/PLAYBACK.md §7.3, Wave C1):
 *  this resolver now serves the DECODE-source generation path ONLY. The
 *  software av1 ENCODE capability test goes through
 *  `resolveEncoderName` below, which accepts libsvtav1 and nothing else.
 *  The preference order here stands unchanged for its remaining consumer:
 *  generating a 2-second av1 clip to decode-test against cares about
 *  availability, not speed, and names no builder encoder. */
export function resolveSoftwareAv1Encoder(encoders: ReadonlySet<string>): string | null {
  if (encoders.has(BUILDER_SOFTWARE_AV1_ENCODER)) return BUILDER_SOFTWARE_AV1_ENCODER;
  if (encoders.has("libaom-av1")) return "libaom-av1";
  return null;
}

/** The software encoder used to synthesize `codec`'s decode-test source, or
 *  `null` when unavailable locally — binding constraint 2(a): "skip codec
 *  if unencodable locally, recorded as untested->absent". */
export function resolveDecodeSourceEncoder(codec: ProbeVideoCodec, encoders: ReadonlySet<string>): string | null {
  if (codec === "av1") return resolveSoftwareAv1Encoder(encoders);
  const name = SOFTWARE_DECODE_SOURCE_ENCODER[codec as "h264" | "hevc" | "vp9" | "mpeg2"];
  if (!name) return null; // vc1/mpeg4/unknown are never decode-test targets (DECODE_TEST_CODECS)
  return encoders.has(name) ? name : null;
}

/** The encoder name for `backend`'s attempt at encoding `codec`, or `null`
 *  when that (backend, codec) pair has no table entry OR the resolved
 *  ffmpeg doesn't actually list the encoder (avoids spawning a call that's
 *  certain to fail with "Unknown encoder"). */
export function resolveEncoderName(
  backend: HwBackend,
  codec: ProbeEncodeCodec,
  encoders: ReadonlySet<string>
): string | null {
  // D4 (docs/PLAYBACK.md §7.3, Wave C1): SOFTWARE av1 encode capability is
  // `libsvtav1` and nothing else — a box carrying only `libaom-av1` reports
  // software-av1 encode ABSENT, and the §7.2 eligibility gate then refuses
  // AV1 there at every tier. Two reasons, one of them structural:
  //  - libaom's realtime presets are not a viable streaming encoder; and
  //  - the plan's arg builder emits ONE FIXED encoder name for a software
  //    av1 target (BUILDER_SOFTWARE_AV1_ENCODER), so probe-verifying the
  //    exact encoder the builder will spawn is the same
  //    probe-proves-the-shipped-plumbing rule the tone-map battery already
  //    follows. A capability the builder cannot deterministically name is
  //    not a capability — reporting it would hand a Tier-1 plan an encoder
  //    name nothing on that machine has.
  // Costless on shipped builds: every vendored ffmpeg compiles
  // --enable-libsvtav1 (linux-x64 / linux-arm64 / macos-arm64 verified
  // 2026-08-11; windows-x64 pending the CI leg, STATE.md P3.4).
  if (backend === "software" && codec === "av1") {
    return encoders.has(BUILDER_SOFTWARE_AV1_ENCODER) ? BUILDER_SOFTWARE_AV1_ENCODER : null;
  }
  const name = VIDEO_ENCODER_NAMES[backend]?.[codec];
  if (!name) return null;
  return encoders.has(name) ? name : null;
}

function extensionForDecodeSource(codec: ProbeVideoCodec): string {
  switch (codec) {
    case "h264":
    case "hevc":
      return "mp4";
    case "av1":
      return "mkv";
    case "vp9":
      return "webm";
    case "mpeg2":
      return "ts";
    default:
      return "mkv";
  }
}

/** File extension for `hwcaps/args.ts`'s decode-test source outputs — used
 *  by callers building the output path (battery.ts owns path joining; this
 *  module only decides the extension so the muxer matches the codec). */
export { extensionForDecodeSource };

/** (a) decode test, source-generation half: encode a tiny 2s clip of
 *  `codec` via `encoderName` (already resolved+feature-checked by the
 *  caller). av1 uses a 10-bit source (matches this lane's own real-machine
 *  verification); every other codec is 8-bit. */
export function buildDecodeSourceArgs(codec: ProbeVideoCodec, encoderName: string): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"];
  args.push("-i", codec === "av1" ? LAVFI_TESTSRC_10BIT : LAVFI_TESTSRC);
  args.push("-c:v", encoderName);
  if (codec === "h264" || codec === "hevc") {
    args.push("-preset", "ultrafast", "-pix_fmt", "yuv420p");
  } else if (codec === "av1") {
    args.push(...(encoderName === "libsvtav1" ? ["-preset", "12"] : ["-cpu-used", "8"]));
  } else if (codec === "vp9") {
    args.push("-b:v", "200k");
  }
  if (codec === "mpeg2") args.push("-f", "mpegts");
  return args;
}

/** (a) decode test, decode half: `-hwaccel <flag>` (omitted for `software`)
 *  against the already-generated source, decoded to `/dev/null`-equivalent
 *  with `-loglevel verbose` so the caller can both parse the final
 *  `frame=` count AND grep for the backend's hardware pixel-format marker
 *  (tables.ts's HWACCEL_PIXFMT_MARKER — the "did it really engage
 *  hardware, or silently fall back to software" check this box's own real
 *  testing showed is NECESSARY, not paranoid).
 *
 * CRITICAL real-machine finding this recipe encodes (macOS/M3 Max, ffmpeg
 * 8.1.1): a bare `-hwaccel videotoolbox` with no explicit output-format
 * request is only a HINT — when the sink is `-f null -` (nothing
 * downstream needs the frame in any particular format), ffmpeg's own
 * heuristics frequently decide NOT to bother keeping the decode on the
 * VideoToolbox surface and silently decode on the CPU instead (no error,
 * no log line even hinting at it — exit 0, correct frame count, `pixfmt:
 * nv12`/`p010le` instead of `videotoolbox_vld`). This reproduced
 * NON-DETERMINISTICALLY for hevc/av1/vp9 across otherwise-identical
 * back-to-back runs while h264 consistently engaged — i.e. this is a real
 * ffmpeg optimization decision, not a fixed per-codec capability gap.
 * Passing `-hwaccel_output_format <marker>` explicitly (the SAME table
 * `buildToneMapArgs` already needed) FORCES the decoder to keep frames on
 * the hardware surface end to end — verified empirically to make hevc/
 * av1/vp9 all engage videotoolbox reliably and repeatedly once forced,
 * while mpeg2 (genuinely unsupported: `VideoToolbox decoder for this
 * format not found`) still correctly falls back to software every time.
 * Omitting this flag would make the self-test's own result depend on
 * ffmpeg's sink-shape optimization heuristics rather than on the hardware
 * capability it's supposed to be verifying — exactly the "driver
 * marketing is not capability" trap docs/PLAYBACK.md §0 law 4 warns
 * about, just one level more subtle than a bare frame-count check catches. */
export function buildDecodeTestArgs(backend: HwBackend, sourcePath: string): string[] {
  const args = ["-hide_banner", "-loglevel", "verbose"];
  const hwaccel = HWACCEL_BY_BACKEND[backend];
  if (hwaccel) args.push("-hwaccel", hwaccel);
  const outputFormat = HWACCEL_OUTPUT_FORMAT_BY_BACKEND[backend];
  if (outputFormat) args.push("-hwaccel_output_format", outputFormat);
  args.push("-i", sourcePath, "-an", "-f", "null", "-");
  return args;
}

function extensionForEncodeTest(codec: ProbeEncodeCodec): string {
  return codec === "av1" ? "mkv" : "mp4";
}
export { extensionForEncodeTest };

/** (b) encode test: encode straight from a fresh lavfi source via
 *  `encoderName` (already resolved+feature-checked by the caller) —
 *  binding constraint 2(b) needs no decode step first, just "re-probe the
 *  output ... assert codec identity". */
export function buildEncodeTestArgs(backend: HwBackend, codec: ProbeEncodeCodec, encoderName: string): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", LAVFI_TESTSRC, "-c:v", encoderName];
  if (backend === "software") {
    if (codec === "av1") {
      args.push(...(encoderName === "libsvtav1" ? ["-preset", "12"] : ["-cpu-used", "8"]));
    } else {
      args.push("-preset", "ultrafast");
    }
  } else {
    args.push("-b:v", "1000k");
  }
  return args;
}

/** (c) tone-map test, HDR10 synthetic-source generation (once per battery
 *  run, shared across every backend's candidate methods) — see this
 *  module's header for why the zscale relabel-only filter is used instead
 *  of plain output-flag tagging. */
export function buildHdrSourceArgs(): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    LAVFI_TESTSRC_10BIT,
    "-vf",
    "zscale=tin=smpte2084:t=smpte2084:pin=bt2020:p=bt2020:min=bt2020nc:m=bt2020nc:range=limited",
    "-c:v",
    "libx265",
    "-pix_fmt",
    "yuv420p10le",
    "-preset",
    "ultrafast",
  ];
}

/** (c) tone-map test: decode the HDR10 source (staying on the hardware
 *  surface via `-hwaccel_output_format` when the backend needs it — the
 *  same reason segment established live on this box: `scale_vt` requires
 *  `videotoolbox_vld` frames, not software `p010le` ones), apply the
 *  method's filter, then re-encode with the SAME backend's own h264
 *  encoder (real pipelines never bounce hw frames through a software
 *  encoder mid-chain, docs/PLAYBACK.md §8.3's "stay on one device" rule —
 *  falls back to libx264 only for a backend with no h264 table entry at
 *  all, which never actually happens for any backend that has tone-map
 *  candidates in the first place). */
export function buildToneMapArgs(backend: HwBackend, method: TestableToneMapMethod, hdrSourcePath: string): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const hwaccel = HWACCEL_BY_BACKEND[backend];
  if (hwaccel) args.push("-hwaccel", hwaccel);
  const outputFormat = HWACCEL_OUTPUT_FORMAT_BY_BACKEND[backend];
  if (outputFormat) args.push("-hwaccel_output_format", outputFormat);
  args.push("-i", hdrSourcePath, "-vf", TONE_MAP_FILTERS[method]);
  const verifyEncoder = VIDEO_ENCODER_NAMES[backend]?.h264 ?? "libx264";
  args.push("-c:v", verifyEncoder);
  args.push(...(verifyEncoder === "libx264" ? ["-preset", "ultrafast"] : ["-b:v", "1000k"]));
  return args;
}

/** `ffmpeg -hide_banner -encoders` — feature-detection source list for
 *  every resolve* function above (battery.ts's real wiring parses this
 *  once at the top of a run, mirroring scripts/gen-media-fixtures.mjs's
 *  own `listEncoders`). */
export function buildListEncodersArgs(): string[] {
  return ["-hide_banner", "-encoders"];
}

/** Parses `ffmpeg -encoders` stdout into the set of registered encoder
 *  names — identical parsing rule to scripts/gen-media-fixtures.mjs's
 *  listEncoders(). */
export function parseEncoderNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}
