// SPDX-License-Identifier: AGPL-3.0-only
/**
 * WHAT AN UNEXPECTED FFMPEG EXIT MEANS — the one place this runtime decides
 * whether a dead encoder is a dead SESSION or a dead PIPELINE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (QA finding browser-player-F2, P1). A real 4K HDR10 watch
 * tone-mapping to a 1080p `hevc_videotoolbox` rung ran for ~6 minutes and
 * then died with:
 *
 *     [hevc_videotoolbox] Error encoding frame: -17691
 *     [hevc_videotoolbox] Error submitting video frame to the encoder
 *     [out#0/hls] Terminating thread with return code -542398533
 *                 (Generic error in an external library)
 *
 * OSStatus `-17691` is `kVTSessionMalfunctionErr` (MacOSX.sdk
 * VideoToolbox/VTErrors.h:61). It is a statement about the out-of-process
 * VideoToolbox compression SESSION — it malfunctioned or was reclaimed —
 * not about the frame, the file, or the plan. ffmpeg has no way to express
 * that, so it maps it to `AVERROR_EXTERNAL` (-542398533) and exits
 * non-zero, and runner.ts's poll loop used to read every non-zero exit the
 * same way: session `failed`, `error_code='transcode-failed'`, terminal,
 * mid-watch. A fresh compression session usually just works (the failure
 * is intermittent — two later sessions on the same file ran 18 minutes
 * clean), and if it does not, the same rung encodes in software.
 *
 * ---------------------------------------------------------------------------
 * DESIGN. Pure, injectable, and deliberately free of any platform check:
 * it reads an exit code plus a stderr tail and returns a classification.
 * `runner.ts` takes it as `deps.classifyExit`, so the entire VideoToolbox
 * recovery path is drivable — and IS driven, by
 * apps/worker/test/transcode/encoder-malfunction.integration.spec.ts — on a
 * CI runner that has neither macOS nor a GPU. `process.platform` must
 * never appear in this file: the observable this classifies is text ffmpeg
 * wrote, and text is the same everywhere.
 *
 * PRECISION. Two independent signals are required before an exit is called
 * a hardware-session death: a VideoToolbox component must be named in the
 * tail AND one of the OSStatus values in the table below must appear as a
 * whole token. Neither alone is enough — `AVERROR_EXTERNAL` accompanies
 * plenty of unrelated failures, and a bare number can be anything. The
 * cost of a false positive is a pointless restart; the cost of a false
 * negative is the finding above, so the table stays SMALL and every entry
 * is a code whose documented meaning is "this session is gone", never
 * "this input is bad" (a bad-data error would fail again identically on a
 * fresh session, so retrying it would be a livelock, not a recovery).
 *
 * Other hardware backends (qsv/nvenc/vaapi/amf) can die the same way and
 * are NOT covered here — none has a comparable machine-readable status in
 * its stderr, and inventing a pattern for a failure mode nobody has
 * observed would be guessing. Adding one later means adding a rule, not
 * reshaping this module.
 */

import { classifyFfmpegFailure } from "@loombre/shared";

/** The facts process.ts's `FfmpegRunResult` carries that bear on this
 *  decision (a structural subset, so a caller can pass the result
 *  straight in). */
export interface FfmpegExitFacts {
  exitCode: number | null;
  signal?: string | null;
  killedByUs: boolean;
  stderrTail: string;
}

export type TranscodeExitClass =
  /** Exited 0 on its own — natural end of stream. */
  | { kind: "clean" }
  /** OUR terminate() (seek-restart, rung handoff, teardown, shutdown). */
  | { kind: "killed-by-us" }
  /** A hardware encode session died. The pipeline is fine; the session
   *  isn't. Bounded retry then software fallback — encoder-recovery.ts. */
  | { kind: "encoder-malfunction"; osStatus: number; symbol: string }
  /** Anything else: a real, unrecoverable pipeline failure. `errorCode`
   *  and `detail` come straight from @loombre/shared's
   *  `classifyFfmpegFailure` (SPF-7) — the same pure sub-classification
   *  apps/server's session-plan.ts re-derives from the persisted
   *  `stderrTail` to build the contract's `errorDetail`. */
  | { kind: "fatal"; errorCode: string; detail: string | null };

export type FfmpegExitClassifier = (facts: FfmpegExitFacts) => TranscodeExitClass;

/** `playback_sessions.error_code` for a pipeline failure — the historical
 *  fallback value, unchanged, and still what a failure this file's own
 *  table cannot say anything more specific about gets (SPF-7's
 *  `classifyFfmpegFailure` fallback code, re-exported here so every
 *  existing import site — including the start-up failures in runner.ts
 *  that never reach this file's `classifyFfmpegExit` at all — keeps using
 *  ONE constant). */
