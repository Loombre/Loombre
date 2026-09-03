// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/ffmpeg-failure.ts
//
// SPF-7: classifies WHY an ffmpeg transcode died from the text it left
// behind, so a viewer sees "the source file could not be opened" instead
// of a generic "transcode failed". Pure and platform-free by the same
// posture as this package's other classifiers (time.ts, crash-dir.ts): no
// I/O, no `process.platform`, no filesystem access — just the exit facts
// a caller already has in hand.
//
// apps/worker/src/transcode/exit-classify.ts is the ONLY caller that
// decides `error_code` from this (its own "fatal" branch, after
// `killedByUs` and the VideoToolbox encoder-malfunction table have both
// been ruled out — this function is never called for either of those,
// hence no `killedByUs` parameter here at all). apps/server's
// toContractPlaybackSession re-runs this SAME function over the row's
// stored `stderrTail` to derive the viewer-facing `errorDetail` line —
// the two call sites classifying independently (rather than one storing
// a `detail` column) is deliberate: the raw tail is the only thing
// persisted (docs/PLAYBACK.md §9 audit requirement), and this module is
// cheap and pure enough that re-deriving from it is simpler than adding a
// second stored, sanitized copy that could drift from the classifier.

/** The facts a dead ffmpeg process leaves behind that this module reads.
 *  `signal` and `exitCode` follow Node's own `ChildProcess` "close" event
 *  shape (a string signal name, or null) without importing `node:child_process`
 *  types — this module takes plain strings so it stays runtime-free. */
export interface FfmpegFailureFacts {
  /** The last several KB of ffmpeg's stderr (whatever the caller
   *  retained) — may be empty. */
  stderrTail: string;
  exitCode: number | null;
  signal: string | null;
}

/** One entry's category, in the priority order defined below. */
export type FfmpegFailureCode =
  | "transcode-input-missing"
  | "transcode-input-unreadable"
  | "transcode-decoder-unsupported"
  | "transcode-encoder-init-failed"
  | "transcode-disk-full"
  | "transcode-killed"
  | "transcode-failed";

export interface FfmpegFailureClassification {
  code: FfmpegFailureCode;
  /** The first stderr line that matched, sanitized (control characters
   *  stripped, absolute paths reduced to their basename, trimmed to 200
   *  characters) — a viewer must never see a server filesystem path.
   *  `null` when no line matched (the `transcode-killed` and
   *  `transcode-failed` fallbacks always carry a null detail: neither is
   *  reached BY a matched line). */
  detail: string | null;
}

/**
 * The ordered regex table (SPF-7 design). Order is the whole point: a
 * missing/unreadable INPUT is diagnosed before a failing ENCODER even when
 * an encoder-shaped line happens to appear earlier in the tail, because an
 * input problem is the more specific, more actionable answer and ffmpeg's
 * own line ordering is not a reliable priority signal (a decoder warning
 * routinely precedes the fatal input-open line that actually explains the
 * death). Each category is checked in full (every line, in order) before
 * the next category is tried at all.
 *
 * `Error opening input` is deliberately NOT in this table: measured
 * against the vendored ffmpeg (packages/shared/test/ffmpeg-failure.test.ts),
 * ffmpeg wraps EVERY input-open failure — missing, unreadable, AND
 * corrupt-data — in an `Error opening input: <reason>` line on the SAME
 * line as the specific reason text. Ranking it here at category-1
 * priority would make it match first for every one of those cases,
 * before "Permission denied" or "Invalid data found..." ever got a
 * chance — the opposite of the specific-reason-first order this table
 * exists to express. It is instead `GENERIC_INPUT_OPEN_FAILURE_RULE`
 * below, tried only after every specific pattern here has failed to
 * match anywhere in the tail.
 */
