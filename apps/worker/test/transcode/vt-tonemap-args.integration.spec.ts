// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/vt-tonemap-args.integration.spec.ts
//
// REAL-EXECUTION verification of the videotoolbox tone-map arg route
// (packages/playback-engine/src/args/builder.ts interpretation D, the
// Phase 3 step-7 owner-smoke fix): before the fix, the VT route decoded
// with a plain `-hwaccel videotoolbox` (frames auto-download to system
// memory) while placing `scale_vt` — a HARDWARE filter requiring
// `videotoolbox_vld` frames — in a software chain, so real ffmpeg 8.1.1
// failed filter init ("Error reinitializing filters!" -> -78) and wrote
// NOTHING despite every unit/golden test being green. This suite is the
// regression fence: it builds a real HDR10 transcode plan via plan(),
// substitutes the §6 tokens against a REAL HDR10 HEVC fixture, runs REAL
// ffmpeg, and asserts segments exist with ffprobe-verified bt709 output
// (tone-mapped!).
//
// Gated exactly per the fix instruction: real ffmpeg present AND darwin
// (scale_vt / -hwaccel videotoolbox / *_videotoolbox encoders exist only
// on macOS). Engine purity is untouched — the engine package stays free
// of I/O; this REAL-ffmpeg suite lives here in the worker, which already
// owns the other integration suites, and calls the engine's exported pure
// functions only to construct argv.
//
// NOTE on the fixture: test-fixtures/media/grid_mkv_hevc_10bit_hdr10_p.mkv
// carries color_space=bt2020nc but color_transfer/color_primaries
// "unknown" (the pre-existing generator gap documented in
// apps/worker/src/hwcaps/args.ts's header). scale_vt tone-maps it fine
// (verified on this machine) — the bt709 assertion below is on the
// OUTPUT, which is what the owner smoke checks.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENGINE_VERSION,
  buildFfmpegArgs,
  plan,
  type DeviceProfile,
  type FfmpegPlanShape,
  type LadderRung,
  type MediaInfo,
  type PlanInput,
} from "@loombre/playback-engine";
import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { resolveFfmpeg, resolveFfprobe } from "../../src/probe/ffprobe.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const FIXTURE_PATH = join(REPO_ROOT, "test-fixtures", "media", "grid_mkv_hevc_10bit_hdr10_p.mkv");

const ffmpegAvailable = ffmpegAvailableStrict();
const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);
const RUN_TIMEOUT_MS = 60_000 * TIME_SCALE;

