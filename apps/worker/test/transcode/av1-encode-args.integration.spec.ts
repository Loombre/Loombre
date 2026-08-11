// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/av1-encode-args.integration.spec.ts
//
// REAL-EXECUTION verification of AV1 ladder targeting (LD-7 / LD-16,
// docs/PLAYBACK.md §7.1/§7.2/§6 interp. M). Mirrors
// vt-tonemap-args.integration.spec.ts and dv-strip-args.integration.spec.ts
// in structure: build a real plan with the PURE engine, substitute the §6
// tokens, run REAL ffmpeg, and inspect what actually landed on disk.
// Engine purity is untouched — this suite lives in the worker, which
// already owns the other real-ffmpeg fences.
//
// WHAT THIS MACHINE CAN AND CANNOT PROVE (the honesty register, STATE.md
// P3.4). This is an Apple Silicon box, and that is not a limitation for
// the FIRST test here — it is the point:
//
//   - TIER-0 REFUSAL, PROVEN FOR REAL. No ffmpeg release ships an
//     `av1_videotoolbox` encoder and no Apple Silicon generation has AV1
//     encode hardware, so this machine genuinely has AV1 decode without
//     AV1 encode — exactly the §7.2 shape (an N100 has the same shape via
//     Quick Sync). Test 1 runs the ACTUAL probe battery (real spawns, real
//     re-probes, no fixtures), asserts from its output that no non-software
//     backend verified av1 encode, and then feeds those REAL caps to
//     `plan()` at tier 0. No av1 rung, no av1 targetCodec, no av1 encoder
//     token may emerge. That is the LD-16 law verified end-to-end on real
//     hardware rather than against a hand-written caps fixture.
//
//   - SOFTWARE AV1 AT TIER 1, EXECUTED. The bundled/system ffmpeg carries
//     libsvtav1, so test 2 runs the production plan() -> buildFfmpegArgs()
//     argv through real ffmpeg and ffprobes the resulting HLS segments to
//     confirm the video stream really is AV1. This is the encoder D4
//     narrowed the software capability to, spawned by the exact name the
//     builder emits.
//
//   - FIXTURE-ONLY, and stated as such: av1_nvenc / av1_qsv / av1_vaapi /
//     av1_amf encode paths and the windows-x64 libsvtav1 presence. No
//     hardware here can execute them; they stay P3.4 backlog items.
//
// Test 3 pins the av1+ts-hls descriptive throw — the one shape §6
// interpretation M declares unreachable through plan().

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  av1EncodeEligibility,
  buildFfmpegArgs,
  plan,
  type DeviceProfile,
  type MediaInfo,
  type PlanInput,
  type ServerPolicy,
  type VerifiedCapabilities,
} from "@loombre/playback-engine";
import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { buildListEncodersArgs, parseEncoderNames } from "../../src/hwcaps/args.js";
import { runProbeBattery } from "../../src/hwcaps/battery.js";
import { createRealCommandRunner } from "../../src/hwcaps/command-runner.js";
import { probeFileReal } from "../../src/hwcaps/probe-file.js";
import { toVerifiedCapabilities } from "../../src/hwcaps/report.js";
import { candidatesForPlatform } from "../../src/hwcaps/platforms.js";
import { resolveFfmpeg, resolveFfprobe } from "../../src/probe/ffprobe.js";

const ffmpegAvailable = ffmpegAvailableStrict();
const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);
const RUN_TIMEOUT_MS = 120_000 * TIME_SCALE;

/** Every encoder name §6 interpretation M can emit for an av1 target. */
const AV1_ENCODER_NAMES = ["libsvtav1", "av1_nvenc", "av1_qsv", "av1_vaapi", "av1_amf"];

// ---------------------------------------------------------------------------
// Plan inputs
// ---------------------------------------------------------------------------

/** A device that WANTS av1: declares the entry and takes fmp4. Its
 *  directPlayContainers deliberately excludes mkv, so Stage A forces the
 *  repackage and the interlaced flag below forces the transcode — a ladder
 *  is genuinely built and routed. */
