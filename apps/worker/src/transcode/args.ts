// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Token substitution (docs/PLAYBACK.md §6: "Tokens ... are substituted by
 * the session layer — the pure engine never sees real paths") and the two
 * `-readrate` pacing injections this step's binding constraint 4 and
 * instructions 9 call for. `@loombre/playback-engine`'s `buildFfmpegArgs`
 * (and `plan()`'s own default-args call) are the ONLY producers of the
 * closed five-token set this module consumes — nothing here constructs
 * ffmpeg flags itself (that would re-litigate docs/PLAYBACK.md §6 outside
 * the engine, forbidden by this step's purity fence).
 *
 * ---------------------------------------------------------------------------
 * TOKEN -> VALUE MAPPING (the session layer's job per §6):
 *   {INPUT}         media_files.path for this session's file (absolute).
 *   {SESSION_DIR}   THIS RUN's private subdirectory (`<sessionDir>/runN`),
 *                   NOT the session root. See staging.ts's header: every
 *                   ffmpeg run gets its own directory so a fresh run never
 *                   overwrites a prior run's `media.m3u8` before the
 *                   worker has parsed + folded it into the served
 *                   wrapper playlist (playlist.ts) — this is what makes
 *                   the "worker renames per-run playlists" requirement
 *                   (binding constraint 5) unnecessary: there is nothing
 *                   to rename, each run already writes into its own place.
 *                   Segment filenames stay globally unique across runs
 *                   without any renaming either, because {START_SEG}
 *                   continues the numbering (docs/PLAYBACK.md §9) — run1's
 *                   files are s000043.m4s.. even though they live in a
 *                   DIFFERENT directory than run0's s000000..s000042.m4s.
 *   {SEG_DUR}       policy.segmentDurationSec, always 2 (§2.4, fixed v1; SPF-1).
 *   {START_SEG}     0 for a session's first run; on a seek-restart,
 *                   `producedSegment + 1` (binding constraint 5 — the
 *                   numbering continues from the last segment the OLD run
 *                   actually finished, never from the seek target itself).
 *   {SEEK_SECONDS}  only present when `buildFfmpegArgs` was called with
 *                   `withSeek: true` (seek-restarts only). Precision: the
 *                   session row's `seek_target_ms` (milliseconds) / 1000,
 *                   formatted to millisecond precision (e.g. 12345 ->
 *                   "12.345") — ffmpeg's `-ss` accepts fractional seconds
 *                   natively, so no rounding beyond that is needed.
 *
 * `init.mp4` and `{SESSION_DIR}/media.m3u8`/`s%06d.ext` are NOT separately
 * tokenized for their directory — `-hls_fmp4_init_filename init.mp4` is a
 * BARE relative filename in the builder's own output (packages/
 * playback-engine/src/args/builder.ts, segment 9), so it resolves against
 * the spawned ffmpeg process's OWN cwd. process.ts's spawnFfmpegRun
 * therefore always sets `cwd` to the SAME run directory {SESSION_DIR}
 * substitutes to, so `init.mp4` lands in exactly the same place the
 * segments/playlist do without a token of its own.
 */

const TOKEN_PATTERN = /\{(INPUT|SESSION_DIR|SEG_DUR|START_SEG|SEEK_SECONDS)\}/g;

export interface TokenValues {
  input: string;
  /** This RUN's directory (already resolved — see module header), not the
   *  session root. */
  runDir: string;
  segDurSec: number;
  startSeg: number;
  /** Required iff any arg actually contains `{SEEK_SECONDS}` (i.e. the
   *  args were built with `withSeek: true`); a mismatch either way throws. */
  seekTargetMs?: number;
}

/** Formats a seek target (milliseconds) as ffmpeg `-ss` seconds, up to
 *  millisecond precision, no trailing-zero padding beyond what's needed
 *  (e.g. 60000 -> "60", 12345 -> "12.345"). */
export function seekSecondsArg(seekTargetMs: number): string {
  const seconds = seekTargetMs / 1000;
  // Round to 3 decimal places to kill floating-point noise (e.g.
  // 12.3450000000001), then strip a trailing ".000"/trailing zeros.
  const rounded = Math.round(seconds * 1000) / 1000;
  return String(rounded);
}

/**
 * Substitutes every occurrence of the five tokens across `args` (a plain
 * per-element string replace — a single array element can legitimately
 * contain a token embedded in a larger string, e.g.
 * `"{SESSION_DIR}/s%06d.m4s"`). Throws if `{SEEK_SECONDS}` appears without
 * `values.seekTargetMs` supplied, or vice versa (a caller-shape bug, not a
 * runtime condition to silently paper over).
 */
export function substituteTokens(args: readonly string[], values: TokenValues): string[] {
  const seekArg = values.seekTargetMs !== undefined ? seekSecondsArg(values.seekTargetMs) : undefined;
  let sawSeekToken = false;

  const substituted = args.map((arg) =>
    arg.replace(TOKEN_PATTERN, (_match, name: string) => {
      switch (name) {
        case "INPUT":
          return values.input;
        case "SESSION_DIR":
          return values.runDir;
        case "SEG_DUR":
          return String(values.segDurSec);
        case "START_SEG":
          return String(values.startSeg);
        case "SEEK_SECONDS":
          sawSeekToken = true;
          if (seekArg === undefined) {
            throw new Error("substituteTokens: args contain {SEEK_SECONDS} but no seekTargetMs was supplied");
          }
          return seekArg;
        default:
          return _match;
      }
    }),
  );

  if (values.seekTargetMs !== undefined && !sawSeekToken) {
    throw new Error("substituteTokens: seekTargetMs was supplied but no arg contains {SEEK_SECONDS} — withSeek args expected");
  }

  return substituted;
}

/**
 * P3.8's documented win32 fallback (this step's binding constraint 4):
 * "-readrate 1.2" inserted immediately after the fixed global segment
 * (`-hide_banner -loglevel warning -nostdin`, always the first 3 flags/4
 * array elements per docs/PLAYBACK.md §6 segment 1) — NOT a builder edit
 * (packages/playback-engine/src/args/builder.ts is untouched), a
 * session-layer post-processing step on the already-built/substituted
 * args, exactly like every other token substitution in this module.
 *
 * Also reused (a SEPARATE call site, `multiplier` chosen independently —
 * see apps/worker/test/transcode/session.integration.spec.ts's header) as
 * a TEST-ONLY pacing aid on POSIX to make throttle-test timing
 * deterministic across machines of very different raw encode speed —
 * ORTHOGONAL to the throttle MECHANISM under test there (still real
 * SIGSTOP/SIGCONT), never present in this module's own production win32
 * vs POSIX branching (throttle.ts decides the platform's mechanism; this
 * function is just "insert -readrate N", used by two different, clearly
 * separate callers for two different reasons).
 *
 * `initialBurstSec` (d4-f1) adds ffmpeg's `-readrate_initial_burst`: that
 * many SECONDS OF CONTENT are read at maximum speed before the rate limit
 * applies at all. It is what makes a produce-ahead cap safe to put on a
 * COPY-shape run — startup, seek discovery and buffer refill after a
 * restart all happen inside the burst, so nothing a viewer can perceive is
 * paced; only the runaway tail is. Measured on the vendored ffmpeg 8.1
 * (150s fixture, `-readrate 10 -readrate_initial_burst 30`): 12.0s wall,
 * i.e. exactly 30s free + 120s at 10x, and the burst is relative to the
 * INPUT's own start — with `-ss 60` the same args finish in 8.5s, so a
 * seek-restart gets its own full burst rather than inheriting a spent one.
 * A SIGSTOPped input accrues no catch-up debt on that build (an 8s stop
 * cost 8s of wall time and produced no burst on SIGCONT), so the throttle
 * and this cap compose without either amplifying the other. Omitted (or
 * <= 0) emits the plain, unchanged two-element form.
 */
export function injectReadrate(args: readonly string[], multiplier: number, initialBurstSec?: number): string[] {
  const GLOBAL_SEGMENT_LENGTH = 4; // "-hide_banner", "-loglevel", "warning", "-nostdin"
  const insertAt = args.length >= GLOBAL_SEGMENT_LENGTH ? GLOBAL_SEGMENT_LENGTH : 0;
  const next = [...args];
  const injected =
    initialBurstSec !== undefined && initialBurstSec > 0
      ? ["-readrate", String(multiplier), "-readrate_initial_burst", String(initialBurstSec)]
      : ["-readrate", String(multiplier)];
  next.splice(insertAt, 0, ...injected);
  return next;
}
