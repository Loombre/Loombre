// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage B′ — open-GOP H.264 copy safety (docs/PLAYBACK.md §3, ENGINE_VERSION
 * 0.12.0; owner report from the Linux reference box, 2026-09-07):
 *
 *   "5. (Stage B′, evaluated after A-F because it needs the FINAL container)
 *    Codec `h264` with `openGop === true`, video would otherwise be COPIED,
 *    and the final container is a segmented one (`fmp4-hls` | `ts-hls`) →
 *    transcode, reason `video-open-gop-copy-unsafe`."
 *
 * WHY. x264's `--open-gop` (and periodic intra refresh, and many broadcast
 * rips) flags non-IDR I-frames as keyframes and marks them with a
 * recovery-point SEI. The HLS muxer cuts a segment at every packet flagged
 * key — so with `-c:v copy` segments begin on frames whose references live
 * in the PREVIOUS segment. `EXT-X-INDEPENDENT-SEGMENTS` is then a lie, and
 * any client that (re)starts decoding at such a segment — a seek into
 * buffered range, a buffer flush, a rung switch, an MSE implementation
 * trusting the sync-sample flag — decodes P/B frames against missing
 * references: the blocky, pixelated skin tones the report measured (10 of
 * 32 "keyframes" in the first two minutes were recovery points, not IDRs).
 * ffmpeg has no bitstream filter that clears the key flag on non-IDR
 * frames, so detection + transcode is the only route that yields
 * independent segments; a progressive remux (`mp4`, one file, decoding
 * starts at the beginning) and direct play (`source`) are untouched.
 *
 * HEVC is a DIFFERENT case and untouched here: its open-GOP leading
 * pictures (RASL) are droppable by `filter_units` at a seek restart
 * (src/plan.ts's assembly-time `video.openGop` + the informational
 * `open-gop-leading-pictures-stripped`), so an hevc copy stays a copy.
 *
 * Placement: this is NOT inside stages/video.ts. Like the HEVC rule, the
 * predicate needs the FINAL container, which only the aggregate of Stages
 * A-F decides (an audio-only transcode in Stage D repackages a container
 * Stage A found direct-playable). src/plan.ts therefore aggregates A-F
 * once to learn the provisional container, evaluates this stage against
 * it, and aggregates again with this stage's verdict included. The
 * escalation only ever RAISES severity (to transcode, whose container is
 * `fmp4-hls` anyway), so one provisional pass is exact, never iterative.
 *
 * VACUOUS PASS (verdict `direct-play`, no reasons) when: no selected video
 * stream, codec is not h264, `openGop` is false, video is already being
 * transcoded by an earlier stage (nothing to escalate — B/C/E/F's own
 * reasons say why), or the final container is not segmented.
 */
import type { MediaInfo } from "../types.js";
import type { StageResult } from "./types.js";

export interface OpenGopCopySafetyContext {
  /** Stages B/C/E/F already escalated the VIDEO track to a transcode. */
  videoWouldTranscode: boolean;
  /** The provisional final container is `fmp4-hls` | `ts-hls`. */
  segmentedContainer: boolean;
}

export function evaluateOpenGopCopySafety(
  media: MediaInfo,
  videoStreamIndex: number | null,
  ctx: OpenGopCopySafetyContext,
): StageResult {
  if (videoStreamIndex === null) return { verdict: "direct-play", reasons: [] };
  const stream = media.video.find((v) => v.index === videoStreamIndex);
  if (!stream) return { verdict: "direct-play", reasons: [] };
  if (stream.codec !== "h264" || stream.openGop !== true) return { verdict: "direct-play", reasons: [] };
  if (ctx.videoWouldTranscode || !ctx.segmentedContainer) return { verdict: "direct-play", reasons: [] };
  return { verdict: "transcode", reasons: [{ code: "video-open-gop-copy-unsafe", streamIndex: stream.index }] };
}
