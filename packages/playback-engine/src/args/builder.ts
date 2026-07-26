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
 * (D) VIDEOTOOLBOX TONE-MAP ROUTES (Phase 3 step-7 owner-smoke
 *     REAL-EXECUTION FIX — supersedes this interpretation's original
 *     "scale_vt occupies the tonemap chain position inside a software
 *     chain" reading, which FAILED on real ffmpeg 8.1.1/macOS M3 Max:
 *     `scale_vt` is a HARDWARE filter requiring `videotoolbox_vld` frames,
 *     but a plain `-hwaccel videotoolbox` decode auto-downloads frames to
 *     system memory, so ffmpeg's auto-scale tried sw -> videotoolbox_vld
 *     conversion, hit "Error reinitializing filters!" -> -78 (Function not
 *     implemented) -> encoder never opened, nothing written). Two routes,
 *     selected when `video.toneMap === 'videotoolbox'` (Stage G only ever
 *     pairs that method with `video.encoder === 'videotoolbox'`; both are
 *     checked defensively):
 *
 *     (a) PURE-HW ROUTE — no software-only filter needed (no deinterlace,
 *         no burn-in overlay; a rung downscale does NOT disqualify): segment
 *         2 gains `-hwaccel_output_format videotoolbox_vld` after `-hwaccel
 *         videotoolbox`, forcing decoded frames to STAY on the VT surface
 *         (§8.3 "decode/encode stay on one device") — the SAME flag apps/
 *         worker/src/hwcaps's step-5 battery empirically needed on this
 *         exact machine/ffmpeg (see its args.ts header: bare `-hwaccel
 *         videotoolbox` is only a HINT). NOTE the value is ffmpeg's PIXEL
 *         FORMAT name `videotoolbox_vld` — plain `videotoolbox` is REJECTED
 *         by ffmpeg 8.1.1 ("Unrecognised hwaccel output format"), verified
 *         on this box. `scale_vt` then performs BOTH the tone-map AND any
 *         rung downscale in one hw step (`scale_vt=w=-2:h={H}:color_matrix=
 *         bt709:...` — §8.3's "VT tone-maps in the scaler", now literally):
 *         no separate software `scale`, no hw<->sw bounce anywhere.
 *         Real-verified end-to-end on this machine (exit 0, segments
 *         written, ffprobe color_transfer=bt709) by apps/worker/test/
 *         transcode/vt-tonemap-args.integration.spec.ts.
 *
 *     (b) HYBRID FALLBACK — a software-only filter (yadif deinterlace and/
 *         or burn-in overlay) is ALSO required: keep TODAY'S plain
 *         `-hwaccel videotoolbox` (no output_format; frames auto-download
 *         to system memory once, at the decoder boundary), run the ENTIRE
 *         §6 chain in software with the documented cpu-zscale tone-map
 *         string in the tonemap position (NO scale_vt — it can't take sw
 *         frames), and still ENCODE on VideoToolbox (h264_/hevc_
 *         videotoolbox accept software frames; real-verified on this box).
 *         SURFACED §8.3 TENSION (reported, not silently resolved): §8.3's
 *         "exactly one download/upload" burn-in exception cannot compose
 *         with §6's fixed filter order for VT — yadif must run PRE-scale
 *         (§6 order) but scale_vt tone-maps IN the scaler on hw frames, so
 *         a VT chain honoring both would need hwdownload -> yadif ->
 *         hwupload -> scale_vt -> (overlay would need a SECOND download) —
 *         two bounces, violating the one-bounce rule. The hybrid drops to
 *         one clean sw window instead (decode-download once, sw filters,
 *         VT encode): correct-for-the-common-case, zero bounces inside the
 *         graph. Golden 28 pins this graph.
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
 *  silently falling through). */
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

/** Segment 2's `-hwaccel_output_format` value for route (a) — ffmpeg's
 *  PIXEL FORMAT name for VT hw surfaces. `videotoolbox` (without `_vld`)
 *  is REJECTED by ffmpeg 8.1.1 ("Unrecognised hwaccel output format") —
 *  same value the step-5 hwcaps battery uses (apps/worker/src/hwcaps/
 *  tables.ts HWACCEL_OUTPUT_FORMAT_BY_BACKEND, proven on this machine). */
const VT_HWACCEL_OUTPUT_FORMAT = "videotoolbox_vld";

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

  // Interpretation D's two videotoolbox tone-map routes. Stage G only ever
  // selects toneMap 'videotoolbox' alongside encoder 'videotoolbox'; the
  // encoder check is defensive (an incoherent shape falls through to the
  // generic — pre-fix — path rather than emitting a mismatched
  // -hwaccel_output_format).
  const isVtToneMap = needsToneMap && video.toneMap === "videotoolbox" && video.encoder === "videotoolbox";
  const vtHybrid = isVtToneMap && (needsDeinterlace || needsOverlay);
  const vtPureHw = isVtToneMap && !vtHybrid;

  // Segment 2 — decode accel, ONLY when video actually transcodes (this
  // step's instruction 3). Route (a) additionally pins decoded frames to
  // the VT hw surface (interpretation D — without this, scale_vt receives
  // software frames and the whole pipeline fails at filter init).
  if (videoTranscoding) {
    if (!video.encoder) {
      throw new Error("buildFfmpegArgs: video.action==='transcode' requires planShape.video.encoder");
    }
    const hwaccel = HWACCEL_BY_BACKEND[video.encoder];
    if (hwaccel) args.push("-hwaccel", hwaccel);
    if (vtPureHw) args.push("-hwaccel_output_format", VT_HWACCEL_OUTPUT_FORMAT);
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
    // Route (a) folds the rung downscale INTO scale_vt (interpretation D:
    // "VT tone-maps in the scaler", literally) — no separate software
    // `scale` step ever touches the hw frames.
    if (needsScale && !vtPureHw) chainFilters.push(`scale=-2:${rung!.heightPx}`);
    if (needsToneMap) {
      if (vtPureHw) {
        chainFilters.push(
          needsScale ? `scale_vt=w=-2:h=${rung!.heightPx}:${VT_TONE_MAP_PARAMS}` : TONE_MAP_FILTERS.videotoolbox,
        );
      } else if (vtHybrid) {
        // Route (b): software frames (plain -hwaccel auto-download) can't
        // feed scale_vt — the documented cpu-zscale chain substitutes in
        // the tonemap position; VideoToolbox still encodes.
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
