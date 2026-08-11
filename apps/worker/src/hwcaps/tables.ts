// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ffmpeg-invocation constants for the self-test battery. Several of these
 * tables are literal copies of packages/playback-engine/src/args/
 * builder.ts's own backend tables (HWACCEL_BY_BACKEND, VIDEO_ENCODER_NAMES,
 * TONE_MAP_FILTERS) — copied, not imported (this step's binding constraint
 * 8 forbids a dependency on packages/playback-engine), and extended where
 * the self-test battery needs coverage builder.ts doesn't (av1 encode
 * names; the hwaccel-decode pixel-format "did it really engage hardware"
 * markers; which tone-map methods are even candidates per backend).
 *
 * REAL-HARDWARE FINDINGS THAT SHAPED THIS FILE (macOS/M3 Max, ffmpeg
 * 8.1.1, homebrew), in the order they were discovered:
 *
 * (1) A bare `ffmpeg -hwaccel videotoolbox -i <file> -an -f null -` exits 0
 *     with the correct frame count for h264/hevc/av1/vp9 alike, but
 *     verbose-log inspection showed only h264 CONSISTENTLY engaged real
 *     VideoToolbox decode (`pixfmt:videotoolbox_vld`) — hevc/av1/vp9
 *     landed on `nv12`/`p010le` (software) NON-DETERMINISTICALLY, with no
 *     error printed at all, across otherwise-identical repeated runs.
 *     Root cause (2) below; a frame-count-only assertion would have
 *     reported an unstable, sometimes-false pass for all three.
 * (2) The root cause: `-hwaccel <name>` alone is only a HINT. When the
 *     sink doesn't care about pixel format (`-f null -`), ffmpeg's own
 *     heuristics may decide it's not worth keeping frames on the hardware
 *     surface and quietly decode on the CPU instead — a real ffmpeg
 *     optimization decision, not a fixed per-codec capability gap. Adding
 *     `-hwaccel_output_format <marker>` (HWACCEL_OUTPUT_FORMAT_BY_BACKEND
 *     below) FORCES the frame to stay on the hardware surface end to end;
 *     verified empirically to make hevc/av1/vp9 engage videotoolbox
 *     reliably and repeatedly once forced (this M3 Max's media engine
 *     really does support all four for decode) — buildDecodeTestArgs now
 *     always passes it, not just the tone-map filter chain.
 * (3) mpeg2, unlike the above, genuinely fails hardware decode even WITH
 *     the output-format flag forced: `VideoToolbox decoder for this format
 *     not found` / `Failed setup for format videotoolbox_vld: hwaccel
 *     initialisation returned error` — and that exact failure message
 *     contains the marker SUBSTRING despite being a failure, which a naive
 *     `stderr.includes(marker)` check would misread as a pass. See
 *     battery.ts's hwaccelGenuinelyEngaged() for the precise-pattern fix.
 *
 * Net effect on this box: h264/hevc/av1/vp9 all genuinely hardware-decode
 * via videotoolbox; mpeg2 correctly does not. This is exactly the "driver
 * marketing is not capability" failure mode docs/PLAYBACK.md §0 law 4
 * warns about, caught at two different layers of subtlety by the very
 * self-test meant to catch it.
 */
import type { HwBackend, ProbeEncodeCodec, TestableToneMapMethod } from './types.js';

/** Segment-2-style decode accel token per backend (mirrors builder.ts's
 *  HWACCEL_BY_BACKEND exactly). `software` contributes no `-hwaccel` flag
 *  at all — plain CPU decode. */
export const HWACCEL_BY_BACKEND: Partial<Record<HwBackend, string>> = {
  videotoolbox: 'videotoolbox',
  nvenc: 'cuda',
  qsv: 'qsv',
  vaapi: 'vaapi',
  amf: 'd3d11va',
  d3d11va: 'd3d11va',
};

