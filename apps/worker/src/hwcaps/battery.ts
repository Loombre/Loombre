// SPDX-License-Identifier: AGPL-3.0-only
/**
 * probe-runner.ts (binding constraint 1's name) — the pure-orchestration
 * hardware capability self-test battery (docs/PLAYBACK.md §8.1). Every
 * piece of I/O (spawning ffmpeg, re-probing a produced file) arrives as an
 * injected function (`BatteryDeps.runCommand` / `.probeFile`) — this
 * module itself imports no node:child_process, no node:fs, no node:os, so
 * unit tests substitute fakes and never invoke real ffmpeg (binding
 * constraint 1, verbatim).
 *
 * `deps.backends` is supplied by the CALLER already in platform-candidate
 * order (platforms.ts's candidatesForPlatform(), software last) — this
 * module never reasons about `NodeJS.Platform` itself, it just preserves
 * whatever order it's handed as each `BackendReport.position`.
 */
import {
  buildDecodeSourceArgs,
  buildDecodeTestArgs,
  buildEncodeTestArgs,
  buildHdrSourceArgs,
  buildToneMapArgs,
  extensionForDecodeSource,
  extensionForEncodeTest,
  resolveDecodeSourceEncoder,
  resolveEncoderName,
} from "./args.js";
import { EXPECTED_DECODE_FRAME_COUNT, HWACCEL_PIXFMT_MARKER, TONE_MAP_CANDIDATES_BY_BACKEND } from "./tables.js";
import type {
  BackendReport,
  CommandResult,
  CommandRunner,
  HwBackend,
  ProbeEncodeCodec,
  ProbeFileFn,
  ProbeVideoCodec,
  TestResult,
  TestableToneMapMethod,
} from "./types.js";
import { DECODE_TEST_CODECS, ENCODE_TEST_CODECS } from "./types.js";

/** battery.ts's own output shape — deliberately narrower than the full
 *  `ProbeReport` (types.ts): this module has no opinion on the platform
 *  string, the ffmpeg build hash, or the GPU fingerprint (those come from
 *  fingerprint.ts / the real entry point's own `os.platform()` read) —
 *  keeping battery.ts's return value scoped to exactly what running the
 *  tests produces is what makes it "pure orchestration" rather than a
 *  grab-bag. The real wiring (run-hwprobe.ts / the 'hwprobe' consumer)
 *  merges this with fingerprint data into a full `ProbeReport`. */
export interface BatteryResult {
  backends: BackendReport[];
}

