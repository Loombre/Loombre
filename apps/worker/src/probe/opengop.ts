// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Open-GOP HEVC detection (verified playback defect, migrations/0038_
 * media_streams_open_gop.sql): HEVC sources encoded with open GOPs (CRA
 * keyframes + RASL leading pictures) cause full-frame white decode smears
 * in MSE playback for a few seconds after a seek-restart stream-copy
 * transcode run — @loombre/playback-engine's VideoStream.openGop (consulted
 * by its args/builder.ts to decide whether a withSeek copy run needs
 * `-bsf:v filter_units=remove_types=8-9`) is sourced from this detector's
 * verdict, stored on media_streams.open_gop.
 *
 * Method: a BOUNDED NAL-header scan via ffmpeg's trace_headers bitstream
 * filter,
 *
 *   ffmpeg [-ss <seek>] -t <bound> -i <file> -map 0:v:<idx> -c copy
 *          -bsf:v trace_headers -f null -
 *
 * `-t`/`-ss` precede `-i` (INPUT options — ffmpeg stops DEMUXING at that
 * point, not just trims output), so cost is bounded by scan duration, not
 * file size. trace_headers logs one line per NAL syntax element at ffmpeg's
 * default log verbosity (no -loglevel flag needed); the specific line this
 * module parses looks like:
 *
 *   [trace_headers @ 0x...] 1           nal_unit_type            <bits> = <decimal>
 *
 * HEVC nal_unit_type values (Rec. ITU-T H.265 Table 7-1): RASL_N=8,
 * RASL_R=9 (leading pictures — presence alone proves open-GOP, a RASL only
 * ever follows a CRA); BLA_W_LP=16, BLA_W_RADL=17, BLA_N_LP=18,
 * IDR_W_RADL=19, IDR_N_LP=20, CRA_NUT=21 (the IRAP/keyframe types a real
 * encoder emits — 22/23 are HEVC-spec-reserved and never seen from x265).
 *
 * SCAN WINDOW (opus review finding 1, BLOCKER — a from-start `-t 3` scan
 * cannot see past the file's FIRST GOP on real content: a typical x265
 * encode with keyint=250@23.976fps puts its second keyframe — where
 * CRAs/RASLs first appear in an open-GOP encode — at ~10.4s, so a 3s
 * from-start window sees exactly one IDR and returns a PERMANENT false;
 * the backfill only ever revisits NULL rows, never resolved `false` ones.
 * Three modes, chosen from the caller-supplied `durationMs`):
 *
 *   - mid-file (durationMs known and >= MID_FILE_MIN_DURATION_MS): seeks to
 *     (roughly) the file's midpoint and scans a short 2s window there.
 *     ffmpeg's INPUT-side `-ss` lands on the keyframe AT OR BEFORE the seek
 *     point — mid-file, that keyframe is a CRA in an open-GOP encode, an
 *     IDR in a closed-GOP one, so simple keyframe-type presence is now a
 *     direct signal with no positional bookkeeping needed.
 *   - from-start, SHORT file (durationMs known but < the threshold — the
 *     file is too short for a meaningful mid-window): scans the WHOLE
 *     stream from 0 (`-t` = the full duration). This sees the stream's
 *     genuine START, where an open-GOP encode legitimately opens with a
 *     bare IDR (no RASL) — a CRA/BLA opening the file is normal (every HLS
 *     segment boundary starts one too) and not itself the defect, so this
 *     mode keeps the ORIGINAL "CRA/BLA counts only as a NON-FIRST keyframe"
 *     positional rule (a RASL anywhere still counts immediately).
 *   - from-start, UNKNOWN duration (durationMs === null): same positional
 *     rule as the short-file case, with a raised bound (`-t 20`) standing
 *     in for "the whole stream" since the real length isn't known. Never
 *     guess `true` from an absent duration.
 *
 * Verdict: open-GOP (`true`) iff a RASL (8/9) appears anywhere in the
 * bounded window, OR — mode-dependent — a CRA/BLA (16/17/18/21) appears (mid-
 * file: ANY position; from-start: as a NON-FIRST keyframe only). Closed-GOP
 * (every keyframe seen is IDR: 19/20, no RASL) -> `false`. Scan
 * failure/timeout/missing-ffmpeg/signal-killed -> `null` ("unknown, never
 * guessed true") — see detectOpenGop's own doc comment for the full
 * contract.
 *
 * Codec guard (opus review finding 11, MINOR): this detector understands
 * HEVC's nal_unit_type numbering ONLY — pointed at e.g. H.264 it would
 * misread nal_unit_type 8 (H.264's PPS) as an HEVC RASL_N and return `true`
 * instantly. `detectOpenGop` therefore takes the stream's codec as an
 * explicit parameter and returns `false` WITHOUT spawning anything for any
 * codec other than `"hevc"` — matching what the probe consumer already
 * writes for non-HEVC streams (toStreamInputs in ./consumer.ts) and what
 * the backfill's bulk-false pass writes for non-HEVC rows
 * (bulkSetNonHevcVideoOpenGopFalse) — this is defense-in-depth for a
 * mis-wired caller, not the primary non-HEVC path either caller takes.
 *
 * stderr is scanned incrementally, line-by-line, as it streams in — never
 * buffered whole. Real high-bitrate HEVC content can log thousands of
 * per-syntax-element trace lines per second of video (SEI/VUI/slice-header
 * bit fields, not just nal_unit_type), so the verdict is resolved (and the
 * process killed) the instant either signal fires, keeping memory and
 * wall-clock bounded regardless of source bitrate.
 *
 * Signal-killed scans (opus review finding 7, MAJOR): a `close` event with
 * `exitCode === null` does NOT mean a clean exit — it means the child was
 * terminated by a signal (SIGTERM on worker shutdown, an OOM kill, etc.).
 * Only `exitCode === 0 && signal === null` is a genuine clean exit; every
 * other close (nonzero exit, OR any signal) resolves `null`, never a
 * guessed `false`.
 *
 * Never spawned inline on a request path (CLAUDE.md invariant 6): this
 * runs inside the existing 'probe' job (./consumer.ts) for newly-scanned
 * HEVC video streams, and inside the 'opengop-backfill' job
 * (./opengop-backfill-consumer.ts) for pre-existing rows.
 */

import { spawn } from "node:child_process";
import { resolveFfmpeg } from "./ffprobe.js";

/** `null` = unknown (scan failed/timed out/ffmpeg unresolvable/signal-
 *  killed) — never a guessed `true`. Every caller writes this straight
 *  through to media_streams.open_gop (NULL = "not yet probed for this
 *  fact"). */
export type OpenGopVerdict = boolean | null;

// Rec. ITU-T H.265 Table 7-1 nal_unit_type values this detector cares about.
const RASL_TYPES = new Set([8, 9]); // RASL_N, RASL_R — leading pictures
const CRA_BLA_TYPES = new Set([16, 17, 18, 21]); // BLA_W_LP, BLA_W_RADL, BLA_N_LP, CRA_NUT
const IRAP_TYPES = new Set([16, 17, 18, 19, 20, 21, 22, 23]); // every real keyframe type (incl. IDR) — from-start mode's "is this the first keyframe" bookkeeping only

// Matches "nal_unit_type                                          010100 = 20"
// (trace_headers' fixed-width field/binary-value/decimal-value layout,
// verified against real ffmpeg 8.1.1 output — see this module's header).
const NAL_UNIT_TYPE_LINE = /nal_unit_type\s+[01]+\s*=\s*(\d+)/;

/** Below this duration, a mid-file seek-and-scan window isn't meaningful
 *  (too little room either side of the midpoint) — fall back to scanning
 *  the whole short stream from 0 instead. Set to match the real fixture
 *  pair this module's test file generates (scripts/gen-media-fixtures.mjs:
 *  6s @25fps, keyint=50 -> keyframes at 0s/2s/4s, so a 6s file's exact
 *  midpoint (3s) lands squarely on the 2s keyframe) rather than a larger
 *  round figure — a bigger threshold would put that intentionally-tiny
 *  fixture pair in the wrong mode and silently stop exercising the
 *  mid-file path this exists to fix. Real HEVC sources this detector
 *  targets run from several minutes to hours, comfortably clearing this
 *  either way. */
const MID_FILE_MIN_DURATION_MS = 6_000;

/** Fixed 2s scan window once seeked to the mid-file point — long enough to
 *  reliably catch a RASL following the landed keyframe, short enough to
 *  stay cheap regardless of source bitrate. */
const MID_FILE_SCAN_SECONDS = "2";

/** `-t` bound for the unknown-duration from-start fallback — raised from
 *  the old universal 3s bound (which this redesign retires) since there is
 *  no known file length to size a "whole stream" scan against; 20s is a
 *  generous stand-in that still bounds worst-case cost. */
const UNKNOWN_DURATION_SCAN_SECONDS = "20";

export interface DetectOpenGopOptions {
  /** Hard kill timeout in milliseconds — bounds the WHOLE scan (spawn +
   *  decode + parse), independent of `-t`. Default 20_000, matching
   *  ffprobe.ts's runFfprobe DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Explicit ffmpeg binary path, bypassing resolveFfmpeg() — test seam,
   *  mirrors RunFfprobeOptions.ffprobePath. */
  ffmpegPath?: string;
}

interface ScanPlan {
  /** `-ss` argument value, or `null` to omit it (from-start scan). */
  seekSeconds: string | null;
  /** `-t` argument value. */
  scanSeconds: string;
  /** Which verdict rule processLine applies — see this module's header. */
  mode: "mid-file" | "from-start";
}

/** Chooses the scan window + verdict-rule mode for a given file duration —
 *  see this module's header "SCAN WINDOW" section for the full rationale
 *  per branch. */
function planScan(durationMs: number | null): ScanPlan {
  if (durationMs === null) {
    return { seekSeconds: null, scanSeconds: UNKNOWN_DURATION_SCAN_SECONDS, mode: "from-start" };
  }
  if (durationMs < MID_FILE_MIN_DURATION_MS) {
    const fullSeconds = Math.max(1, Math.ceil(durationMs / 1000));
    return { seekSeconds: null, scanSeconds: String(fullSeconds), mode: "from-start" };
  }
  // Input-side seek to (roughly) the midpoint — ffmpeg lands on the
  // keyframe at/before this point, which is exactly the sample this
  // detector needs mid-stream. Rounded to millisecond precision before
  // dividing back to seconds to avoid float noise (e.g. 7.4999999999999).
  const seekMs = Math.round(durationMs / 2);
  return { seekSeconds: String(seekMs / 1000), scanSeconds: MID_FILE_SCAN_SECONDS, mode: "mid-file" };
}

/**
 * Bounded open-GOP detector for ONE HEVC video stream. `videoTypeIndex` is
 * the stream's 0-based position among the file's video streams ONLY
 * (ffmpeg's own `-map 0:v:N` addressing — NOT media_streams.stream_index,
 * which is the raw ffprobe absolute index across every stream type); pass
 * 0 for a file's first (and, in practice, almost always only) video
 * stream. `codec` gates this detector to HEVC only — see this module's
 * header "Codec guard" section. `durationMs` is the file/stream's known
 * duration in milliseconds (or `null` if unknown) — it picks the scan
 * window + verdict rule, see "SCAN WINDOW" above.
 *
 * Never throws: every failure mode (non-HEVC codec, ffmpeg unresolvable,
 * spawn failure, timeout, signal-killed, unreadable/corrupt input)
 * resolves to `false` or `null` rather than rejecting — never `true`
 * without a positively observed signal. This is a deliberate divergence
 * from runFfprobe's hard-failure contract — a failed open-GOP scan must
 * not fail the whole 'probe' job (every OTHER field still comes from the
 * real ffprobe run either way); callers write the result straight through
 * to media_streams.open_gop (NULL for a `null` verdict — "not yet probed
 * for this fact"), never inferring `true` themselves.
 */
export async function detectOpenGop(
  filePath: string,
  videoTypeIndex: number,
  codec: string,
  durationMs: number | null,
  options: DetectOpenGopOptions = {},
): Promise<OpenGopVerdict> {
  // Codec guard (finding 11) — checked before any ffmpeg resolution/spawn.
  if (codec !== "hevc") return false;

  let ffmpegPath = options.ffmpegPath;
  if (!ffmpegPath) {
    const resolved = resolveFfmpeg();
    if (!resolved.ok) return null;
    ffmpegPath = resolved.binary.path;
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const plan = planScan(durationMs);
  const args = [
    ...(plan.seekSeconds !== null ? ["-ss", plan.seekSeconds] : []),
    "-t",
    plan.scanSeconds,
    "-i",
    filePath,
    "-map",
    `0:v:${videoTypeIndex}`,
    "-c",
    "copy",
    "-bsf:v",
    "trace_headers",
    "-f",
    "null",
    "-",
  ];

  // Same win32 .cmd/.bat shell carve-out as ffprobe.ts's runFfprobe (CVE-
  // 2024-27980) — real ffmpeg ships as an .exe (shell:false); a .cmd test
  // shim is the only thing that would ever need it.
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(ffmpegPath);

  return new Promise<OpenGopVerdict>((resolvePromise) => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"], shell: useShell });
    } catch {
      resolvePromise(null);
      return;
    }

    let settled = false;
    let sawFirstKeyframe = false; // from-start mode only
    let lineBuffer = "";

    const finish = (result: OpenGopVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolvePromise(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const processLine = (line: string) => {
      if (settled) return;
      const match = NAL_UNIT_TYPE_LINE.exec(line);
      if (!match) return;
      const type = Number.parseInt(match[1]!, 10);

      if (RASL_TYPES.has(type)) {
        finish(true);
        return;
      }

      if (plan.mode === "mid-file") {
        // The old "non-first keyframe" positional rule is obsolete here —
        // the -ss placement already guarantees this window opens mid-
        // stream, so ANY CRA/BLA seen is itself the signal.
        if (CRA_BLA_TYPES.has(type)) finish(true);
        return;
      }

      // from-start mode: a CRA/BLA opening the file/segment itself is
      // normal (every HLS segment boundary starts one) and not itself the
      // defect; only a REPEATED CRA/BLA after the first keyframe is.
      if (IRAP_TYPES.has(type)) {
        if (!sawFirstKeyframe) {
          sawFirstKeyframe = true;
        } else if (CRA_BLA_TYPES.has(type)) {
          finish(true);
        }
      }
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    child.on("error", () => finish(null));

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      if (lineBuffer.length > 0) processLine(lineBuffer);
      if (settled) return; // the trailing partial line itself resolved it
      // A genuine clean exit (code 0, no signal) with no open-GOP signal
      // ever seen is a confirmed closed-GOP verdict. `exitCode === null`
      // does NOT mean "clean" — it means signal-terminated (SIGTERM on
      // worker shutdown, an OOM kill, ...); that, a nonzero exit, corrupt
      // input, an unreadable stream, or an unmappable -map index are all
      // unknown, never a guessed false (finding 7).
      if (exitCode === 0 && signal === null) {
        finish(false);
      } else {
        finish(null);
      }
    });
  });
}
