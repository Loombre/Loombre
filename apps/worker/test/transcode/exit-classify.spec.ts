// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/exit-classify.spec.ts
//
// SPF-7's own dedicated unit file for
// apps/worker/src/transcode/exit-classify.ts's "fatal" branch: since
// classifyFfmpegExit delegates every non-clean/non-killed-by-us/
// non-encoder-malfunction exit to @loombre/shared's classifyFfmpegFailure,
// this file exercises the full FfmpegFailureCode surface AS SEEN THROUGH
// exit-classify.ts — the encoder-malfunction/VideoToolbox-recovery-policy
// interplay stays in encoder-recovery.spec.ts, unchanged in shape apart
// from its own "fatal" assertions widening to the new errorCode/detail
// fields (this file does not duplicate those cases).

import { describe, expect, it } from "vitest";
import { classifyFfmpegExit, TRANSCODE_ERROR_CODE_FAILED } from "../../src/transcode/exit-classify.js";

describe("classifyFfmpegExit — fatal-branch sub-classification (SPF-7)", () => {
  it("classifies a missing-input stderr tail as transcode-input-missing with a sanitized detail", () => {
    const result = classifyFfmpegExit({
      exitCode: 1,
      killedByUs: false,
      stderrTail: "/srv/media/library/movie.mkv: No such file or directory\n",
    });

    expect(result).toEqual({
      kind: "fatal",
      errorCode: "transcode-input-missing",
      detail: "movie.mkv: No such file or directory",
    });
  });

  it("classifies a permission-denied stderr tail as transcode-input-unreadable", () => {
    const result = classifyFfmpegExit({
      exitCode: 1,
      killedByUs: false,
      stderrTail: "[in#0 @ 0x1] Error opening input: Permission denied\n",
    });

    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") throw new Error("unreachable");
    expect(result.errorCode).toBe("transcode-input-unreadable");
  });

  it("classifies an unsupported-decoder stderr tail as transcode-decoder-unsupported", () => {
    const result = classifyFfmpegExit({
      exitCode: 1,
      killedByUs: false,
      stderrTail: "[h264 @ 0x1] Decoder h264 not found\n",
    });

    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") throw new Error("unreachable");
    expect(result.errorCode).toBe("transcode-decoder-unsupported");
  });

  it("classifies an encoder-init failure stderr tail as transcode-encoder-init-failed", () => {
    const result = classifyFfmpegExit({
      exitCode: 1,
      killedByUs: false,
      stderrTail: "[vost#0:0 @ 0x1] Unknown encoder 'nope'\n",
    });

    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") throw new Error("unreachable");
    expect(result.errorCode).toBe("transcode-encoder-init-failed");
  });

  it("classifies a disk-full stderr tail as transcode-disk-full", () => {
    const result = classifyFfmpegExit({
      exitCode: 1,
      killedByUs: false,
      stderrTail: "av_interleaved_write_frame(): No space left on device\n",
    });

    expect(result).toEqual({ kind: "fatal", errorCode: "transcode-disk-full", detail: "av_interleaved_write_frame(): No space left on device" });
  });

  it("classifies a SIGKILL exit with no recognizable diagnostic as transcode-killed", () => {
    const result = classifyFfmpegExit({
      exitCode: null,
      signal: "SIGKILL",
      killedByUs: false,
      stderrTail: "frame=  900 fps= 30 q=28.0 size=  4096kB time=00:00:30.00 bitrate=1118.5kbits/s speed=1x\n",
    });

    expect(result).toEqual({ kind: "fatal", errorCode: "transcode-killed", detail: null });
  });

  it("falls back to transcode-failed for a real, non-zero exit whose stderr matches nothing known", () => {
    const result = classifyFfmpegExit({
      exitCode: 1,
      killedByUs: false,
      stderrTail: "some diagnostic this table has never seen\n",
    });

    expect(result).toEqual({ kind: "fatal", errorCode: TRANSCODE_ERROR_CODE_FAILED, detail: null });
  });

  it("never sub-classifies a run WE terminated, regardless of what its tail contains", () => {
    const result = classifyFfmpegExit({
      exitCode: null,
      signal: "SIGTERM",
      killedByUs: true,
      stderrTail: "/srv/media/library/movie.mkv: No such file or directory\n",
    });

    expect(result).toEqual({ kind: "killed-by-us" });
  });

  it("a clean (exit 0) run is never sub-classified even if its tail happens to contain warning-shaped text", () => {
    const result = classifyFfmpegExit({
      exitCode: 0,
      killedByUs: false,
      stderrTail: "[warning] deprecated pixel format\n",
    });

    expect(result).toEqual({ kind: "clean" });
  });
});