function makeDevice(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    profileId: "av1-int-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      { codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
      { codec: "hevc", maxProfile: "main10", maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
      { codec: "av1", maxProfile: null, maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ],
    hdr: { hdr10: true, hlg: true, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 6, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
    ...overrides,
  };
}

/** 320x240 so a real encode finishes in seconds; interlaced so Stage B
 *  escalates to transcode without needing a device limit to be breached. */
function makeMedia(): MediaInfo {
  return {
    fileId: "av1-int",
    container: "mkv",
    durationMs: 2_000,
    sizeBytes: 200_000,
    overallBitrateBps: 900_000,
    video: [
      {
        index: 0,
        codec: "h264",
        profile: "high",
        level: 30,
        width: 320,
        height: 240,
        bitDepth: 8,
        frameRate: 24,
        bitrateBps: 800_000,
        hdr: "none",
        dvProfile: null,
        dvBlCompatId: null,
        interlaced: true,
        openGop: false,
      },
    ],
    audio: [],
    subtitle: [],
  };
}

function makePolicy(overrides: Partial<ServerPolicy> = {}): ServerPolicy {
  return {
    allowTranscode: true,
    allowToneMapCpu: "always",
    tier: 1,
    preferredTextSubMode: "hls-vtt",
    preserveAssStyling: false,
    audioTranscodeCodecPriority: ["opus", "aac"],
    maxSimultaneousTranscodes: 2,
    // A single 240p rung: the source's own height, so no rescale, and small
    // enough that a real libsvtav1 encode of a 2s clip is quick.
    ladderRungs: [{ heightPx: 240, videoBitrateBps: 400_000, audioBitrateBps: 160_000, codec: "h264" }],
    segmentDurationSec: 6,
    hevcEncodePreferred: false,
    av1EncodePreferred: true,
    ...overrides,
  };
}

function makeInput(caps: VerifiedCapabilities, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    media: makeMedia(),
    device: makeDevice(),
    network: { maxBitrateBps: 100_000_000, isLocal: true },
    policy: makePolicy(),
    caps,
    selection: { videoStreamIndex: 0, audioStreamIndex: null, subtitleStreamIndex: null },
    mode: "stream",
    ...overrides,
  };
}

function substituteTokens(args: string[], sessionDir: string, source: string): string[] {
  const substituted = args.map((arg) =>
    arg
      .replaceAll("{INPUT}", source)
      .replaceAll("{SESSION_DIR}", sessionDir)
      .replaceAll("{SEG_DUR}", "1")
      .replaceAll("{START_SEG}", "0")
      .replaceAll("{SEEK_SECONDS}", "0"),
  );
  for (const arg of substituted) {
    expect(arg, `token survived substitution: ${arg}`).not.toContain("{");
  }
  return substituted;
}

/** A 2-second 320x240 h264 mkv, generated with the same ffmpeg under test. */
function generateSource(ffmpegPath: string, dir: string): string {
  const source = join(dir, "src.mkv");
  const result = spawnSync(
    ffmpegPath,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      source,
    ],
    { encoding: "utf8", timeout: RUN_TIMEOUT_MS },
  );
  expect(result.status, `source generation failed:\n${result.stderr ?? ""}`).toBe(0);
  return source;
}

function probeVideoCodec(ffprobePath: string, target: string): string {
  const result = spawnSync(
    ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_streams", "-select_streams", "v:0", target],
    { encoding: "utf8", timeout: RUN_TIMEOUT_MS },
  );
  try {
    return String(JSON.parse(result.stdout).streams[0].codec_name);
  } catch {
    return `probe-parse-failed: ${result.stderr ?? ""}`;
  }
}

// ---------------------------------------------------------------------------