export interface BatteryDeps {
  /** Backends to test, IN ORDER — the array position becomes each
   *  BackendReport.position. Callers drive this from platforms.ts's
   *  candidatesForPlatform() in real use; tests pass whatever list they
   *  want to exercise (e.g. a single-entry ['software'] list, independent
   *  of the host's actual platform). */
  backends: readonly HwBackend[];
  runCommand: CommandRunner;
  probeFile: ProbeFileFn;
  ffmpegPath: string;
  /** Directory to write generated intermediate/output files under — the
   *  real entry point creates+cleans up a temp dir; fake-runner unit tests
   *  can pass any string (never actually touched, since a fake runner
   *  never writes real files). */
  workDir: string;
  clock: () => number;
  /** Feature-detected encoder names (`ffmpeg -encoders` output already
   *  parsed by the caller — see args.ts's parseEncoderNames). */
  encoders: ReadonlySet<string>;
  /** Per-test hard timeout — docs/PLAYBACK.md §8.1's 20s budget; overridable
   *  so unit tests don't wait 20 real seconds for a fake timeout case. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const STDERR_TAIL_CHARS = 800;

/**
 * Separator-stable path join (win32 CI finding, Phase 3 Step 6 boundary):
 * node:path's `join` emits backslashes on Windows, which made every
 * workDir-derived output path platform-DEPENDENT — ffmpeg and Node's fs
 * APIs both accept forward slashes on Windows, so nothing needs the
 * native separator here, and a platform-dependent path broke the fake-
 * runner unit tests' deterministic matchers on the windows-latest runner
 * (they compare against the exact argv strings this module emits). Battery
 * output paths are therefore ALWAYS `<workDir>/<name>` with a forward
 * slash, on every platform.
 */
function joinOut(workDir: string, name: string): string {
  return `${workDir.replace(/[\\/]+$/, "")}/${name}`;
}

function stderrTail(result: CommandResult): string {
  return result.stderr.slice(-STDERR_TAIL_CHARS);
}

function parseFinalFrameCount(stderr: string): number | null {
  const summaryMatches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  if (summaryMatches.length > 0) {
    return Number(summaryMatches[summaryMatches.length - 1]![1]);
  }
  const decodedMatch = /(\d+)\s+frames decoded/.exec(stderr);
  if (decodedMatch) return Number(decodedMatch[1]);
  return null;
}

/** True iff `stderr` shows the backend's hardware pixel-format marker
 *  actually appearing as the NEGOTIATED pixel format (a real hwaccel
 *  engagement) — `software` (no marker entry) is trivially true, there
 *  being nothing to "engage". See tables.ts's HWACCEL_PIXFMT_MARKER header
 *  for the real-machine finding that makes this check necessary at all.
 *
 * Deliberately NOT a bare `stderr.includes(marker)` — a real-machine test
 * against this box's own mpeg2-via-videotoolbox case (genuinely
 * unsupported) produced the line `Failed setup for format
 * videotoolbox_vld: hwaccel initialisation returned error`, which contains
 * the marker substring despite being a FAILURE message — a bare substring
 * check would have reported mpeg2/videotoolbox as a false PASS. This
 * checks for the marker specifically as ffmpeg's own NEGOTIATED-format
 * announcements are spelled: `pixfmt:<marker>` (the filtergraph input-pad
 * diagnostic line, printed for every decode regardless of whether any
 * filter is actually applied) or `pix_fmt: <marker>` (the "Reinit
 * context ... pix_fmt: X" stream-renegotiation line) — neither shape
 * appears in the "for format X: ... error" failure phrasing. */
function hwaccelGenuinelyEngaged(backend: HwBackend, stderr: string): boolean {
  const marker = HWACCEL_PIXFMT_MARKER[backend];
  if (!marker) return true;
  return stderr.includes(`pixfmt:${marker}`) || stderr.includes(`pix_fmt: ${marker}`);
}

async function runDecodeTest(
  deps: BatteryDeps,
  backend: HwBackend,
  codec: ProbeVideoCodec,
  sourcePath: string | null,
  sourceSkipReason: string | undefined,
  timeoutMs: number
): Promise<TestResult<ProbeVideoCodec>> {
  if (!sourcePath) {
    return { subject: codec, outcome: "skipped", detail: sourceSkipReason ?? "no-local-source" };
  }
  const args = buildDecodeTestArgs(backend, sourcePath);
  const result = await deps.runCommand.run(deps.ffmpegPath, args, { timeoutMs });
  if (result.timedOut) {
    return { subject: codec, outcome: "timeout", detail: `decode exceeded ${timeoutMs}ms`, stderrTail: stderrTail(result) };
  }
  if (result.exitCode !== 0) {
    return { subject: codec, outcome: "fail", detail: `ffmpeg exited ${result.exitCode}`, stderrTail: stderrTail(result) };
  }
  const frameCount = parseFinalFrameCount(result.stderr);
  if (frameCount !== EXPECTED_DECODE_FRAME_COUNT) {
    return {
      subject: codec,
      outcome: "fail",
      detail: `expected ${EXPECTED_DECODE_FRAME_COUNT} decoded frames, got ${frameCount ?? "unparseable"}`,
      stderrTail: stderrTail(result),
    };
  }
  if (!hwaccelGenuinelyEngaged(backend, result.stderr)) {
    return {
      subject: codec,
      outcome: "fail",
      detail: `hwaccel-not-engaged: frame count matched but the backend's hardware pixel-format marker never appeared (silent software fallback)`,
      stderrTail: stderrTail(result),
    };
  }
  return { subject: codec, outcome: "pass" };
}

async function runEncodeTest(
  deps: BatteryDeps,
  backend: HwBackend,
  codec: ProbeEncodeCodec,
  outPath: string,
  timeoutMs: number
): Promise<TestResult<ProbeEncodeCodec>> {
  const encoderName = resolveEncoderName(backend, codec, deps.encoders);
  if (!encoderName) {
    return { subject: codec, outcome: "skipped", detail: "no-encoder-available" };
  }
  const args = [...buildEncodeTestArgs(backend, codec, encoderName), outPath];
  const result = await deps.runCommand.run(deps.ffmpegPath, args, { timeoutMs });
  if (result.timedOut) {
    return { subject: codec, outcome: "timeout", detail: `encode exceeded ${timeoutMs}ms`, stderrTail: stderrTail(result) };
  }
  if (result.exitCode !== 0) {
    return { subject: codec, outcome: "fail", detail: `ffmpeg exited ${result.exitCode}`, stderrTail: stderrTail(result) };
  }
  const probed = await deps.probeFile(outPath);
  if (probed?.codecName !== codec) {
    return {
      subject: codec,
      outcome: "fail",
      detail: `re-probe codec_name=${probed?.codecName ?? "null"} (expected ${codec})`,
    };
  }
  return { subject: codec, outcome: "pass" };
}

async function runToneMapTest(
  deps: BatteryDeps,
  backend: HwBackend,
  method: TestableToneMapMethod,
  hdrSourcePath: string | null,
  outPath: string,
  timeoutMs: number
): Promise<TestResult<TestableToneMapMethod>> {
  if (!hdrSourcePath) {
    return { subject: method, outcome: "skipped", detail: "no-hdr-source-generated" };
  }
  const args = [...buildToneMapArgs(backend, method, hdrSourcePath), outPath];
  const result = await deps.runCommand.run(deps.ffmpegPath, args, { timeoutMs });
  if (result.timedOut) {
    return { subject: method, outcome: "timeout", detail: `tone-map exceeded ${timeoutMs}ms`, stderrTail: stderrTail(result) };
  }
  if (result.exitCode !== 0) {
    return { subject: method, outcome: "fail", detail: `ffmpeg exited ${result.exitCode}`, stderrTail: stderrTail(result) };
  }
  const probed = await deps.probeFile(outPath);
  if (probed?.colorTransfer !== "bt709") {
    return {
      subject: method,
      outcome: "fail",
      detail: `re-probe color_transfer=${probed?.colorTransfer ?? "null"} (expected bt709/SDR)`,
    };
  }
  return { subject: method, outcome: "pass" };
}

/** Runs the full battery across `deps.backends` and returns a structured
 *  result — every test's pass/fail/timeout/skipped + detail + stderr tail
 *  (binding constraint 2). Never throws: a spawn/probe failure for one
 *  test degrades that ONE test to 'fail', never aborts the battery. */
export async function runProbeBattery(deps: BatteryDeps): Promise<BatteryResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Decode-test sources: generated ONCE per codec, shared across every
  // backend (binding constraint 2(a) — the source itself is backend-
  // agnostic, only the decode step varies).
  const decodeSources = new Map<ProbeVideoCodec, { path: string } | { skipReason: string }>();
  for (const codec of DECODE_TEST_CODECS) {
    const encoderName = resolveDecodeSourceEncoder(codec, deps.encoders);
    if (!encoderName) {
      decodeSources.set(codec, { skipReason: "no-local-software-encoder" });
      continue;
    }
    const outPath = joinOut(deps.workDir, `decode-src-${codec}.${extensionForDecodeSource(codec)}`);
    const args = [...buildDecodeSourceArgs(codec, encoderName), outPath];
    const result = await deps.runCommand.run(deps.ffmpegPath, args, { timeoutMs });
    if (result.timedOut || result.exitCode !== 0) {
      decodeSources.set(codec, {
        skipReason: result.timedOut ? "source-generation-timeout" : `source-generation-failed (exit ${result.exitCode})`,
      });
      continue;
    }
    decodeSources.set(codec, { path: outPath });
  }