/** `-hwaccel_output_format` value — REQUIRED (not optional) for both the
 *  plain decode test AND the tone-map filter chain, per this file's header
 *  finding (2): without it, ffmpeg may silently decode on the CPU even
 *  when hardware decode genuinely works, making the decode test's result
 *  depend on ffmpeg's sink-shape heuristics rather than on hardware
 *  capability. Verified empirically for videotoolbox on this box
 *  (`videotoolbox_vld`); the rest are the documented, conventional ffmpeg
 *  names for each hwaccel and are NOT independently verified on real
 *  cuda/qsv/vaapi hardware by this lane (STATE.md P3.4: Linux/Windows
 *  real-hardware verification is a post-exit owner checklist item).
 */
export const HWACCEL_OUTPUT_FORMAT_BY_BACKEND: Partial<Record<HwBackend, string>> = {
  videotoolbox: 'videotoolbox_vld',
  nvenc: 'cuda',
  qsv: 'qsv',
  vaapi: 'vaapi',
};

/**
 * Substring that appears in `ffmpeg -loglevel verbose` stderr's
 * "Reinit context to WxH, pix_fmt: <fmt>" line ONLY when the decoder
 * genuinely produced hardware-surface frames — i.e. the hwaccel actually
 * engaged, as opposed to a silent software fallback that still exits 0
 * with a correct frame count. `software` has no entry (there is nothing to
 * "engage" — plain CPU decode always counts as itself).
 */
export const HWACCEL_PIXFMT_MARKER: Partial<Record<HwBackend, string>> = {
  videotoolbox: 'videotoolbox_vld',
  nvenc: 'cuda',
  qsv: 'qsv',
  vaapi: 'vaapi',
  amf: 'd3d11',
  d3d11va: 'd3d11',
};

/** Segment-7-style video encoder name per backend x target codec — mirrors
 *  packages/playback-engine/src/args/builder.ts's VIDEO_ENCODER_NAMES
 *  verbatim, av1 column included.
 *
 *  The `av1` column was originally a FORWARD-LOOKING capability check here
 *  (§2.5's VerifiedBackendCapability['encode'] has always included 'av1'
 *  while the ladder could not target it) — the recorded C8 probe/ladder
 *  inconsistency. Wave C1 / LD-7 closes it from the other side: the ladder
 *  now targets av1 (docs/PLAYBACK.md §7.1) gated on exactly the facts this
 *  battery produces (§7.2/§7.3), and builder.ts's own table gained the
 *  matching column. The two tables are now mirrors again in full.
 *
 *  `videotoolbox` has no `av1` key at all, and that absence is now
 *  LOAD-BEARING rather than incidental: ffmpeg has no `av1_videotoolbox`
 *  encoder on any macOS release (verified: absent from `ffmpeg -encoders`
 *  on this M3 Max, ffmpeg 8.1.1) and no Apple Silicon generation has AV1
 *  encode hardware, so the battery skips it by construction (untested ->
 *  absent) rather than by a failed spawn — which is what makes the §7.2
 *  Tier-0 refusal path REALLY verifiable on this project's own hardware.
 *  `d3d11va` has no entries at all (decode-only per §8.2).
 *
 *  `software` deliberately carries NO av1 entry: its name is resolved
 *  dynamically, and since D4 (§7.3) the ENCODE test accepts `libsvtav1`
 *  ONLY — see args.ts's resolveEncoderName.
 */