describe.skipIf(!ffmpegAvailable)("AV1 ladder targeting — real ffmpeg (LD-7 / LD-16)", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "loombre-av1-integration-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("TIER-0 REFUSAL against the REAL probe battery's output on this machine", async () => {
    const resolved = resolveFfmpeg();
    if (!resolved.ok) throw resolved.error;
    const ffmpegPath = resolved.binary.path;
    const runner = createRealCommandRunner();

    const encodersResult = await runner.run(ffmpegPath, buildListEncodersArgs(), { timeoutMs: 30_000 });
    const encoders = parseEncoderNames(encodersResult.stdout);

    // The REAL battery, over this platform's REAL §8.2 candidate list — no
    // fixture anywhere in this test's capability path.
    const battery = await runProbeBattery({
      backends: candidatesForPlatform(process.platform, process.arch),
      runCommand: runner,
      probeFile: probeFileReal,
      ffmpegPath,
      workDir,
      clock: Date.now,
      encoders,
    });
    const caps = toVerifiedCapabilities(battery);

    // THE MACHINE FACT this test rests on, asserted rather than assumed:
    // no NON-SOFTWARE backend on this box verified av1 encode. If someone
    // ever runs this suite on a box with a real AV1 encode engine, this
    // assertion fails loudly instead of the test quietly proving nothing.
    const hwAv1 = caps.backends.filter((b) => b.backend !== "software" && b.encode.includes("av1"));
    expect(
      hwAv1.map((b) => b.backend),
      "this machine reports HARDWARE av1 encode — the tier-0 refusal path cannot be proven here; move this assertion to the CI runner that has it",
    ).toEqual([]);

    // Therefore §7.2's gate must say 'none' at tier 0 — and, because the
    // 'software' arm requires tier >= 1 by definition, it must say so even
    // if this ffmpeg's libsvtav1 encode test passed.
    expect(av1EncodeEligibility(caps, 0)).toBe("none");

    // ...and the whole plan must be av1-free, with the operator opt-in ON.
    const result = plan(makeInput(caps, { policy: makePolicy({ tier: 0 }) }));
    expect(result.decision).toBe("transcode");
    expect(result.ladder.length).toBeGreaterThan(0);
    expect(result.ladder.some((r) => r.codec === "av1"), JSON.stringify(result.ladder)).toBe(false);
    expect(result.video.targetCodec).not.toBe("av1");
    for (const name of AV1_ENCODER_NAMES) {
      expect(result.ffmpegArgs.includes(name), `tier-0 plan emitted "${name}"`).toBe(false);
    }

    // And the ARGS IT DID EMIT really run — a refusal that produced an
    // unrunnable command would be no better than the thing it refused.
    const dir = mkdtempSync(join(tmpdir(), "av1-t0-refusal-"));
    try {
      const source = generateSource(ffmpegPath, dir);
      const run = spawnSync(ffmpegPath, ["-y", ...substituteTokens(result.ffmpegArgs, dir, source)], {
        encoding: "utf8",
        timeout: RUN_TIMEOUT_MS,
      });
      expect(run.status, `the tier-0 fallback plan failed to run:\n${run.stderr ?? ""}`).toBe(0);
      const ffprobe = resolveFfprobe();
      if (!ffprobe.ok) throw ffprobe.error;
      expect(probeVideoCodec(ffprobe.binary.path, join(dir, "media.m3u8"))).not.toBe("av1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it("TIER-1 SOFTWARE AV1 end-to-end: the production plan() -> buildFfmpegArgs() argv really produces AV1", async () => {
    const resolved = resolveFfmpeg();
    if (!resolved.ok) throw resolved.error;
    const ffmpegPath = resolved.binary.path;
    const runner = createRealCommandRunner();

    const encodersResult = await runner.run(ffmpegPath, buildListEncodersArgs(), { timeoutMs: 30_000 });
    const encoders = parseEncoderNames(encodersResult.stdout);
    // D4: this is the ONE software av1 encoder a plan may ever name.
    expect(
      encoders.has("libsvtav1"),
      "this ffmpeg build has no libsvtav1 — every vendored Loombre build compiles --enable-libsvtav1",
    ).toBe(true);

    // The capability fact stated the way the probe states it. (The full
    // software battery is exercised by hwcaps/real-battery.integration; what
    // matters here is that the ENGINE is handed a software-av1-capable
    // snapshot and the resulting argv survives real execution.)
    const caps: VerifiedCapabilities = {
      backends: [
        { backend: "software", decode: ["h264", "hevc", "av1"], encode: ["h264", "hevc", "av1"], toneMap: [], verifiedAtMs: Date.now() },
      ],
    };
    expect(av1EncodeEligibility(caps, 1)).toBe("software");

    const result = plan(makeInput(caps));
    expect(result.decision).toBe("transcode");
    expect(result.video.targetCodec).toBe("av1");
    expect(result.video.encoder).toBe("software");
    expect(result.ladder).toEqual([
      // ×0.6 of the configured 400,000 h264 rung (§7.1's D3 factor).
      { heightPx: 240, videoBitrateBps: 240_000, audioBitrateBps: 160_000, codec: "av1" },
    ]);
    expect(result.ffmpegArgs).toContain("libsvtav1");
    expect(result.ffmpegArgs[result.ffmpegArgs.indexOf("-preset") + 1]).toBe("10");
    // §6 interpretation M's two negatives, asserted on the argv that is
    // about to be executed rather than only in a golden.
    expect(result.ffmpegArgs).not.toContain("-level");
    expect(result.ffmpegArgs).not.toContain("-tag:v");

    const dir = mkdtempSync(join(tmpdir(), "av1-t1-software-"));
    try {
      const source = generateSource(ffmpegPath, dir);
      const run = spawnSync(ffmpegPath, ["-y", ...substituteTokens(result.ffmpegArgs, dir, source)], {
        encoding: "utf8",
        timeout: RUN_TIMEOUT_MS,
      });
      expect(run.status, `libsvtav1 transcode failed:\n${run.stderr ?? ""}`).toBe(0);

      const ffprobe = resolveFfprobe();
      if (!ffprobe.ok) throw ffprobe.error;
      // THE ORACLE: the bytes on disk really are AV1, not "ffmpeg exited 0".
      expect(probeVideoCodec(ffprobe.binary.path, join(dir, "media.m3u8"))).toBe("av1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it("av1 + ts-hls throws descriptively, and plan() can never construct that pairing", () => {
    const caps: VerifiedCapabilities = {
      backends: [
        { backend: "software", decode: ["h264", "hevc", "av1"], encode: ["h264", "hevc", "av1"], toneMap: [], verifiedAtMs: Date.now() },
      ],
    };

    // Hand-built inconsistent shape -> interpretation-J descriptive throw.
    const input = makeInput(caps);
    expect(() =>
      buildFfmpegArgs(
        input,
        {
          container: "ts-hls",
          video: { action: "transcode", targetCodec: "av1", encoder: "software" },
          audio: { action: "none" },
          subtitle: { strategy: "none" },
          rung: { heightPx: 240, videoBitrateBps: 240_000, audioBitrateBps: 160_000, codec: "av1" },
        },
        { withSeek: false },
      ),
    ).toThrow(/av1.*ts-hls|ts-hls.*av1/s);

    // Through plan(), the same ts-hls client simply never gets an av1 rung:
    // §7.1's condition 2 refuses AV1 targeting for a device that cannot take
    // fmp4, so the throw above is unreachable in production.
    const tsOnly = plan(
      makeInput(caps, {
        device: makeDevice({ hls: { container: "ts", supportsFmp4: false, lowLatency: false } }),
      }),
    );
    expect(tsOnly.container).toBe("ts-hls");
    expect(tsOnly.ladder.some((r) => r.codec === "av1")).toBe(false);
    expect(tsOnly.video.targetCodec).not.toBe("av1");
    for (const name of AV1_ENCODER_NAMES) expect(tsOnly.ffmpegArgs).not.toContain(name);
  });
});