export const TRANSCODE_ERROR_CODE_FAILED = "transcode-failed";

/**
 * `playback_sessions.error_code` for "the hardware encoder kept dying and
 * even the software fallback could not keep this session alive". A
 * SEPARATE code, not a re-used one: the client's message for it is
 * different in kind ("this device's video encoder is failing" — retrying
 * the same watch may well work) and an operator reading the session list
 * needs to tell a machine-health problem from a broken plan. The column is
 * free-form TEXT (migrations/0006) and the contract types `errorCode` as
 * `[string, 'null']` with no enum, so adding a value is additive
 * everywhere — no migration, no contract change, no SDK regeneration.
 */
export const TRANSCODE_ERROR_CODE_ENCODER_MALFUNCTION = "transcode-encoder-malfunction";

/**
 * VideoToolbox OSStatus values that mean THIS SESSION is dead rather than
 * THIS INPUT is bad — verbatim from MacOSX.sdk
 * VideoToolbox/VTErrors.h (line numbers are that header's).
 *
 * Deliberately excluded: `kVTVideoDecoderBadDataErr` (-12909),
 * `kVTVideoDecoderUnsupportedDataFormatErr` (-12910),
 * `kVTCouldNotFindVideoEncoderErr` (-12908) and friends — those describe
 * the input or the machine's capabilities, and would fail identically on a
 * fresh session.
 */
export const RETRYABLE_VIDEOTOOLBOX_OSSTATUS: ReadonlyMap<number, string> = new Map([
  [-12903, "kVTInvalidSessionErr"], // VTErrors.h:32
  [-12911, "kVTVideoDecoderMalfunctionErr"], // VTErrors.h:40
  [-12912, "kVTVideoEncoderMalfunctionErr"], // VTErrors.h:41
  [-12913, "kVTVideoDecoderNotAvailableNowErr"], // VTErrors.h:42
  [-12915, "kVTVideoEncoderNotAvailableNowErr"], // VTErrors.h:45
  [-17691, "kVTSessionMalfunctionErr"], // VTErrors.h:61 — the observed one
]);

/** Any VideoToolbox component ffmpeg can name in a log line: the encoders
 *  (`hevc_videotoolbox`, `h264_videotoolbox`, …), the hwaccel, and the
 *  `scale_vt` filter's own device messages all contain this substring. */
const VIDEOTOOLBOX_MENTION = /videotoolbox|scale_vt/i;

/** Negative integers of OSStatus width, as WHOLE tokens — so `-176911`
 *  never reads as `-17691`, and `-542398533` (AVERROR_EXTERNAL, which
 *  accompanies every kind of external-library failure) never matches an
 *  entry in the table above. */
const OSSTATUS_TOKEN = /(?<![\d-])(-\d{4,6})(?![\d])/g;

function findRetryableOsStatus(stderrTail: string): { osStatus: number; symbol: string } | undefined {
  if (!VIDEOTOOLBOX_MENTION.test(stderrTail)) return undefined;
  for (const match of stderrTail.matchAll(OSSTATUS_TOKEN)) {
    const osStatus = Number(match[1]);
    const symbol = RETRYABLE_VIDEOTOOLBOX_OSSTATUS.get(osStatus);
    if (symbol !== undefined) return { osStatus, symbol };
  }
  return undefined;
}

/**
 * The default classifier. Pure: same inputs, same answer, on every
 * platform.
 *
 * Order matters. `killedByUs` wins over everything — a run we terminated
 * mid-frame can leave any diagnostic at all in its tail, including a VT
 * error from the teardown itself, and none of it is a failure of ours to
 * recover from. A zero exit is clean even if the tail is full of warnings
 * (ffmpeg warns constantly at `-loglevel warning`).
 */
export function classifyFfmpegExit(facts: FfmpegExitFacts): TranscodeExitClass {
  if (facts.killedByUs) return { kind: "killed-by-us" };
  if (facts.exitCode === 0) return { kind: "clean" };
  const vt = findRetryableOsStatus(facts.stderrTail);
  if (vt) return { kind: "encoder-malfunction", osStatus: vt.osStatus, symbol: vt.symbol };
  const failure = classifyFfmpegFailure({ stderrTail: facts.stderrTail, exitCode: facts.exitCode, signal: facts.signal ?? null });
  return { kind: "fatal", errorCode: failure.code, detail: failure.detail };
}
