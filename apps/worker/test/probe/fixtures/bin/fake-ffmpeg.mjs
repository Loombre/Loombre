#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Deterministic stand-in for the real ffmpeg binary, used only by
 * opengop.spec.ts to exercise detectOpenGop()'s stderr line-parsing/
 * spawn/timeout/exit-code/signal handling without depending on a real
 * ffmpeg install (mirrors fake-ffprobe.mjs's own rationale — this repo's CI
 * runners don't provision ffmpeg; probe.integration.spec.ts-style real-tool
 * tests skip cleanly instead). Every emitted line matches the REAL
 * `trace_headers` bitstream filter's line shape, verified against actual
 * ffmpeg 8.1.1 output (see apps/worker/src/probe/opengop.ts's own header):
 *   [trace_headers @ 0xfake] 1           nal_unit_type            <bits> = <decimal>
 *
 * Note on the meaning of "first"/"non-first" below: this fixture data is
 * mode-agnostic — the CALLER picks which verdict rule applies (from-start
 * vs mid-file, see opengop.ts's planScan) by choosing the `durationMs` it
 * passes to detectOpenGop, not by anything this shim does. The same
 * "cra-first-only" stream, for instance, is `false` under the from-start
 * rule (a CRA opening the window is normal) but `true` under the mid-file
 * rule (ANY CRA in a mid-file window is itself the signal) — see
 * opengop.spec.ts's "mid-file" describe block for exactly that reuse.
 *
 * Behavior is selected via FAKE_FFMPEG_MODE:
 *   closed             -> two IDR (type 20) keyframes, some TRAIL (type 1)
 *                          in between, no RASL, no CRA/BLA -> false in
 *                          EVERY mode (no open-GOP signal at all)
 *   open-rasl          -> one IDR keyframe then RASL (type 8/9) NALs -> true
 *                          in every mode (RASL presence is mode-independent)
 *   open-cra-nonfirst  -> IDR keyframe, then a SECOND keyframe that is CRA
 *                          (type 21), no RASL at all -> true under the
 *                          from-start rule (and also true under mid-file,
 *                          since a CRA is present at all)
 *   cra-first-only     -> the scanned window's FIRST keyframe is itself a
 *                          CRA, never repeated, no RASL -> false under the
 *                          from-start rule, true under the mid-file rule
 *   no-signal          -> exits 0 with no nal_unit_type lines at all -> false
 *   nonzero            -> stderr message, exit 3, no usable lines -> null
 *   hang               -> never exits (for the timeout/SIGKILL path)
 *   signal-killed      -> self-delivers SIGTERM before emitting anything,
 *                          simulating an externally signal-terminated
 *                          child (worker shutdown, OOM killer, ...) -> null
 *                          (opus review finding 7: exitCode===null on
 *                          `close` means signal-terminated, NOT clean)
 *
 * FAKE_FFMPEG_ARGV_FILE (optional): when set, every mode writes its
 * received argv (JSON array, e.g. ["-ss","3","-t","2","-i",...]) to that
 * path before doing anything else — the command-shape assertion seam
 * opengop.spec.ts's "-ss/-t argument" tests use, since detectOpenGop spawns
 * `node:child_process` directly with no dependency-injection seam of its
 * own for the spawned args.
 */
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_FFMPEG_MODE ?? "closed";

const argvFile = process.env.FAKE_FFMPEG_ARGV_FILE;
if (argvFile) {
  writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));
}

function nalLine(type) {
  return `[trace_headers @ 0xfake] 1           nal_unit_type                                          000000 = ${type}\n`;
}

switch (mode) {
  case "closed": {
    process.stderr.write(nalLine(20)); // IDR_N_LP (first keyframe)
    process.stderr.write(nalLine(1)); // TRAIL_R
    process.stderr.write(nalLine(1)); // TRAIL_R
    process.stderr.write(nalLine(20)); // IDR_N_LP (second keyframe — still IDR)
    process.stderr.write(nalLine(1)); // TRAIL_R
    process.exit(0);
    break;
  }
  case "open-rasl": {
    process.stderr.write(nalLine(21)); // CRA_NUT (first keyframe — normal on its own)
    process.stderr.write(nalLine(8)); // RASL_N — the smoking gun
    process.stderr.write(nalLine(9)); // RASL_R
    process.stderr.write(nalLine(1)); // TRAIL_R
    process.exit(0);
    break;
  }
  case "open-cra-nonfirst": {
    process.stderr.write(nalLine(20)); // IDR_N_LP (first keyframe)
    process.stderr.write(nalLine(1)); // TRAIL_R
    process.stderr.write(nalLine(21)); // CRA_NUT — a SECOND keyframe that's CRA
    process.stderr.write(nalLine(1)); // TRAIL_R
    process.exit(0);
    break;
  }
  case "cra-first-only": {
    process.stderr.write(nalLine(21)); // CRA_NUT opening the window — normal
    process.stderr.write(nalLine(1)); // TRAIL_R
    process.stderr.write(nalLine(1)); // TRAIL_R
    process.exit(0);
    break;
  }
  case "no-signal": {
    process.stderr.write("[trace_headers @ 0xfake] Extradata\n");
    process.exit(0);
    break;
  }
  case "nonzero": {
    process.stderr.write("fake-ffmpeg: simulated failure\n");
    process.exit(3);
    break;
  }
  case "hang": {
    setInterval(() => {}, 60_000);
    break;
  }
  case "signal-killed": {
    // Default (unhandled) SIGTERM action terminates the process — Node
    // reports this to the parent as a `close` event with exitCode===null,
    // signal==="SIGTERM" (never as exitCode===0). No stdout/stderr output
    // is expected or needed to prove the bug: the detector must resolve
    // null on this close shape regardless of what (if anything) was seen
    // on stderr first.
    process.kill(process.pid, "SIGTERM");
    // In case delivery isn't instantaneous, keep the event loop alive
    // briefly rather than falling through to the default case's exit(2) —
    // a real signal-kill wins the race well within any test's timeoutMs.
    setInterval(() => {}, 60_000);
    break;
  }
  default: {
    process.stderr.write(`fake-ffmpeg: unknown FAKE_FFMPEG_MODE '${mode}'\n`);
    process.exit(2);
  }
}
