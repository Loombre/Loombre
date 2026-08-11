// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/probe/opengop.spec.ts
//
// Four suites:
//   - "detectOpenGop (fake ffmpeg, from-start mode)": deterministic, no real
//     ffmpeg needed — exercises the SHORT-duration/unknown-duration
//     from-start scan's stderr line-parsing/verdict rule (RASL presence,
//     CRA/BLA-as-non-first-keyframe, CRA-as-FIRST-keyframe being
//     normal/false) via the fake-ffmpeg.mjs shim (mirrors ffprobe.spec.ts's
//     fake-ffprobe.mjs convention exactly).
//   - "detectOpenGop (fake ffmpeg, mid-file mode)": the LONG-duration
//     seek-to-midpoint scan's simpler verdict rule (ANY CRA/BLA/RASL, no
//     positional bookkeeping) — reuses the SAME fake-ffmpeg fixtures as the
//     from-start suite, keyed only by the `durationMs` passed to
//     detectOpenGop, to directly demonstrate the two modes' differing
//     rules over identical stderr data (opus review finding 1).
//   - "detectOpenGop (fake ffmpeg, shared error/guard paths)": spawn/
//     timeout/nonzero-exit/signal-killed/codec-guard handling, mode-
//     independent.
//   - "detectOpenGop (real ffmpeg, generated fixtures)": skips cleanly
//     (whole describe block) without ffprobe/ffmpeg, same convention as
//     probe.integration.spec.ts — runs the checked-in fixture generator
//     (scripts/gen-media-fixtures.mjs) and asserts the detector's real
//     verdict against the real open-gop/closed-gop HEVC pair it produces
//     (hevc_opengop.mkv / hevc_closedgop.mkv, x265 `open-gop=1`/`open-gop=0`,
//     6s @25fps keyint=50 — sized so the file's own midpoint genuinely
//     exercises the mid-file scan path, see gen-media-fixtures.mjs's
//     comment for the exact keyframe layout this relies on).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { detectOpenGop } from "../../src/probe/opengop.js";
import { resolveFfprobe } from "../../src/probe/ffprobe.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, "fixtures", "bin");
// A real fake binary, cross-platform: shebang script on POSIX, a .cmd
// wrapper on Windows (Node's spawn() doesn't interpret shebangs there) —
// same convention as ffprobe.spec.ts's FAKE_FFPROBE.
const FAKE_FFMPEG = process.platform === "win32" ? join(BIN_DIR, "fake-ffmpeg.cmd") : join(BIN_DIR, "fake-ffmpeg.mjs");

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  resetEnv();
});

// ---------------------------------------------------------------------------
// argv capture helper (FAKE_FFMPEG_ARGV_FILE, see fake-ffmpeg.mjs's header)
// ---------------------------------------------------------------------------

let argvScratchDir: string;

beforeAll(() => {
  argvScratchDir = mkdtempSync(join(tmpdir(), "loombre-opengop-argv-"));
});

afterEach(() => {
  // Best-effort cleanup between tests that use the argv-capture seam —
  // stale files from an earlier test must never leak into a later
  // assertion (existsSync check before a real ffmpeg invocation writes one).
  try {
    rmSync(argvScratchDir, { recursive: true, force: true });
    argvScratchDir = mkdtempSync(join(tmpdir(), "loombre-opengop-argv-"));
  } catch {
    // ignore
  }
});

function captureArgv(): { envFile: string; read: () => string[] } {
  const envFile = join(argvScratchDir, `argv-${Math.random().toString(36).slice(2)}.json`);
  process.env["FAKE_FFMPEG_ARGV_FILE"] = envFile;
  return {
    envFile,
    read: () => JSON.parse(readFileSync(envFile, "utf8")) as string[],
  };
}

// ---------------------------------------------------------------------------
// from-start mode: SHORT known duration (< 6s) or unknown (null) duration
// ---------------------------------------------------------------------------

