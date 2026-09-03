// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/test/ffmpeg-failure.test.ts
//
// SPF-7. Four of these cases run the ACTUAL vendored ffmpeg binary
// against a purpose-built failure condition (a missing path, a
// chmod-000 copy, a garbage byte stream, a nonexistent encoder name) and
// classify whatever it really wrote to stderr — not a hand-typed fixture
// string that could silently drift from what ffmpeg 8.1 actually says.
// Skips cleanly (like apps/worker/test/support/require-ffmpeg.ts's
// convention) when no ffmpeg binary is resolvable, UNLESS
// LOOMBRE_REQUIRE_FFMPEG is set, in which case that is a hard failure —
// a CI runner silently skipping every ffmpeg-gated assertion must never
// read as green.
//
// The synthetic OOM/signal-shape and fallback cases need no ffmpeg at
// all — they exercise the tail end of classifyFfmpegFailure's own
// decision table directly.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyFfmpegFailure } from "../src/ffmpeg-failure.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const MEDIA_DIR = join(REPO_ROOT, "test-fixtures", "media");
const GRID_FIXTURE = join(MEDIA_DIR, "grid_mkv_h264_8bit_none_p.mkv");

/** Vendor directory naming (scripts/fetch-ffmpeg.mjs's own layout) —
 *  mirrors apps/worker/src/probe/ffprobe.ts's env-var-first, then-PATH
 *  resolution, with the vendor tree as a THIRD fallback so this suite
 *  runs unattended in a fresh worktree without requiring the caller to
 *  export LOOMBRE_FFMPEG first. */
function vendoredFfmpegPath(): string | null {
  const platformDir =
    process.platform === "darwin" && process.arch === "arm64"
      ? "macos-arm64"
      : process.platform === "linux" && process.arch === "arm64"
        ? "linux-arm64"
        : process.platform === "linux" && process.arch === "x64"
          ? "linux-x64"
          : process.platform === "win32" && process.arch === "x64"
            ? "windows-x64"
            : null;
  if (!platformDir) return null;
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidate = join(REPO_ROOT, "vendor", "ffmpeg", platformDir, exeName);
  return existsSync(candidate) ? candidate : null;
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** PATH lookup, the same shape as apps/worker/src/probe/ffprobe.ts's
 *  findOnPath (packages/shared cannot import from apps/worker): every PATH
 *  entry, the bare name on POSIX, each PATHEXT extension on Windows; the
 *  first existing regular file wins. This is how CI's package-manager-
 *  installed ffmpeg is found — the runners never populate vendor/ffmpeg. */
function findOnPath(name: string): string | null {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir.length > 0);
  const suffixes = process.platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix);
      if (isRegularFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveFfmpegForTest(): string | null {
  const envPath = process.env["LOOMBRE_FFMPEG"];
  if (envPath && existsSync(envPath)) return envPath;
  return findOnPath("ffmpeg") ?? vendoredFfmpegPath();
}

const ffmpegPath = resolveFfmpegForTest();
if (!ffmpegPath && process.env["LOOMBRE_REQUIRE_FFMPEG"]) {
  throw new Error(
    "LOOMBRE_REQUIRE_FFMPEG is set but no ffmpeg binary was resolvable (LOOMBRE_FFMPEG env, PATH, or vendor/ffmpeg/<platform>) " +
      "— refusing to silently skip the real-ffmpeg ffmpeg-failure cases",
  );
}
const hasFfmpeg = ffmpegPath !== null && existsSync(GRID_FIXTURE);

/** Runs ffmpeg to deliberate failure and returns its captured stderr.
 *  ffmpeg's non-zero exit makes execFileSync throw; the stderr this test
 *  cares about rides on the thrown error's `.stderr`. */
function captureFailureStderr(args: string[]): string {
  try {
    execFileSync(ffmpegPath as string, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    throw new Error(`expected ffmpeg to fail for args: ${args.join(" ")}`);
  } catch (err) {
    const withStderr = err as { stderr?: string };
    if (typeof withStderr.stderr !== "string") throw err;
    return withStderr.stderr;
  }
}

describe.runIf(hasFfmpeg)("classifyFfmpegFailure — real vendored ffmpeg", () => {
  let scratchDir: string;

  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "loombre-ffmpeg-failure-"));
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("classifies a missing input path as transcode-input-missing", () => {
    const missingPath = join(scratchDir, "does-not-exist.mkv");
    const stderrTail = captureFailureStderr(["-hide_banner", "-loglevel", "warning", "-nostdin", "-i", missingPath, "-c", "copy", "-f", "null", "-"]);

    const result = classifyFfmpegFailure({ stderrTail, exitCode: 1, signal: null });

    expect(result.code).toBe("transcode-input-missing");
    expect(result.detail).not.toBeNull();
    expect(result.detail).toMatch(/no such file or directory/i);
    // The failing path must never leak into the viewer-facing detail.
    expect(result.detail).not.toContain(scratchDir);
    expect(result.detail!.length).toBeLessThanOrEqual(200);
  });

  it("classifies a chmod-000 (unreadable) input as transcode-input-unreadable", () => {
    const unreadablePath = join(scratchDir, "unreadable.mkv");
    writeFileSync(unreadablePath, "placeholder");
    chmodSync(unreadablePath, 0o000);
    try {
      const stderrTail = captureFailureStderr(["-hide_banner", "-loglevel", "warning", "-nostdin", "-i", unreadablePath, "-c", "copy", "-f", "null", "-"]);

      const result = classifyFfmpegFailure({ stderrTail, exitCode: 1, signal: null });

      expect(result.code).toBe("transcode-input-unreadable");
      expect(result.detail).toMatch(/permission denied/i);
      expect(result.detail).not.toContain(scratchDir);
    } finally {
      chmodSync(unreadablePath, 0o644);
    }
  });

  it("classifies a garbage (non-media) input as transcode-input-unreadable", () => {
    const garbagePath = join(scratchDir, "garbage.mkv");
    writeFileSync(garbagePath, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256)));
    const stderrTail = captureFailureStderr(["-hide_banner", "-loglevel", "warning", "-nostdin", "-i", garbagePath, "-c", "copy", "-f", "null", "-"]);

    const result = classifyFfmpegFailure({ stderrTail, exitCode: 1, signal: null });

    expect(result.code).toBe("transcode-input-unreadable");
    expect(result.detail).toMatch(/invalid data found when processing input|moov atom not found/i);
    expect(result.detail).not.toContain(scratchDir);
  });

  it("classifies a bogus -c:v encoder name as transcode-encoder-init-failed", () => {
    const stderrTail = captureFailureStderr(["-hide_banner", "-loglevel", "warning", "-nostdin", "-i", GRID_FIXTURE, "-c:v", "loombre_nonexistent_encoder", "-f", "null", "-"]);

    const result = classifyFfmpegFailure({ stderrTail, exitCode: 1, signal: null });

    expect(result.code).toBe("transcode-encoder-init-failed");
    expect(result.detail).toMatch(/unknown encoder/i);
  });
});