const FAILURE_RULES: ReadonlyArray<{ code: FfmpegFailureCode; patterns: readonly RegExp[] }> = [
  {
    code: "transcode-input-missing",
    patterns: [/no such file or directory/i],
  },
  {
    code: "transcode-input-unreadable",
    patterns: [
      /permission denied/i,
      /input\/output error/i,
      /invalid data found when processing input/i,
      /moov atom not found/i,
      /operation not permitted/i,
    ],
  },
  {
    code: "transcode-decoder-unsupported",
    patterns: [
      /decoder .* not found/i,
      /unsupported codec/i,
      /could not find codec parameters/i,
      /codec not supported/i,
      /not supported by decoder/i,
    ],
  },
  {
    code: "transcode-encoder-init-failed",
    patterns: [
      /error while opening encoder/i,
      /could not open encoder/i,
      /error initializing output stream/i,
      /cannot load lib/i,
      /failed to (initiali[sz]e|create) .*(vaapi|qsv|nvenc|amf|encoder)/i,
      /encoder .* not found/i,
      /unknown encoder/i,
    ],
  },
  {
    code: "transcode-disk-full",
    patterns: [/no space left on device/i],
  },
];

/** The generic "some input-open failure happened" wrapper — see the table
 *  header above for why this is ranked last rather than folded into
 *  `transcode-input-missing`'s own entry. */
const GENERIC_INPUT_OPEN_FAILURE_RULE: { code: FfmpegFailureCode; patterns: readonly RegExp[] } = {
  code: "transcode-input-missing",
  patterns: [/error opening input/i],
};

/** Matches one absolute-path token: a POSIX path, a Windows drive path, or
 *  a UNC path. Stops at whitespace/quote/paren/colon so a trailing
 *  `: No such file or directory` clause is never swallowed into the path
 *  itself. Simpler on purpose than redact-paths.ts's stack-frame-aware
 *  matcher — ffmpeg stderr has no stack frames, only inline message
 *  paths — and this module wants the BASENAME alone (no `<redacted>/`
 *  marker prefix): a viewer sees `x.mkv`, not a redaction artifact. */
const ABSOLUTE_PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s:'")\]]+/g;

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function sanitizeDetailLine(line: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching control characters to strip them
  const noControlChars = line.replace(/[\x00-\x1f\x7f]/g, "");
  const pathsStripped = noControlChars.replace(ABSOLUTE_PATH_TOKEN, (match) => basenameOf(match));
  return pathsStripped.trim().slice(0, 200);
}

function splitLines(stderrTail: string): string[] {
  return stderrTail.split(/\r\n|\r|\n/);
}

/**
 * Classifies a dead ffmpeg process's stderr into a specific, viewer-safe
 * failure code plus a sanitized one-line detail. Never called for a run
 * this worker itself terminated (`killedByUs`) or for a recognized
 * VideoToolbox session malfunction (apps/worker/src/transcode/
 * exit-classify.ts's own table) — both are decided before this function
 * would ever run, and this function has no way to see `killedByUs` at all.
 */
export function classifyFfmpegFailure(facts: FfmpegFailureFacts): FfmpegFailureClassification {
  const lines = splitLines(facts.stderrTail);

  for (const rule of [...FAILURE_RULES, GENERIC_INPUT_OPEN_FAILURE_RULE]) {
    for (const line of lines) {
      if (rule.patterns.some((pattern) => pattern.test(line))) {
        return { code: rule.code, detail: sanitizeDetailLine(line) };
      }
    }
  }

  // No known pattern matched anywhere in the tail. `SIGKILL` (an operator
  // or the OS's own OOM killer, never something this classifier's caller
  // sends — that path is `killedByUs`) or a null exit code with a silent
  // tail both read as "the process was killed out from under itself"
  // rather than a pipeline bug worth a generic "failed".
  if (facts.signal === "SIGKILL" || facts.exitCode === null) {
    return { code: "transcode-killed", detail: null };
  }

  return { code: "transcode-failed", detail: null };
}