export const VIDEO_ENCODER_NAMES: Partial<Record<HwBackend, Partial<Record<ProbeEncodeCodec, string>>>> = {
  software: { h264: 'libx264', hevc: 'libx265' /* av1 resolved dynamically — see args.ts's resolveEncoderName (D4: libsvtav1 only) */ },
  videotoolbox: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' },
  nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
  qsv: { h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv' },
  vaapi: { h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi' },
  amf: { h264: 'h264_amf', hevc: 'hevc_amf', av1: 'av1_amf' },
};

/** Software encoder used to synthesize each decode-test codec's tiny 2s
 *  source clip (binding constraint 2(a): "encode ... with a SOFTWARE
 *  encoder first when available — feature-detect; skip codec if
 *  unencodable locally"). `av1` has no single fixed name — resolved
 *  dynamically (libsvtav1 preferred, else libaom-av1), matching scripts/
 *  gen-media-fixtures.mjs's own preference order. */
export const SOFTWARE_DECODE_SOURCE_ENCODER: Partial<Record<'h264' | 'hevc' | 'vp9' | 'mpeg2', string>> = {
  h264: 'libx264',
  hevc: 'libx265',
  vp9: 'libvpx-vp9',
  mpeg2: 'mpeg2video',
};

/** Tone-map filter string per method — copied verbatim from builder.ts's
 *  TONE_MAP_FILTERS ('cpu-zscale' omitted: software is never a tone-map
 *  candidate in this battery, see TONE_MAP_CANDIDATES_BY_BACKEND's header
 *  note). Verified empirically end-to-end on this box for 'videotoolbox'
 *  (real decode -> scale_vt -> h264_videotoolbox -> ffprobe color_transfer
 *  == bt709). 'cuda'/'opencl'/'vulkan' are NOT independently verified by
 *  this lane (no such hardware present — STATE.md P3.4). */
export const TONE_MAP_FILTERS: Record<TestableToneMapMethod, string> = {
  cuda: 'tonemap_cuda=format=yuv420p:tonemap=hable',
  opencl: 'tonemap_opencl=format=yuv420p:tonemap=hable',
  vulkan: 'libplacebo=tonemapping=hable:format=yuv420p',
  videotoolbox: 'scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709',
};

/**
 * Tone-map METHOD candidates per backend (docs/PLAYBACK.md §8.3's
 * preference table, tested as candidates rather than assumed): videotool-
 * box -> videotoolbox only; nvenc -> cuda only; qsv/vaapi -> BOTH opencl
 * and vulkan (the table's own "opencl(else vulkan)" clause means both are
 * plausible per-box outcomes, so the battery tests both and records
 * whichever verify — matching the qsv-opencl / qsv-vulkan-only fixture
 * pair in packages/playback-engine/matrix/fixtures/caps.yaml).
 *
 * `software` is deliberately ABSENT (not merely empty): §2.5's
 * `VerifiedBackendCapability['toneMap']` type has NO 'cpu-zscale' member
 * (only 'opencl'|'vulkan'|'videotoolbox'|'cuda'|'none') and every existing
 * caps.yaml fixture — including every software-only one — pins software's
 * toneMap to `[]`. CPU tone-mapping is gated purely by
 * `ServerPolicy.allowToneMapCpu` (docs/PLAYBACK.md §3 Stage C /
 * `ToneMapMethod`'s 'cpu-zscale' member on the PLAN side, a different type
 * from VerifiedBackendCapability's), not by a hardware self-test — ffmpeg's
 * `zscale` filter ships in every bundled build, so there is nothing this
 * battery could meaningfully self-test for software; §8.1's "software's
 * cpu-zscale chain" language is satisfied by policy gating alone. `amf`
 * and `d3d11va` are also absent: §8.3's method table names no tone-map
 * method for either.
 */
export const TONE_MAP_CANDIDATES_BY_BACKEND: Partial<Record<HwBackend, readonly TestableToneMapMethod[]>> = {
  videotoolbox: ['videotoolbox'],
  nvenc: ['cuda'],
  qsv: ['opencl', 'vulkan'],
  vaapi: ['opencl', 'vulkan'],
};

/** Fixed synthetic-source parameters shared by every decode-test source
 *  and the HDR10 tone-map source — 2 seconds at 25fps => 50 frames exactly
 *  (deterministic; verified empirically that a real 2s/25fps lavfi
 *  encode->decode round-trip yields exactly 50 on this box for every
 *  codec tried). */
export const TEST_CLIP_RATE = 25;
export const TEST_CLIP_DURATION_SEC = 2;
export const EXPECTED_DECODE_FRAME_COUNT = TEST_CLIP_RATE * TEST_CLIP_DURATION_SEC;