// VT AVAILABILITY GATE (Phase 4 precondition-audit finding, run 30096845325):
// `darwin` alone is NOT enough — GitHub's macos-latest runners are
// paravirtualized VMs where VideoToolbox has no hardware behind it
// (IOServiceMatching fails for AppleM2ScalerParavirtDriver; ffmpeg exits
// 187), so this suite can never pass there. Probe with a real 0.2s
// h264_videotoolbox encode and skip LOUDLY when VT is genuinely absent —
// real-VT proof is owner-hardware territory.
// LOOMBRE_REQUIRE_VT=1 escalates the skip to a hard failure for
// owner-machine runs, where a quiet skip could mask a regression fence
// going dark (same posture as LOOMBRE_REQUIRE_FFMPEG).
function probeVtEncode(): boolean {
  if (!ffmpegAvailable || process.platform !== "darwin") return false;
  const resolved = resolveFfmpeg();
  if (!resolved.ok) return false;
  const probe = spawnSync(
    resolved.binary.path,
    [
      "-v", "error",
      "-f", "lavfi",
      "-i", "testsrc2=size=192x108:rate=30:duration=0.2",
      "-c:v", "h264_videotoolbox",
      "-f", "null", "-",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const ok = probe.status === 0;
  if (!ok) {
    const tail = (probe.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    const msg =
      "vt-tonemap-args.integration: VideoToolbox encode probe FAILED on darwin — " +
      "skipping the real-VT suite (virtualized runners have no VT hardware; " +
      "coverage lives in owner-hardware runs). " +
      `ffmpeg exit=${String(probe.status)} stderr: ${tail}`;
    if (process.env["LOOMBRE_REQUIRE_VT"]) {
      throw new Error(`LOOMBRE_REQUIRE_VT is set: ${msg}`);
    }
    console.warn(msg);
  }
  return ok;
}
const vtAvailable = probeVtEncode();

// ---------------------------------------------------------------------------
// Plan input: hevc 2160p HDR10 source, hdr10-INCAPABLE device that supports
// hevc+h264, macos-vt caps — the §8.3 route that must select encoder
// 'videotoolbox' with toneMap 'videotoolbox' (mirrors matrix case 401 and
// the goldens' construction style; the REAL fixture is smaller than the
// declared 2160p — plan() decides off MediaInfo, and scale_vt resizes
// whatever frames actually arrive).
// ---------------------------------------------------------------------------

const RUNG_2160P_HEVC: LadderRung = { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" };
const RUNG_1080P_H264: LadderRung = { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" };

function makeMedia(): MediaInfo {
  return {
    fileId: "vt-tonemap-int",
    container: "mkv",
    durationMs: 1_023,
    sizeBytes: 52_455,
    overallBitrateBps: 20_160_000,
    video: [
      {
        index: 0,
        codec: "hevc",
        profile: "main10",
        level: 153,
        width: 3840,
        height: 2160,
        bitDepth: 10,
        frameRate: 30,
        bitrateBps: 20_000_000,
        hdr: "hdr10",
        dvProfile: null,
        dvBlCompatId: null,
        interlaced: false,
        openGop: false,
      },
    ],
    audio: [
      {
        index: 1,
        codec: "aac",
        channels: 2,
        sampleRate: 48000,
        bitrateBps: 160_000,
        language: "eng",
        isDefault: true,
        hasAtmos: false,
      },
    ],
    subtitle: [],
  };
}

function makeDevice(): DeviceProfile {
  return {
    profileId: "vt-int-hdr10-incapable",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      { codec: "hevc", maxProfile: "main10", maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
      { codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 6, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

function makeInput(): PlanInput {
  return {
    media: makeMedia(),
    device: makeDevice(),
    network: { maxBitrateBps: 100_000_000, isLocal: true },
    policy: {
      allowTranscode: true,
      allowToneMapCpu: "always",
      tier: 1,
      preferredTextSubMode: "hls-vtt",
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"],
      maxSimultaneousTranscodes: 2,
      ladderRungs: [RUNG_2160P_HEVC, RUNG_1080P_H264],
      segmentDurationSec: 6,
      hevcEncodePreferred: false,
    },
    caps: {
      backends: [
        { backend: "videotoolbox", decode: ["h264", "hevc", "av1", "vp9"], encode: ["h264", "hevc"], toneMap: ["videotoolbox"], verifiedAtMs: 1_750_000_000_000 },
        { backend: "software", decode: ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1_750_000_000_000 },
      ],
    },
    selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    mode: "stream",
  };
}

/** §6 token substitution (the session layer's job, replicated for the real
 *  run): every token embedded or standalone, no seek in this suite. */
function substituteTokens(args: string[], sessionDir: string): string[] {
  const substituted = args.map((arg) =>
    arg
      .replaceAll("{INPUT}", FIXTURE_PATH)
      .replaceAll("{SESSION_DIR}", sessionDir)
      .replaceAll("{SEG_DUR}", "6")
      .replaceAll("{START_SEG}", "0"),
  );
  for (const arg of substituted) {
    expect(arg, `token survived substitution: ${arg}`).not.toContain("{");
  }
  return substituted;
}

interface RealRunResult {
  segments: string[];
  probe: { height: number; colorTransfer: string; colorSpace: string; colorPrimaries: string };
}

/** Runs REAL ffmpeg with fully-substituted args, asserts exit 0 + init.mp4
 *  + >=1 media segment, then ffprobes init+first-segment (a raw fmp4
 *  fragment is not probeable without its init) for the color triple. */
function runRealFfmpeg(args: string[], sessionDir: string): RealRunResult {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg.ok) throw new Error("ffmpeg unresolvable despite gate");
  const ffprobe = resolveFfprobe();
  if (!ffprobe.ok) throw new Error("ffprobe unresolvable (needed to verify tone-mapped output)");

  const run = spawnSync(ffmpeg.binary.path, args, { encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  expect(
    run.status,
    `real ffmpeg exited ${run.status}\nstderr tail:\n${(run.stderr ?? "").slice(-2000)}`,
  ).toBe(0);

  expect(existsSync(join(sessionDir, "init.mp4")), "init.mp4 missing").toBe(true);
  const segments = readdirSync(sessionDir).filter((f) => /^s\d{6}\.m4s$/.test(f)).sort();
  expect(segments.length, `no media segments in ${sessionDir}`).toBeGreaterThanOrEqual(1);

  const probeTarget = join(sessionDir, "probe-concat.mp4");
  writeFileSync(
    probeTarget,
    Buffer.concat([readFileSync(join(sessionDir, "init.mp4")), readFileSync(join(sessionDir, segments[0]!))]),
  );
  const probeOut = execFileSync(
    ffprobe.binary.path,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=height,color_transfer,color_space,color_primaries",
      "-of", "json",
      probeTarget,
    ],
    { encoding: "utf8", timeout: RUN_TIMEOUT_MS },
  );
  const parsed = JSON.parse(probeOut) as { streams: Array<Record<string, unknown>> };
  const stream = parsed.streams[0]!;
  return {
    segments,
    probe: {
      height: Number(stream["height"]),
      colorTransfer: String(stream["color_transfer"]),
      colorSpace: String(stream["color_space"]),
      colorPrimaries: String(stream["color_primaries"]),
    },
  };
}

describe.skipIf(!vtAvailable)(
  "videotoolbox tone-map route — REAL ffmpeg execution (builder.ts interpretation D)",
  () => {
    const tempDirs: string[] = [];

    beforeAll(() => {
      if (!existsSync(FIXTURE_PATH)) {
        execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
      }
      expect(existsSync(FIXTURE_PATH)).toBe(true);
    });

    afterAll(() => {
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    });

    it(
      "route (a), plan() default args: pure-hw scale_vt tone-map runs for real and produces bt709 segments",
      { timeout: RUN_TIMEOUT_MS + 30_000 },
      () => {
        const result = plan(makeInput());

        // The §8.3 route this fix targets, exactly as the matrix pins it —
        // decision/reasons/toneMap method are UNCHANGED by the fix.
        expect(result.decision).toBe("transcode");
        expect(result.video.action).toBe("transcode");
        expect(result.video.encoder).toBe("videotoolbox");
        expect(result.video.toneMap).toBe("videotoolbox");
        expect(result.container).toBe("fmp4-hls");
        // Tracks the engine's own exported constant rather than a literal:
        // this assertion exists to prove the plan came from THIS build of
        // the engine, not to freeze a version number, and a hard-coded
        // string turns every legitimate ruleset bump into a false failure
        // here (Wave C1's 0.9.0 -> 0.10.0 is what surfaced it).
        expect(result.engineVersion).toBe(ENGINE_VERSION);

        // Route (a)'s argv shape: hw-surface pin + scale_vt, zero software
        // filters, zero hw<->sw bounces.
        const args = result.ffmpegArgs;
        const outFmtIdx = args.indexOf("-hwaccel_output_format");
        expect(outFmtIdx, "route (a) must pin decode to the VT surface").toBeGreaterThan(args.indexOf("-hwaccel"));
        expect(args[outFmtIdx + 1]).toBe("videotoolbox_vld");
        const filterArg = args[args.indexOf("-filter_complex") + 1]!;
        expect(filterArg).toMatch(/^\[0:v:0\]scale_vt=/);
        expect(filterArg).toContain("color_matrix=bt709:color_primaries=bt709:color_transfer=bt709");
        expect(filterArg).not.toContain("yadif");
        expect(filterArg).not.toContain("scale=");
        expect(filterArg).not.toContain("hwdownload");
        expect(filterArg).not.toContain("hwupload");
        expect(filterArg).not.toContain("zscale");

        // THE deliverable: the args actually run on real ffmpeg against a
        // real HDR10 HEVC file, and the output is tone-mapped.
        const sessionDir = mkdtempSync(join(tmpdir(), "loombre-vt-tonemap-a-"));
        tempDirs.push(sessionDir);
        const real = runRealFfmpeg(substituteTokens(args, sessionDir), sessionDir);
        expect(real.probe.colorTransfer).toBe("bt709");
        expect(real.probe.colorSpace).toBe("bt709");
        expect(real.probe.colorPrimaries).toBe("bt709");
      },
    );

    it(
      "route (a), session-layer rung switch: the rung downscale FOLDS into scale_vt (w=-2:h=1080) and real-runs to bt709 at 1080 lines",
      { timeout: RUN_TIMEOUT_MS + 30_000 },
      () => {
        // The session layer regenerates args per rung (builder.ts header:
        // "the future session layer passes whichever rung it is actually
        // starting") — an ABR switch to the 1080p/h264 sibling rung must
        // fold the downscale INTO scale_vt, never emit a software `scale`.
        const shape: FfmpegPlanShape = {
          container: "fmp4-hls",
          video: { action: "transcode", targetCodec: "h264", encoder: "videotoolbox", toneMap: "videotoolbox" },
          audio: { action: "copy" },
          subtitle: { strategy: "none" },
          rung: RUNG_1080P_H264,
        };
        const args = buildFfmpegArgs(makeInput(), shape, { withSeek: false });

        expect(args[args.indexOf("-hwaccel_output_format") + 1]).toBe("videotoolbox_vld");
        const filterArg = args[args.indexOf("-filter_complex") + 1]!;
        expect(filterArg).toBe(
          "[0:v:0]scale_vt=w=-2:h=1080:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709[vout]",
        );

        const sessionDir = mkdtempSync(join(tmpdir(), "loombre-vt-tonemap-fold-"));
        tempDirs.push(sessionDir);
        const real = runRealFfmpeg(substituteTokens(args, sessionDir), sessionDir);
        expect(real.probe.colorTransfer).toBe("bt709");
        expect(real.probe.height).toBe(1080);
      },
    );
  },
);
