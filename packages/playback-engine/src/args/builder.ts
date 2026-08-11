// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `buildFfmpegArgs()` — the deterministic ffmpeg argument builder
 * (docs/PLAYBACK.md §6, Phase 3 §11 step 4). Pure function: no I/O, no
 * framework imports, no clock (docs/PLAYBACK.md §0 law 1) — identical
 * inputs produce a byte-identical `string[]`, always.
 *
 * ---------------------------------------------------------------------------
 * SIGNATURE DESIGN (this step's binding instruction 1 — "design the exact
 * signature so BOTH plan() (default args) and the future session layer
 * (per-rung, per-seek regeneration) can call it"):
 *
 *   buildFfmpegArgs(input: PlanInput, planShape: FfmpegPlanShape,
 *                    options: BuildFfmpegArgsOptions): string[]
 *
 * `input` supplies the facts the builder needs that `plan()` already had on
 * hand (`media`, `device`, `selection`) — the builder reads ONLY
 * `input.media`, `input.selection`, and `input.device.video` (for the level
 * cap, binding interpretation 9 below); `network`/`policy`/`caps`/`mode` are
 * part of `PlanInput`'s shape but irrelevant to arg construction (every
 * decision they influence — codec choice, encoder, tone-map method, ladder
 * membership — is already baked into `planShape` by the time this runs).
 *
 * `planShape` is deliberately NOT the full `PlaybackPlan` — it is exactly
 * the subset of §5 fields the args depend on (`container`, `video`, `audio`,
 * `subtitle`), PLUS a `rung` field that has no direct §5 analogue: each
 * ladder rung is its own lazily-started pipeline (§7), so a SINGLE
 * `PlaybackPlan.ladder` array is not enough to build one ffmpeg invocation —
 * the caller must say WHICH rung this particular invocation targets.
 * `plan()`'s own default-args call passes the TOP surviving rung (matching
 * `video.targetCodec`, per this step's BIND — see `plan.ts`'s own assembly
 * comment); the future session layer passes whichever rung it is actually
 * starting (the initially-selected rung, or an ABR sibling-rung switch
 * starting the same file at a different quality).
 *
 * `options.withSeek` (binding instruction 2): the session layer's
 * seek-restart regenerates args with `withSeek: true` (adds `-ss
 * {SEEK_SECONDS}` before `-i`); `plan()`'s own default-args call always
 * passes `withSeek: false`. BIND (this step's instruction 2, quoted): "plan-
 * default args include `-start_number {START_SEG}` always (the token is
 * substituted 0 at session start) and OMIT `-ss` entirely when withSeek
 * false" — so `-start_number {START_SEG}` is UNCONDITIONAL in segment 9,
 * never gated on `withSeek`; only `-ss` (segment 3) is.
 *
 * ---------------------------------------------------------------------------
 * TOKENS are the closed five-name set (docs/PLAYBACK.md §6): `{INPUT}`,
 * `{SESSION_DIR}`, `{SEEK_SECONDS}`, `{START_SEG}`, `{SEG_DUR}`. This module
 * never emits any other `{...}` form — `builder.spec.ts`'s token-closure
 * test asserts every emitted arg containing `{` matches exactly one of
 * these five, embedded or standalone.
 *
 * ---------------------------------------------------------------------------
 * INTERPRETATIONS APPLIED (reported per this step's instructions — every one
 * a candidate docs/PLAYBACK.md §6 clarification, not a silent choice):
 *
 * (A) VIDEO MAP REDIRECT WHEN A FILTERGRAPH APPLIES. §6 lists segment 5
 *     ("-map 0:v:{n} -map 0:a:{n}") and segment 6 (the conditional
 *     `-filter_complex`) as if independent, but taking both literally would
 *     map the RAW (unfiltered) video stream for encoding while the
 *     filtergraph's own output pad went unused — the deinterlace/scale/
 *     tonemap/burn-in work would silently have no effect. This module
 *     instead: when a filtergraph applies to video (any of deinterlace,
 *     scale, tonemap, or subtitle-overlay burn-in fires), OMITS the plain
 *     `-map 0:v:{n}` from segment 5 and instead appends `-map`, `[vout]`
 *     immediately after the `-filter_complex` argument (segment 6) — the
 *     filtered stream is what actually gets encoded. Audio's (and an embed
 *     subtitle's) segment-5 maps are never affected by this — only video's.
 *
 * (B) FILTERGRAPH SHAPE (deterministic, token-free, fixed two-label
 *     discipline — this step's instruction 5). Chain built in the EXACT §6
 *     order (deinterlace -> scale -> tonemap), starting from the
 *     TYPE-RELATIVE input pad `[0:v:{n}]` (never a bare `[0:v]` — the same
 *     type-relative-indexing correctness rule segment 5's mapping already
 *     has to honor, instruction 4):
 *       - no subtitle overlay: `[0:v:{n}]FILTER1,FILTER2,...[vout]` (a
 *         single label, `[vout]`, when there is no overlay stage — omitted
 *         entirely, of course, when the chain has zero filters AND no
 *         overlay, i.e. `hasFilterGraph` is false and this function never
 *         runs at all).
 *       - subtitle overlay ALSO required: the linear chain (if non-empty)
 *         closes into an INTERMEDIATE label `[vfilt]`, then a second
 *         statement composites the overlay input onto it: `[0:v:{n}]
 *         FILTER1,FILTER2[vfilt];[vfilt]{OVERLAY_INPUT}overlay[vout]`. When
 *         the linear chain is EMPTY (pure burn-in, nothing else to filter),
 *         the intermediate label is skipped entirely (nothing to name) and
 *         the overlay consumes the raw input pad directly:
 *         `[0:v:{n}]{OVERLAY_INPUT}overlay[vout]`.
 *     Exactly two fixed literal labels are ever used (`[vfilt]`, `[vout]`) —
 *     never a dynamic/counted name — satisfying "label discipline:
 *     deterministic labels only".
 *
 *     VAAPI BURN-IN EXCEPTION (step 7b fix F4 — docs/PLAYBACK.md §8.3,
 *     verbatim: "Decode/encode stay on one device (no hw→sw→hw bounces)
 *     except when the filtergraph requires download (subtitle burn-in on
 *     vaapi: hwdownload → overlay → hwupload, exactly once)"): when the
 *     plan's `video.encoder` is `'vaapi'` AND the graph includes a
 *     subtitle-burn-in overlay, the chain wraps the overlay in EXACTLY ONE
 *     download/upload round-trip — vaapi decode surfaces frames in GPU
 *     memory, and ffmpeg's software `overlay` filter cannot composite onto
 *     them without an explicit download. The EXACT deterministic graph:
 *       `[0:v:{n}]hwdownload,format=nv12[,LINEAR FILTERS][vfilt];
 *        [vfilt]{OVERLAY_INPUT}overlay,hwupload[vout]`
 *     i.e. `hwdownload,format=nv12` is PREPENDED to the linear chain
 *     (which therefore is never empty on this route — the pure-burn-in
 *     no-`[vfilt]` shortcut above never applies to vaapi burn-in), every
 *     linear filter (deinterlace/scale/tonemap, same fixed order) and the
 *     overlay run on system memory inside the download window, and a
 *     single `hwupload` immediately after `overlay` returns the composited
 *     frames to the vaapi device for encode. One `hwdownload`, one
 *     `hwupload`, always — "exactly once". The same two fixed labels
 *     (`[vfilt]`, `[vout]`) are reused; no new label is introduced.
 *     Non-vaapi backends (and vaapi WITHOUT burn-in) are completely
 *     unchanged (goldens 01-25 byte-identical); goldens 26 (embedded PGS)
 *     and 27 (external SRT) pin the two vaapi burn-in graphs.
 *
 * (C) OVERLAY INPUT PAD — embedded vs external (this step's own "design the
 *     exact deterministic graph" instruction, resolving the prompt's own
 *     tentative "external uses [1:v]?"): an embedded (internal) burn-in
 *     subtitle overlays `[0:s:{n}]` (type-relative subtitle index within
 *     input 0), exactly as the prompt states. An EXTERNAL sidecar is fed to
 *     ffmpeg as a SECOND INPUT via `-i {SUBTITLE_SIDECAR}` (segment 4) — a
 *     standalone `.srt`/`.ass` sidecar file has no VIDEO stream at all, only
 *     a single subtitle stream, so referencing it as `[1:v]` (the prompt's
 *     tentative guess) would be meaningless; this module instead overlays
 *     `[1:s:0]` (input-1's own subtitle stream, always index 0 within a
 *     single-stream sidecar file — there is nothing else in it to be
 *     type-relative AGAINST). Reported as the resolution of the prompt's own
 *     open question, not a silent pick.
 *
 * (D) HARDWARE TONE-MAP ROUTES (Phase 3 step-7 owner-smoke REAL-EXECUTION
 *     FIX — supersedes this interpretation's original "the hw tone-map
 *     filter occupies the tonemap chain position inside a software chain"
 *     reading, which FAILED on real ffmpeg 8.1.1/macOS M3 Max: `scale_vt`
 *     is a HARDWARE filter requiring `videotoolbox_vld` frames, but a plain
 *     `-hwaccel videotoolbox` decode auto-downloads frames to system
 *     memory, so ffmpeg's auto-scale tried sw -> videotoolbox_vld
 *     conversion, hit "Error reinitializing filters!" -> -78 (Function not
 *     implemented) -> encoder never opened, nothing written). The rule is
 *     BACKEND-AGNOSTIC: `tonemap_cuda`/`tonemap_opencl`/`libplacebo` are
 *     hardware filters for exactly the same reason `scale_vt` is, and
 *     `-hwaccel <name>` alone is only a HINT on every backend (apps/worker/
 *     src/hwcaps/tables.ts's real-hardware finding (2), stated
 *     backend-agnostically there). Two routes, selected whenever
 *     `video.toneMap` is one of the HARDWARE methods §8.3 pairs with
 *     `video.encoder` (HW_TONE_MAP_METHODS_BY_BACKEND below — the pairing
 *     is checked defensively; Stage G never produces any other pair):
 *
 *     (a) PURE-HW ROUTE — no software-only filter needed (no deinterlace,
 *         no burn-in overlay; a rung downscale does NOT disqualify): segment
 *         2 gains `-hwaccel_output_format <backend format>` after `-hwaccel
 *         <backend>`, forcing decoded frames to STAY on that device's
 *         surface (§8.3 "decode/encode stay on one device") — the SAME flag,
 *         from the SAME table, that apps/worker/src/hwcaps's step-5 battery
 *         passes when it VERIFIES a tone-map method, so the graph this
 *         builder emits is the graph the probe proved (the VT failure above
 *         was exactly this divergence: the probe passed because IT built a
 *         correct chain). NOTE videotoolbox's value is ffmpeg's PIXEL FORMAT
 *         name `videotoolbox_vld` — plain `videotoolbox` is REJECTED by
 *         ffmpeg 8.1.1 ("Unrecognised hwaccel output format"), verified on
 *         this box. A rung downscale then also stays on the device: for
 *         videotoolbox `scale_vt` performs BOTH the tone-map AND the
 *         downscale in one hw step (`scale_vt=w=-2:h={H}:color_matrix=
 *         bt709:...` — §8.3's "VT tone-maps in the scaler", now literally),
 *         and every other backend takes its OWN hw scaler in §6's scale
 *         position (`scale_cuda`/`scale_qsv`/`scale_vaapi`,
 *         HW_SCALE_FILTER_BY_BACKEND below) ahead of its tone-map filter.
 *         No software `scale`, no hw<->sw bounce anywhere. Real-verified
 *         end-to-end for videotoolbox on this machine (exit 0, segments
 *         written, ffprobe color_transfer=bt709) by apps/worker/test/
 *         transcode/vt-tonemap-args.integration.spec.ts; cuda/qsv/vaapi
 *         remain UNEXECUTED against real ffmpeg (STATE.md P3.4's Linux/
 *         Windows owner checklist) — this fix makes their graphs match the
 *         probe's, it does not substitute for running them.
 *
 *     (b) HYBRID FALLBACK — a software-only filter (yadif deinterlace and/
 *         or burn-in overlay) is ALSO required: keep the plain `-hwaccel
 *         <backend>` (no output_format; frames auto-download to system
 *         memory once, at the decoder boundary), run the ENTIRE §6 chain in
 *         software with the documented cpu-zscale tone-map string in the
 *         tonemap position (NO hw tone-map filter — none of them take sw
 *         frames), and still ENCODE on the hw backend (h264_/hevc_
 *         videotoolbox accept software frames — real-verified on this box;
 *         the vaapi burn-in graph's own `hwupload` (interpretation B) is
 *         what returns frames to that device). SURFACED §8.3 TENSION
 *         (reported, not silently resolved): §8.3's "exactly one download/
 *         upload" burn-in exception cannot compose with §6's fixed filter
 *         order — yadif must run PRE-scale (§6 order) but the hw tone-map
 *         works on hw frames, so a chain honoring both would need
 *         hwdownload -> yadif -> hwupload -> tone-map -> (overlay would need
 *         a SECOND download) — two bounces, violating the one-bounce rule.
 *         The hybrid drops to one clean sw window instead (decode-download
 *         once, sw filters, hw encode): correct-for-the-common-case, zero
 *         bounces inside the graph. Goldens 28/32 pin this graph.
 *
 * (E) EMBED SUBTITLE CODEC-COPY PLACEMENT (this step's instruction 4,
 *     verbatim BIND: "sub codec copy flag lives at the END of segment 8
 *     (audio block), before output"): `-c:s`, `copy` is appended after the
 *     audio block's own flags (copy or transcode), not adjacent to the
 *     `-map 0:s:{n}` line in segment 5. Applied only for `subtitle.strategy
 *     === 'embed'` — burn-in never emits a `-c:s` flag (the subtitle is
 *     composited into the video, not muxed as its own track); `hls-vtt` and
 *     `none` contribute nothing to these args at all (docs/PLAYBACK.md §11
 *     step 4 architecture note: side-track VTT delivery is session-layer).
 *
 * (F) REMUX OUTPUT SHAPE (this step's BIND, verbatim): remux (§3's
 *     progressive-file download mode) has no §6 output shape of its own —
 *     segment 9 becomes `-movflags +faststart -f mp4
 *     {SESSION_DIR}/download.mp4`, reusing the `{SESSION_DIR}` token.
 *     Reported as an interpretation / candidate §6 addition.
 *
 * (G) SEGMENT-TYPE FILE EXTENSION (this step's instruction 8): §6's literal
 *     `-hls_segment_filename {SESSION_DIR}/s%06d.m4s` is fmp4-specific
 *     despite being written unconditionally — this module emits `.m4s` only
 *     for `container === 'fmp4-hls'` and `.ts` for `container === 'ts-hls'`,
 *     matching `-hls_segment_type`'s own fmp4/mpegts split.
 *     `-hls_fmp4_init_filename init.mp4` is likewise fmp4-only.
 *
 * (H) GOP FRAME RATE SOURCE: `-g {2×fps}` uses the SELECTED SOURCE video
 *     stream's OWN `frameRate` (§2.1) — §6 names no `-r` (output frame-rate)
 *     flag anywhere, so the encode is assumed to preserve the source's rate
 *     unchanged; there is no OTHER frame-rate value available to compute a
 *     GOP size from. `Math.round(frameRate * 2)` (e.g. 59.94 -> 119.88 ->
 *     120) is pinned by this package's dedicated GOP-rounding golden.
 *
 * (I) LEVEL CAP SOURCE (this step's instruction 6): "the DEVICE entry for
 *     the target codec" is read as `input.device.video` (the same array
 *     every OTHER stage already reads device capability from) — found by
 *     matching `video.targetCodec` (the ENCODE target, which by construction
 *     the device must have a capability entry for, since Stage G/the ladder
 *     never targets a codec the device can't ultimately play). `-level` is
 *     emitted only when that entry's `maxLevel` is non-null.
 *
 * (J) SOURCE-STREAM-ABSENT DEFENSIVE BEHAVIOR: mirrors every `stages/*.ts`
 *     module's "selection doesn't resolve to a real stream" branch — this
 *     function is a lower-level utility (not `plan()` itself), so rather
 *     than `plan()`'s TOTAL-never-throws law, an internally-INCONSISTENT
 *     `planShape` (e.g. `video.action === 'transcode'` with no resolvable
 *     video stream, or a `'transcode'` shape missing `rung`/`encoder`/
 *     `targetCodec`) throws a descriptive `Error` — every one of these is a
 *     contract the CALLER (`plan.ts`, or the future session layer) is
 *     responsible for upholding, never reachable through `plan()` itself
 *     (proven by this package's totality property and matrix burn-up).
 *
 * (K) OPEN-GOP HEVC SEEK-RESTART STRIP (decided + ffmpeg-verified 2026-08-10
 *     owner QA, docs/PLAYBACK.md §6): segment 7's video-COPY branch pushes
 *     `-bsf:v filter_units=remove_types=8-9` iff `video.openGop &&
 *     options.withSeek && (container === 'fmp4-hls' || container ===
 *     'ts-hls')`. EVIDENCE (reproduced, not theoretical): a seek-restart
 *     runs of an open-GOP HEVC stream COPY begin the new run at a CRA
 *     (Clean Random Access) picture whose leading RASL pictures (HEVC NAL
 *     unit types 8/9 — RASL_N/RASL_R) reference the PRIOR GOP, which is
 *     absent from a seek-restarted run (the seek target lands mid-stream,
 *     not at file start) — Chrome/MSE renders those referenceless RASL
 *     pictures as a full-frame smear at the segment join. Stripping them via
 *     `filter_units=remove_types=8-9` yields a run whose first decodable
 *     picture is the CRA itself: it re-decodes cleanly. CORRECTED SCOPE
 *     (opus review Finding E, 2026-08-10 — the text above originally
 *     understated this): a `-bsf:v` is a PER-INVOCATION filter, not a
 *     per-join one — once pushed, it applies to EVERY packet ffmpeg
 *     processes for the rest of THIS invocation, not only the ~20
 *     leading-picture frames at the seek join. So every GOP for the
 *     remainder of the seek-restarted run loses its own RASL leading
 *     pictures each time it starts, not just the first one — a small,
 *     PERSISTENT per-GOP frame drop (roughly `bframes` frames per keyframe
 *     interval) for the rest of that run, not a one-time join cost.
 *     ACCEPTED TRADE-OFF (owner decision, 2026-08-10): this persistent
 *     minor frame drop is traded against the alternative — a multi-second
 *     full-frame decode smear at the seek join from undecodable
 *     referenceless RASL pictures — and judged the better failure mode;
 *     flagged for owner QA re-verification of long post-seek playback
 *     before rc.7. `withSeek: false` runs are BYTE-IDENTICAL to before this
 *     fix — a fresh (non-seek) run always starts at the file's own true IDR,
 *     which carries no RASL pictures referencing anything absent, so there
 *     is nothing to strip. Goldens 33 (withSeek:true, bsf present) / 34
 *     (withSeek:false, bsf absent) pin both sides — behaviour is UNCHANGED
 *     by this correction, only the documented understanding of its scope.
 */
import type {
  AudioCodec,
  DeviceProfile,
  HardwareBackend,
  LadderRung,
  PlaybackPlanAudio,
  PlaybackPlanSubtitle,
  PlaybackPlanVideo,
  PlanInput,
  ToneMapMethod,
} from "../types.js";

/**
 * The subset of §5 `PlaybackPlan` fields ffmpeg-argument construction
 * depends on, plus the rung this specific invocation targets (see this
 * module's header — a `PlaybackPlan.ladder` array alone can't say which
 * lazily-started rung a given invocation is for).
 */
export interface FfmpegPlanShape {
  container: "source" | "fmp4-hls" | "ts-hls" | "mp4";
  video: PlaybackPlanVideo;
  audio: PlaybackPlanAudio;
  subtitle: PlaybackPlanSubtitle;
  /** Required iff `video.action === 'transcode'` — the ladder rung THIS
   *  invocation encodes to. `plan()`'s own default-args call passes the top
   *  surviving rung; the session layer passes whichever rung it starts. */
  rung?: LadderRung;
}

export interface BuildFfmpegArgsOptions {
  /** true: session-layer seek-restart regeneration (adds `-ss
   *  {SEEK_SECONDS}` before `-i`). false: `plan()`'s own default args (no
   *  `-ss`, but `-start_number {START_SEG}` is still always present — this
   *  step's BIND). */
  withSeek: boolean;
}

// ---------------------------------------------------------------------------
// §8.3 backend tables (interpretations — reported per this step's instructions)
// ---------------------------------------------------------------------------

/** Segment 2 decode-accel flag value per backend (this step's instruction
 *  3's BIND table). `software` (and any backend absent from this table)
 *  contributes NOTHING — decode stays on CPU, no `-hwaccel` flag at all. */
const HWACCEL_BY_BACKEND: Partial<Record<HardwareBackend, string>> = {
  videotoolbox: "videotoolbox",
  nvenc: "cuda",
  qsv: "qsv",
  vaapi: "vaapi",
  amf: "d3d11va",
  d3d11va: "d3d11va",
};

/** Segment 7 encoder name per backend x target codec (this step's
 *  instruction 6's BIND table). `d3d11va` is decode-only (§8.2) and can
 *  never be `video.encoder` (Stage G never selects it as one — this
 *  module's own defensive guard below still names it explicitly rather than
 *  silently falling through).
 *
 *  C8 (an upstream media server-study audit, tracked not pruned): keyed only to
 *  `"h264" | "hevc"` — deliberately, today. apps/worker/src/hwcaps/
 *  tables.ts's mirror `VIDEO_ENCODER_NAMES` DOES verify av1 encode capability
 *  (its own header explains why: a forward-looking capability check even
 *  though the ladder never targets it), so hwprobe can report a box as
 *  AV1-encode-capable with no way for a plan to ever act on that fact — a
 *  real probe/ladder inconsistency, not a bug in either table alone. This
 *  is intentional under LD-7/LD-16 (STATE.md, an upstream media server-study implementation
 *  run): AV1 targeting lands in Wave C1 (LadderCodec enum +
 *  VideoAction.targetCodec contract additions, encoder tables + DB CHECK +
 *  TS unions as one coordinated change, matrix/goldens same PR) — that PR
 *  is where this table gains its `av1` column, not a prune here. */
const VIDEO_ENCODER_NAMES: Partial<Record<HardwareBackend, Record<"h264" | "hevc", string>>> = {
  software: { h264: "libx264", hevc: "libx265" },
  videotoolbox: { h264: "h264_videotoolbox", hevc: "hevc_videotoolbox" },
  nvenc: { h264: "h264_nvenc", hevc: "hevc_nvenc" },
  qsv: { h264: "h264_qsv", hevc: "hevc_qsv" },
  vaapi: { h264: "h264_vaapi", hevc: "hevc_vaapi" },
  amf: { h264: "h264_amf", hevc: "hevc_amf" },
};

/** scale_vt's bt709 tone-map parameters (interpretation D route (a)) —
 *  shared between the bare form (no rung downscale) and the folded
 *  `w=-2:h={H}:` form (scale_vt performs the downscale AND the tone-map in
 *  one hw step). Real-verified on ffmpeg 8.1.1/macOS. */
const VT_TONE_MAP_PARAMS = "color_matrix=bt709:color_primaries=bt709:color_transfer=bt709";

/** Segment 2's `-hwaccel_output_format` value per backend for route (a) —
 *  ffmpeg's PIXEL FORMAT name for that backend's hw surfaces. Mirrors
 *  apps/worker/src/hwcaps/tables.ts's HWACCEL_OUTPUT_FORMAT_BY_BACKEND
 *  (copied, not imported — this package stays dependency-free), which is
 *  the SAME table the step-5 capability battery pins the surface with when
 *  it VERIFIES a tone-map method: whatever plumbing proved the method is
 *  the plumbing this builder must reproduce, or a "verified" method ships
 *  a graph nothing ever executed. `videotoolbox_vld` is real-verified on
 *  this box — plain `videotoolbox` is REJECTED by ffmpeg 8.1.1
 *  ("Unrecognised hwaccel output format"). Backends absent from this table
 *  (amf, d3d11va, software) have no hw tone-map method in §8.3 and so
 *  never reach route (a) at all. */
const HWACCEL_OUTPUT_FORMAT_BY_BACKEND: Partial<Record<HardwareBackend, string>> = {
  videotoolbox: "videotoolbox_vld",
  nvenc: "cuda",
  qsv: "qsv",
  vaapi: "vaapi",
};

/** §8.3's tone-map preference table (mirrors stages/hardware.ts's
 *  HW_TONE_MAP_PREFERENCE): which METHODS Stage G may ever pair with which
 *  encoder backend. Read here ONLY to recognise a coherent HARDWARE
 *  tone-map route — an incoherent shape (a method this backend cannot run)
 *  falls through to the generic, unpinned path rather than forcing an
 *  output format its tone-map filter can't consume. */
const HW_TONE_MAP_METHODS_BY_BACKEND: Partial<Record<HardwareBackend, readonly ToneMapMethod[]>> = {
  videotoolbox: ["videotoolbox"],
  nvenc: ["cuda"],
  qsv: ["opencl", "vulkan"],
  vaapi: ["opencl", "vulkan"],
};

/** The backend's OWN hardware scaler, occupying §6's scale position on
 *  route (a) (interpretation D): once the decode surface is pinned, the
 *  software `scale` filter cannot touch the frames. `videotoolbox` has no
 *  entry — its downscale folds INTO `scale_vt`, which tone-maps and scales
 *  in the same hw step. */
const HW_SCALE_FILTER_BY_BACKEND: Partial<Record<HardwareBackend, string>> = {
  nvenc: "scale_cuda",
  qsv: "scale_qsv",
  vaapi: "scale_vaapi",
};

/** Segment 6 tone-map filter string per method (this step's instruction 5's
 *  BIND table, quoted verbatim). Fixed strings — no dynamic parameters.
 *  `videotoolbox`'s entry is route (a)'s BARE (no-downscale) form; the
 *  folded downscale form and route (b)'s cpu-zscale substitution are
 *  applied at the chain-assembly site (interpretation D). */
const TONE_MAP_FILTERS: Record<ToneMapMethod, string> = {
  "cpu-zscale":
    "zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p",
  cuda: "tonemap_cuda=format=yuv420p:tonemap=hable",
  opencl: "tonemap_opencl=format=yuv420p:tonemap=hable",
  vulkan: "libplacebo=tonemapping=hable:format=yuv420p",
  videotoolbox: `scale_vt=${VT_TONE_MAP_PARAMS}`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Converts an ABSOLUTE stream index (§2.1's `.index`, the real file's
 *  ffprobe-assigned stream number — which can have gaps from data/
 *  attachment streams this package's types never model) to its
 *  TYPE-RELATIVE position (docs/PLAYBACK.md §6 segment 5 / this step's
 *  instruction 4 — the correctness trap): sort the same-kind stream array
 *  by its own `.index`, then find the selected stream's position within
 *  THAT sort. `-map 0:v:{n}`/`0:a:{n}`/`0:s:{n}` all take a TYPE-RELATIVE
 *  `n` already — passing the raw absolute index straight through would
 *  silently select the WRONG (or a nonexistent) stream whenever a real
 *  file's absolute indices aren't already a dense 0..k-1 run for that kind. */
function typeRelativeIndex<T extends { index: number }>(streams: readonly T[], selectedIndex: number): number {
  const sorted = [...streams].sort((a, b) => a.index - b.index);
  const position = sorted.findIndex((s) => s.index === selectedIndex);
  if (position === -1) {
    throw new Error(`buildFfmpegArgs: selected stream index ${selectedIndex} not found in its own kind's array`);
  }
  return position;
}

/** Instruction 6 (BIND): the DEVICE entry's `maxLevel` for the ENCODE
 *  target codec, read from `device.video` exactly like every stage that
 *  reads device capability. `null` (either no matching entry, or the entry
 *  declares an unconstrained `maxLevel`) means: no `-level` flag. */
function levelCap(device: DeviceProfile, targetCodec: "h264" | "hevc"): number | null {
  const entry = device.video.find((v) => v.codec === targetCodec);
  return entry?.maxLevel ?? null;
}

function audioEncoderName(codec: AudioCodec): string {
  // Stage D/plan.ts's assembleAudio (docs/PLAYBACK.md §3 Stage D.4) only
  // ever produces 'opus' or 'aac' as a transcode target — this defensive
  // 'aac' fallback for any other (unreachable through plan()) value keeps
  // this utility from emitting `undefined`.
  return codec === "opus" ? "libopus" : "aac";
}

// ---------------------------------------------------------------------------
// buildFfmpegArgs
// ---------------------------------------------------------------------------

export function buildFfmpegArgs(input: PlanInput, planShape: FfmpegPlanShape, options: BuildFfmpegArgsOptions): string[] {
  const { media, device, selection } = input;
  const { container, video, audio, subtitle, rung } = planShape;
  const { withSeek } = options;

  if (container === "source") {
    throw new Error(
      "buildFfmpegArgs: never called for a direct-play plan (container 'source') — docs/PLAYBACK.md §5 mandates ffmpegArgs: [] there, computed by the caller, not this builder",
    );
  }

  const args: string[] = [];

  // Segment 1 — global (docs/PLAYBACK.md §6, always present, identical for
  // every non-direct-play decision).
  args.push("-hide_banner", "-loglevel", "warning", "-nostdin");

  const videoTranscoding = video.action === "transcode";

  // Stream resolution + filter-need derivation runs BEFORE segment 2 (moved
  // up by the interpretation-D real-execution fix): route (a)'s
  // `-hwaccel_output_format` decision needs `vtPureHw`, which depends on
  // which filters the graph will require. Pure derivation — emits nothing.
  const videoStream =
    selection.videoStreamIndex !== null ? media.video.find((v) => v.index === selection.videoStreamIndex) : undefined;
  const audioStream =
    selection.audioStreamIndex !== null ? media.audio.find((a) => a.index === selection.audioStreamIndex) : undefined;
  const subtitleStream =
    selection.subtitleStreamIndex !== null
      ? media.subtitle.find((s) => s.index === selection.subtitleStreamIndex)
      : undefined;

  const isExternalBurnIn = subtitle.strategy === "burn-in" && subtitleStream?.isExternal === true;

  const hasVideo = videoStream !== undefined;
  // A filtergraph applies to video only while video is genuinely being
  // transcoded (interpretation J's consistency note — see this module's
  // header): a burn-in strategy is only ever chosen alongside
  // video.action==='transcode' by a coherent plan() output (Stage E forces
  // it), so gating every filter need on `videoTranscoding` keeps segment 5's
  // map-redirect (interpretation A) and segment 7's encode-vs-copy branch
  // mutually consistent by construction.
  const needsDeinterlace = hasVideo && videoTranscoding && videoStream.interlaced;
  const needsScale = hasVideo && videoTranscoding && rung !== undefined && rung.heightPx < videoStream.height;
  const needsToneMap = hasVideo && videoTranscoding && video.toneMap !== undefined;
  const needsOverlay = hasVideo && videoTranscoding && subtitle.strategy === "burn-in";
  const hasFilterGraph = needsDeinterlace || needsScale || needsToneMap || needsOverlay;

  // Interpretation D's two hardware tone-map routes, for EVERY backend
  // §8.3 names a hw method for. The backend/method pairing check is
  // defensive (an incoherent shape falls through to the generic — unpinned
  // — path rather than emitting a mismatched -hwaccel_output_format).
  const isHwToneMap =
    needsToneMap &&
    video.encoder !== undefined &&
    (HW_TONE_MAP_METHODS_BY_BACKEND[video.encoder]?.includes(video.toneMap!) ?? false);
  const hwHybrid = isHwToneMap && (needsDeinterlace || needsOverlay);
  const hwPureHw = isHwToneMap && !hwHybrid;
  /** Route (a) on videotoolbox specifically — the only backend whose
   *  tone-map filter IS its scaler, so its downscale folds in. */
  const vtPureHw = hwPureHw && video.encoder === "videotoolbox";

  // Segment 2 — decode accel, ONLY when video actually transcodes (this
  // step's instruction 3). Route (a) additionally pins decoded frames to
  // the backend's hw surface (interpretation D — without this, the hw
  // tone-map filter receives software frames and the whole pipeline fails
  // at filter init).
  if (videoTranscoding) {
    if (!video.encoder) {
      throw new Error("buildFfmpegArgs: video.action==='transcode' requires planShape.video.encoder");
    }
    const hwaccel = HWACCEL_BY_BACKEND[video.encoder];
    if (hwaccel) args.push("-hwaccel", hwaccel);
    const outputFormat = hwPureHw ? HWACCEL_OUTPUT_FORMAT_BY_BACKEND[video.encoder] : undefined;
    if (outputFormat) args.push("-hwaccel_output_format", outputFormat);
  }

  // Segment 3 — seek, BEFORE -i, only when the caller asked for it
  // (options.withSeek — this step's instruction 2).
  if (withSeek) {
    args.push("-ss", "{SEEK_SECONDS}");
  }

  // Segment 4 — input(s). Second -i for an EXTERNAL burn-in sidecar only
  // (this step's instruction 4: "External burn-in adds the second -i
  // {SUBTITLE_SIDECAR} (segment 4) and the overlay consumes input 1").
  args.push("-i", "{INPUT}");
  if (isExternalBurnIn) {
    args.push("-i", "{SUBTITLE_SIDECAR}");
  }

  const videoRelIndex = hasVideo ? typeRelativeIndex(media.video, videoStream.index) : undefined;
  const audioRelIndex = audioStream !== undefined ? typeRelativeIndex(media.audio, audioStream.index) : undefined;
  const subRelIndex =
    subtitleStream !== undefined ? typeRelativeIndex(media.subtitle, subtitleStream.index) : undefined;

  // Segment 5 — mapping (type-relative indexes; this step's instruction 4).
  // Video's own map is OMITTED here (and redirected to the filtergraph's
  // output pad instead, segment 6) whenever a filtergraph applies —
  // interpretation A.
  if (hasVideo && !hasFilterGraph) {
    args.push("-map", `0:v:${videoRelIndex}`);
  }
  if (audioStream !== undefined) {
    args.push("-map", `0:a:${audioRelIndex}`);
  }
  if (subtitle.strategy === "embed" && subRelIndex !== undefined) {
    args.push("-map", `0:s:${subRelIndex}`);
  }

  // Segment 6 — filtergraph (docs/PLAYBACK.md §6, fixed order deinterlace ->
  // scale -> tonemap -> subtitle overlay; interpretations B/C/D above, plus
  // the §8.3 vaapi burn-in hwdownload/hwupload exception — step 7b fix F4,
  // documented in full in interpretation B's "VAAPI BURN-IN EXCEPTION"
  // block in this module's header).
  if (hasFilterGraph) {
    // §8.3's one-device exception: subtitle burn-in on vaapi requires
    // exactly one hwdownload -> (system-memory filters + overlay) ->
    // hwupload round-trip. Only this backend+overlay combination differs;
    // everything else is untouched.
    const isVaapiBurnIn = needsOverlay && video.encoder === "vaapi";

    const chainFilters: string[] = [];
    if (isVaapiBurnIn) chainFilters.push("hwdownload", "format=nv12");
    if (needsDeinterlace) chainFilters.push("yadif");
    // On route (a) the frames stayed on the device, so the SOFTWARE `scale`
    // filter cannot touch them: videotoolbox folds the rung downscale INTO
    // scale_vt (interpretation D: "VT tone-maps in the scaler", literally),
    // every other backend takes its OWN hw scaler in this position.
    if (needsScale && !vtPureHw) {
      const hwScale = hwPureHw ? HW_SCALE_FILTER_BY_BACKEND[video.encoder!] : undefined;
      chainFilters.push(hwScale ? `${hwScale}=w=-2:h=${rung!.heightPx}` : `scale=-2:${rung!.heightPx}`);
    }
    if (needsToneMap) {
      if (vtPureHw) {
        chainFilters.push(
          needsScale ? `scale_vt=w=-2:h=${rung!.heightPx}:${VT_TONE_MAP_PARAMS}` : TONE_MAP_FILTERS.videotoolbox,
        );
      } else if (hwHybrid) {
        // Route (b): software frames (plain -hwaccel auto-download) can't
        // feed a hardware tone-map filter — the documented cpu-zscale chain
        // substitutes in the tonemap position; the hw backend still encodes.
        chainFilters.push(TONE_MAP_FILTERS["cpu-zscale"]);
      } else {
        chainFilters.push(TONE_MAP_FILTERS[video.toneMap!]);
      }
    }

    const inputLabel = `[0:v:${videoRelIndex}]`;
    let filterComplex: string;

    if (needsOverlay) {
      const overlayInput = isExternalBurnIn ? "[1:s:0]" : `[0:s:${subRelIndex}]`;
      // On the vaapi route `chainFilters` is never empty (hwdownload/format
      // are always prepended), so the pure-burn-in no-[vfilt] shortcut
      // below only ever applies to non-vaapi backends; the single hwupload
      // sits immediately after `overlay`, returning the composited frames
      // to the vaapi device for encode ("exactly once").
      const overlayChain = isVaapiBurnIn ? "overlay,hwupload" : "overlay";
      filterComplex =
        chainFilters.length > 0
          ? `${inputLabel}${chainFilters.join(",")}[vfilt];[vfilt]${overlayInput}${overlayChain}[vout]`
          : `${inputLabel}${overlayInput}${overlayChain}[vout]`;
    } else {
      filterComplex = `${inputLabel}${chainFilters.join(",")}[vout]`;
    }

    args.push("-filter_complex", filterComplex, "-map", "[vout]");
  }

  // Segment 7 — video encode/copy block.
  if (hasVideo) {
    if (videoTranscoding) {
      if (!rung) throw new Error("buildFfmpegArgs: video.action==='transcode' requires planShape.rung");
      if (!video.targetCodec) {
        throw new Error("buildFfmpegArgs: video.action==='transcode' requires planShape.video.targetCodec");
      }
      const encoderTable = VIDEO_ENCODER_NAMES[video.encoder!];
      if (!encoderTable) {
        throw new Error(
          `buildFfmpegArgs: backend "${video.encoder}" has no video encoder mapping (decode-only backends are never a valid video.encoder)`,
        );
      }
      args.push("-c:v", encoderTable[video.targetCodec]);
      if (video.encoder === "software") args.push("-preset", "veryfast");
      if (video.encoder === "nvenc") args.push("-preset", "p4");
      args.push("-b:v", String(rung.videoBitrateBps));
      args.push("-maxrate", String(rung.videoBitrateBps));
      args.push("-bufsize", String(rung.videoBitrateBps * 2));
      const cap = levelCap(device, video.targetCodec);
      if (cap !== null) args.push("-level", String(cap));
      args.push("-g", String(Math.round(videoStream.frameRate * 2)));
      args.push("-force_key_frames", "expr:gte(t,n_forced*{SEG_DUR})");
      if (video.targetCodec === "hevc") args.push("-tag:v", "hvc1");
    } else if (video.action === "copy") {
      args.push("-c:v", "copy");
      // Interpretation K (this module's header) — seek-restart runs of an
      // open-GOP HEVC stream copy begin at a CRA whose RASL leading
      // pictures (NAL types 8/9) reference the prior, now-absent GOP;
      // stripping them keeps the run's first decodable picture the CRA
      // itself. Never applies to a fresh (non-seek) run, which starts at
      // the file's true IDR.
      if (video.openGop && withSeek && (container === "fmp4-hls" || container === "ts-hls")) {
        args.push("-bsf:v", "filter_units=remove_types=8-9");
      }
    }
  }

  // Segment 8 — audio encode/copy block, then (interpretation E) the embed
  // subtitle's codec-copy flag at the END of this segment.
  if (audioStream !== undefined) {
    if (audio.action === "transcode") {
      if (audio.targetCodec === undefined) {
        throw new Error("buildFfmpegArgs: audio.action==='transcode' requires planShape.audio.targetCodec");
      }
      if (audio.targetBitrateBps === undefined || audio.targetChannels === undefined) {
        throw new Error(
          "buildFfmpegArgs: audio.action==='transcode' requires planShape.audio.targetBitrateBps and targetChannels",
        );
      }
      args.push("-c:a", audioEncoderName(audio.targetCodec));
      args.push("-b:a", String(audio.targetBitrateBps));
      args.push("-ac", String(audio.targetChannels));
      if (audioStream.sampleRate > 48000) {
        args.push("-ar", "48000");
      }
    } else if (audio.action === "copy") {
      args.push("-c:a", "copy");
    }
  }
  if (subtitle.strategy === "embed") {
    args.push("-c:s", "copy");
  }

  // Segment 9 — output. Remux (interpretation F) vs HLS muxer (interpretation
  // G's fmp4/mpegts extension split).
  if (container === "mp4") {
    args.push("-movflags", "+faststart", "-f", "mp4", "{SESSION_DIR}/download.mp4");
  } else {
    const isFmp4 = container === "fmp4-hls";
    args.push("-f", "hls");
    args.push("-hls_time", "{SEG_DUR}");
    args.push("-hls_playlist_type", "event");
    args.push("-hls_segment_type", isFmp4 ? "fmp4" : "mpegts");
    if (isFmp4) {
      args.push("-hls_fmp4_init_filename", "init.mp4");
    }
    // Always present regardless of withSeek (this step's BIND) — the token
    // is substituted 0 at session start by the caller.
    args.push("-start_number", "{START_SEG}");
    const ext = isFmp4 ? "m4s" : "ts";
    args.push("-hls_segment_filename", `{SESSION_DIR}/s%06d.${ext}`);
    args.push("{SESSION_DIR}/media.m3u8");
  }

  return args;
}