  // HDR10 tone-map source: generated once, only if ANY backend on this
  // platform has a tone-map candidate at all (no point paying the encode
  // cost otherwise).
  let hdrSourcePath: string | null = null;
  const anyToneMapCandidates = deps.backends.some((b) => (TONE_MAP_CANDIDATES_BY_BACKEND[b]?.length ?? 0) > 0);
  if (anyToneMapCandidates) {
    const outPath = joinOut(deps.workDir, "hdr10-source.mkv");
    const args = [...buildHdrSourceArgs(), outPath];
    const result = await deps.runCommand.run(deps.ffmpegPath, args, { timeoutMs });
    if (!result.timedOut && result.exitCode === 0) {
      hdrSourcePath = outPath;
    }
  }

  const backendReports: BackendReport[] = [];
  for (const [position, backend] of deps.backends.entries()) {
    const decode: TestResult<ProbeVideoCodec>[] = [];
    for (const codec of DECODE_TEST_CODECS) {
      const source = decodeSources.get(codec)!;
      const sourcePath = "path" in source ? source.path : null;
      const skipReason = "skipReason" in source ? source.skipReason : undefined;
      decode.push(await runDecodeTest(deps, backend, codec, sourcePath, skipReason, timeoutMs));
    }

    const encode: TestResult<ProbeEncodeCodec>[] = [];
    for (const codec of ENCODE_TEST_CODECS) {
      const outPath = joinOut(deps.workDir, `encode-${backend}-${codec}.${extensionForEncodeTest(codec)}`);
      encode.push(await runEncodeTest(deps, backend, codec, outPath, timeoutMs));
    }

    const toneMap: TestResult<TestableToneMapMethod>[] = [];
    for (const method of TONE_MAP_CANDIDATES_BY_BACKEND[backend] ?? []) {
      const outPath = joinOut(deps.workDir, `tonemap-${backend}-${method}.mp4`);
      toneMap.push(await runToneMapTest(deps, backend, method, hdrSourcePath, outPath, timeoutMs));
    }

    backendReports.push({ backend, position, decode, encode, toneMap, verifiedAtMs: deps.clock() });
  }

  return { backends: backendReports };
}