describe("detectOpenGop (fake ffmpeg, from-start mode)", () => {
  beforeEach(() => {
    delete process.env["FAKE_FFMPEG_MODE"];
  });

  it("returns false for a closed-GOP stream (IDR-only keyframes, no RASL) — short duration", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "closed";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(false);
  });

  it("returns true when a RASL_N/RASL_R NAL is present, even if the only keyframe is a first-position CRA — short duration", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "open-rasl";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(true);
  });

  it("returns true when a CRA/BLA appears as a NON-FIRST keyframe, even with no RASL NALs at all — short duration", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "open-cra-nonfirst";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(true);
  });

  it("returns false when the scanned window's FIRST keyframe is a CRA and it is never repeated (segment-boundary CRA is normal) — short duration", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "cra-first-only";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(false);
  });

  it("applies the SAME from-start rule when duration is unknown (null) — cra-first-only still false", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "cra-first-only";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", null, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(false);
  });

  it("returns false when no nal_unit_type lines are ever seen (clean exit, no signal) — short duration", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "no-signal";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(false);
  });

  it("addresses the requested video-type index via -map 0:v:<idx> (implicit: the fake binary ignores it, but a real one needs the right stream selected — see the real-fixture suite below for end-to-end proof)", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "closed";
    const result = await detectOpenGop("irrelevant.mkv", 2, "hevc", 3_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mid-file mode: known duration >= MID_FILE_MIN_DURATION_MS (6s)
// ---------------------------------------------------------------------------

describe("detectOpenGop (fake ffmpeg, mid-file mode)", () => {
  beforeEach(() => {
    delete process.env["FAKE_FFMPEG_MODE"];
  });

  it("returns true when a RASL_N/RASL_R NAL is present (mode-independent signal)", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "open-rasl";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 20_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(true);
  });

  it("returns true the instant ANY CRA/BLA keyframe is seen, even as the window's FIRST keyframe — the old non-first-keyframe rule does not apply here", async () => {
    // Same "cra-first-only" fixture the from-start suite above asserts
    // FALSE for — the differing verdict over identical stderr data IS the
    // point: mid-file mode has no "was this the first keyframe" concept,
    // because the -ss placement already guarantees the window opened
    // mid-stream, not at a legitimate segment/file boundary.
    process.env["FAKE_FFMPEG_MODE"] = "cra-first-only";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 20_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(true);
  });

  it("REGRESSION: an IDR-only mid-file window still correctly returns false (documents the old <3s-from-start blind spot this redesign replaces — the point is the -ss placement, not this particular verdict)", async () => {
    // This is the SAME "closed" fixture (IDR, TRAIL, IDR, TRAIL — no RASL,
    // no CRA/BLA at all) the from-start suite uses. Under the OLD design
    // (always -t 3 from offset 0, regardless of file length) a real
    // open-GOP encode with its second keyframe beyond the 3s window would
    // ALSO have produced this exact "no signal seen" shape and returned a
    // PERMANENT false — not because the file was genuinely closed-GOP, but
    // because the scan window never reached the part of the stream that
    // would have proven otherwise. Landing the window at the file's
    // MIDPOINT instead of a fixed offset from 0 is what actually closes
    // that blind spot (proven against real x265 fixtures in the
    // "real ffmpeg" suite below, where the true open-gop fixture's
    // midpoint genuinely lands on a CRA); this fake-binary case only
        // proves that a genuinely-clean mid-file window still resolves the
    // correct false, i.e. the redesign didn't turn every mid-file scan
    // into a false positive.
    process.env["FAKE_FFMPEG_MODE"] = "closed";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 20_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shared error/guard paths — mode-independent
// ---------------------------------------------------------------------------

describe("detectOpenGop (fake ffmpeg, shared error/guard paths)", () => {
  beforeEach(() => {
    delete process.env["FAKE_FFMPEG_MODE"];
  });

  it("returns null (never a guessed value) on a nonzero exit with no usable signal", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "nonzero";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBeNull();
  });

  it("returns null and kills the process on timeout, never hanging the caller", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "hang";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000, { ffmpegPath: FAKE_FFMPEG, timeoutMs: 150 });
    expect(result).toBeNull();
  }, 5000);

  it("returns null (never a guessed false) when the child is terminated by a signal rather than exiting cleanly (opus review finding 7: exitCode===null on close means signal-killed, NOT a clean exit)", async () => {
    process.env["FAKE_FFMPEG_MODE"] = "signal-killed";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 20_000, { ffmpegPath: FAKE_FFMPEG, timeoutMs: 5000 });
    expect(result).toBeNull();
  }, 8000);

  it("returns null (never throws) when the ffmpeg binary path doesn't exist", async () => {
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000, { ffmpegPath: "/definitely/not/a/real/ffmpeg-binary" });
    expect(result).toBeNull();
  });

  it("returns null (never throws) when ffmpeg is not resolvable via LOOMBRE_FFMPEG/PATH", async () => {
    delete process.env["LOOMBRE_FFMPEG"];
    process.env["PATH"] = "";
    process.env["Path"] = "";
    const result = await detectOpenGop("irrelevant.mkv", 0, "hevc", 3_000);
    expect(result).toBeNull();
  });

  it("returns false WITHOUT spawning anything for a non-HEVC codec (opus review finding 11) — proven by pointing at a nonexistent ffmpeg path and getting false, not the null a real spawn attempt would produce", async () => {
    const result = await detectOpenGop("irrelevant.mkv", 0, "h264", 20_000, {
      ffmpegPath: "/definitely/not/a/real/ffmpeg-binary",
    });
    expect(result).toBe(false);
  });

  it("the non-HEVC codec guard applies regardless of duration/mode (unknown duration, would-be mid-file duration)", async () => {
    expect(await detectOpenGop("irrelevant.mkv", 0, "av1", null, { ffmpegPath: "/definitely/not/a/real/ffmpeg-binary" })).toBe(
      false,
    );
    expect(
      await detectOpenGop("irrelevant.mkv", 0, "unknown", 20_000, { ffmpegPath: "/definitely/not/a/real/ffmpeg-binary" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// command-shape assertions: the exact -ss/-t argv per mode (opus review
// finding 1's "assert the -ss/-t arguments the detector passes")
// ---------------------------------------------------------------------------

describe("detectOpenGop (fake ffmpeg, command shape)", () => {
  beforeEach(() => {
    delete process.env["FAKE_FFMPEG_MODE"];
    process.env["FAKE_FFMPEG_MODE"] = "closed"; // any mode that exits cleanly; argv is captured before it runs
  });

  it("mid-file mode: -ss ~= duration/2, -t 2, in `-ss <seek> -t <bound> -i <file>` order", async () => {
    const argv = captureArgv();
    await detectOpenGop("the-file.mkv", 0, "hevc", 20_000, { ffmpegPath: FAKE_FFMPEG });
    const args = argv.read();
    expect(args.slice(0, 6)).toEqual(["-ss", "10", "-t", "2", "-i", "the-file.mkv"]);
  });

  it("mid-file mode boundary: duration exactly at the 6s threshold still seeks (>=  is mid-file)", async () => {
    const argv = captureArgv();
    await detectOpenGop("the-file.mkv", 0, "hevc", 6_000, { ffmpegPath: FAKE_FFMPEG });
    const args = argv.read();
    expect(args.slice(0, 6)).toEqual(["-ss", "3", "-t", "2", "-i", "the-file.mkv"]);
  });

  it("short-file from-start mode: no -ss, -t = the full duration rounded up to whole seconds", async () => {
    const argv = captureArgv();
    await detectOpenGop("the-file.mkv", 0, "hevc", 3_500, { ffmpegPath: FAKE_FFMPEG });
    const args = argv.read();
    expect(args.slice(0, 4)).toEqual(["-t", "4", "-i", "the-file.mkv"]);
    expect(args).not.toContain("-ss");
  });

  it("unknown-duration from-start fallback: no -ss, raised -t 20 bound", async () => {
    const argv = captureArgv();
    await detectOpenGop("the-file.mkv", 0, "hevc", null, { ffmpegPath: FAKE_FFMPEG });
    const args = argv.read();
    expect(args.slice(0, 4)).toEqual(["-t", "20", "-i", "the-file.mkv"]);
    expect(args).not.toContain("-ss");
  });

  it("non-HEVC codec: no argv file is ever written — the guard returns before any spawn", async () => {
    const argv = captureArgv();
    const result = await detectOpenGop("the-file.mkv", 0, "h264", 20_000, { ffmpegPath: FAKE_FFMPEG });
    expect(result).toBe(false);
    expect(existsSync(argv.envFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real-ffmpeg suite: the actual open-gop/closed-gop HEVC fixture pair.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const MEDIA_DIR = join(REPO_ROOT, "test-fixtures", "media");

const ffprobeAvailable = resolveFfprobe().ok;
const ffmpegAvailable = ffmpegAvailableStrict();
const toolsAvailable = ffprobeAvailable && ffmpegAvailable;

describe.skipIf(!toolsAvailable)("detectOpenGop (real ffmpeg, generated fixtures)", () => {
  beforeAll(() => {
    // Reuses existing output when already generated (idempotent — no
    // --force), same convention as probe.integration.spec.ts.
    execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
  }, 60_000);

  // 6s fixtures, keyint=50@25fps: keyframes at 0s/2s/4s. Mid-file mode
  // seeks to the exact midpoint (3s) and lands on the 2s keyframe — a CRA
  // in the open-gop encode, an IDR in the closed-gop one (see
  // scripts/gen-media-fixtures.mjs's comment for the full encoder rationale).
  it("returns true for the real x265 open-gop=1 fixture (hevc_opengop.mkv) via the mid-file scan", async () => {
    const result = await detectOpenGop(join(MEDIA_DIR, "hevc_opengop.mkv"), 0, "hevc", 6_000);
    expect(result).toBe(true);
  }, 15_000);

  it("returns false for the real x265 open-gop=0 control (hevc_closedgop.mkv) via the mid-file scan", async () => {
    const result = await detectOpenGop(join(MEDIA_DIR, "hevc_closedgop.mkv"), 0, "hevc", 6_000);
    expect(result).toBe(false);
  }, 15_000);

  it("also returns the correct verdicts with unknown duration (from-start fallback, whole-window rule) — proves the from-start rule ALSO catches this pair when scanned long enough to see the 2s/4s keyframes", async () => {
    const openResult = await detectOpenGop(join(MEDIA_DIR, "hevc_opengop.mkv"), 0, "hevc", null);
    expect(openResult).toBe(true);
    const closedResult = await detectOpenGop(join(MEDIA_DIR, "hevc_closedgop.mkv"), 0, "hevc", null);
    expect(closedResult).toBe(false);
  }, 15_000);
});

describe.skipIf(toolsAvailable)("detectOpenGop (real ffmpeg, generated fixtures) — skipped: ffmpeg/ffprobe unavailable", () => {
  it("is skipped cleanly, not failing, when the tooling is absent", () => {
    expect(toolsAvailable).toBe(false);
  });
});