describe("classifyFfmpegFailure — synthetic shapes (no ffmpeg required)", () => {
  it("classifies a SIGKILL exit with an unrecognized tail as transcode-killed", () => {
    const result = classifyFfmpegFailure({
      stderrTail: "frame=  120 fps= 30 q=28.0 size=    512kB time=00:00:04.00 bitrate= 1048.6kbits/s speed=1.2x\n",
      exitCode: null,
      signal: "SIGKILL",
    });

    expect(result).toEqual({ code: "transcode-killed", detail: null });
  });

  it("classifies a null exit code with no signal and no matching line as transcode-killed (OOM shape)", () => {
    const result = classifyFfmpegFailure({
      stderrTail: "",
      exitCode: null,
      signal: null,
    });

    expect(result).toEqual({ code: "transcode-killed", detail: null });
  });

  it("never returns transcode-killed for a SIGTERM our own terminate() sends — that is killedByUs's concern, not this classifier's", () => {
    // classifyFfmpegFailure has no killedByUs parameter at all: the
    // caller (exit-classify.ts) never invokes it for a run it terminated
    // itself. This case documents that a SIGTERM alone (unlike SIGKILL)
    // does not trip the OOM heuristic when it somehow did reach here.
    const result = classifyFfmpegFailure({
      stderrTail: "some unrelated warning that matches nothing\n",
      exitCode: 1,
      signal: "SIGTERM",
    });

    expect(result.code).toBe("transcode-failed");
  });

  it("falls back to transcode-failed with a null detail when nothing matches and the process exited with a real code", () => {
    const result = classifyFfmpegFailure({
      stderrTail: "Some completely unrecognized ffmpeg diagnostic\nAnother unrelated line\n",
      exitCode: 1,
      signal: null,
    });

    expect(result).toEqual({ code: "transcode-failed", detail: null });
  });

  it("classifies disk-full and decoder-unsupported text deterministically", () => {
    expect(classifyFfmpegFailure({ stderrTail: "av_interleaved_write_frame(): No space left on device\n", exitCode: 1, signal: null }).code).toBe(
      "transcode-disk-full",
    );
    expect(
      classifyFfmpegFailure({ stderrTail: "[h264 @ 0x0] Decoder h264 not found\nUnsupported codec\n", exitCode: 1, signal: null }).code,
    ).toBe("transcode-decoder-unsupported");
  });

  it("prefers a specific input-open reason over the generic 'Error opening input' wrapper on the same line", () => {
    const result = classifyFfmpegFailure({
      stderrTail: "[in#0 @ 0x1] Error opening input: Permission denied\n",
      exitCode: 1,
      signal: null,
    });

    expect(result.code).toBe("transcode-input-unreadable");
  });

  it("falls back to transcode-input-missing for a generic, unrecognized 'Error opening input' line", () => {
    const result = classifyFfmpegFailure({
      stderrTail: "Error opening input: Something ffmpeg has never said before\n",
      exitCode: 1,
      signal: null,
    });

    expect(result.code).toBe("transcode-input-missing");
  });

  it("strips control characters and reduces absolute paths to their basename", () => {
    const result = classifyFfmpegFailure({
      stderrTail: "/srv/media/library/x.mkv: No such file or directory\r\n",
      exitCode: 1,
      signal: null,
    });

    expect(result).toEqual({ code: "transcode-input-missing", detail: "x.mkv: No such file or directory" });
  });

  it("reduces a Windows drive-letter path to its basename", () => {
    const result = classifyFfmpegFailure({
      stderrTail: String.raw`C:\Media\Library\movie.mkv: No such file or directory`,
      exitCode: 1,
      signal: null,
    });

    expect(result.detail).toBe("movie.mkv: No such file or directory");
  });

  it("trims an overlong detail line to 200 characters", () => {
    const longLine = "No such file or directory " + "x".repeat(400);
    const result = classifyFfmpegFailure({ stderrTail: longLine, exitCode: 1, signal: null });

    expect(result.detail).not.toBeNull();
    expect(result.detail!.length).toBe(200);
  });
});
