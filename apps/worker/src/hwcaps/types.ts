// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared types for the hardware capability self-test battery (docs/
 * PLAYBACK.md §8, Phase 3 §11 step 5). Deliberately NOT imported from
 * @loombre/playback-engine (this step's binding constraint 8: "Do NOT touch
 * packages/playback-engine/** at all" — read as "don't take a dependency
 * on it either", keeping this module's only coupling to the engine's §2.5
 * contract a documented, hand-mirrored literal copy, verified against it by
 * test/hwcaps/conformance.spec.ts rather than by the type system). Every
 * union below is a literal transcription of docs/PLAYBACK.md §2.5 /
 * packages/playback-engine/src/types.ts's HardwareBackend/VideoCodec/
 * VerifiedBackendCapability shapes.
 */

/** §8.2 candidate backend set — identical to the engine's HardwareBackend
 *  union. */
export type HwBackend = 'videotoolbox' | 'qsv' | 'vaapi' | 'nvenc' | 'amf' | 'd3d11va' | 'software';

/** §2.1 VideoStream['codec'] — the decode-test battery only ever exercises
 *  the five codecs binding constraint 2(a) names ({h264,hevc,av1,vp9,
 *  mpeg2}); 'vc1'/'mpeg4'/'unknown' are valid VIDEO CODEC values (and
 *  appear in the FIXTURE sets, which are hand-authored, not probe output)
 *  but this battery never tests them, so they never appear in a
 *  probe-PRODUCED decode array. */
export type ProbeVideoCodec = 'h264' | 'hevc' | 'av1' | 'vp9' | 'mpeg2' | 'vc1' | 'mpeg4' | 'unknown';

/** The battery's actual decode-test codec set (binding constraint 2(a),
 *  verbatim). */
export const DECODE_TEST_CODECS: readonly ProbeVideoCodec[] = ['h264', 'hevc', 'av1', 'vp9', 'mpeg2'];

/** §2.5 VerifiedBackendCapability['encode'] element type. */
export type ProbeEncodeCodec = 'h264' | 'hevc' | 'av1';

export const ENCODE_TEST_CODECS: readonly ProbeEncodeCodec[] = ['h264', 'hevc', 'av1'];

/** §2.5 VerifiedBackendCapability['toneMap'] element type — 'none' is a
 *  real member of the engine's own type but no fixture (nor this battery)
 *  ever emits it as an array entry; absence of a method is represented by
 *  omitting it from the array, matching every existing caps.yaml fixture. */
export type ProbeToneMapMethod = 'opencl' | 'vulkan' | 'videotoolbox' | 'cuda' | 'none';

/** The tone-map METHODS this battery can attempt (never 'none' — that's a
 *  capability value, not a testable method). */
export type TestableToneMapMethod = Exclude<ProbeToneMapMethod, 'none'>;

// ---------------------------------------------------------------------------
// Command runner — the injected spawn abstraction (binding constraint 1).
// ---------------------------------------------------------------------------

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed before it could exit (timeout). */
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunCommandOptions {
  timeoutMs: number;
}

/** Every ffmpeg (and fingerprint helper-command) invocation in this module
 *  goes through this single seam — battery.ts itself never imports
 *  node:child_process, so unit tests substitute a fake implementation and
 *  never spawn a real process (binding constraint 1). */
export interface CommandRunner {
  run(bin: string, args: string[], options: RunCommandOptions): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Re-probing a produced file — also injected, so battery.ts never imports
// ../probe/ffprobe.js directly (the real implementation wraps it).
// ---------------------------------------------------------------------------

export interface ProbedFileInfo {
  /** ffprobe's raw `codec_name` for the first video stream, or null if the
   *  file has no video stream / couldn't be probed. */
  codecName: string | null;
  /** ffprobe's raw `color_transfer` for the first video stream. */
  colorTransfer: string | null;
}

export type ProbeFileFn = (filePath: string) => Promise<ProbedFileInfo | null>;

// ---------------------------------------------------------------------------
// Report shapes.
// ---------------------------------------------------------------------------

export type TestOutcome = 'pass' | 'fail' | 'timeout' | 'skipped';

export interface TestResult<Subject extends string> {
  subject: Subject;
  outcome: TestOutcome;
  /** Human-readable reason — always present for anything but a clean
   *  'pass' (constraint 2's "Every test's pass/fail/timeout ... goes into a
   *  structured probe REPORT object"). */
  detail?: string;
  /** Last ~2KB of the command's stderr — omitted for 'pass'/'skipped'. */
  stderrTail?: string;
}

export interface BackendReport {
  backend: HwBackend;
  /** Platform-candidate array position (0-based) — see hw_capability_
   *  backends.position; the engine consumes this order. */
  position: number;
  decode: TestResult<ProbeVideoCodec>[];
  encode: TestResult<ProbeEncodeCodec>[];
  toneMap: TestResult<TestableToneMapMethod>[];
  verifiedAtMs: number;
}

export interface ProbeReport {
  platform: NodeJS.Platform;
  ffmpegPath: string;
  ffmpegBuildHash: string;
  gpuFingerprint: string;
  generatedAtMs: number;
  backends: BackendReport[];
}
