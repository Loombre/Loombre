// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/codecs-string-fence.integration.spec.ts
//
// Wave C2 — THE CODECS EXECUTION FENCE (docs/PLAYBACK.md §9.1.1).
//
// §9.1.1 requires the master playlist's `CODECS` attribute to be "verified
// ONCE against ffprobe of real encoder output", and says why in one line:
// "a wrong CODECS string makes hls.js reject the variant, so the table must
// be execution-verified, not assumed."
//
// That failure mode is the reason this file exists rather than trusting the
// renderer's own goldens. A wrong CODECS string does not throw, does not
// 500, and does not appear in any log. MSE reports the variant unsupported,
// hls.js quietly drops it from `hls.levels`, and the viewer simply never
// gets that quality — a silent, permanent degradation that every unit test
// in the repo would stay green through, because the renderer would be
// perfectly self-consistent about the wrong answer.
//
// So: for each advertised rung, this spec builds the REAL ffmpeg argv the
// session layer would spawn, runs it against a real source until it has
// written a real fMP4 init segment, and ffprobes what came out. The
// comparison is against `renderMasterPlaylist`'s own strings — the exact
// bytes a client would receive.
//
// DIRECTION OF THE LEVEL CHECK, stated because it is asymmetric: declaring
// a level BELOW what the bitstream actually carries is the bug (a client
// that would have played it rejects it); declaring one above is merely
// conservative. The profile, by contrast, must match exactly — High vs
// High10 is a different decoder path, and getting it wrong fails in both
// directions.
//
// Skips cleanly without ffmpeg, and skips individual codecs whose encoder
// this build does not carry.

import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFfmpegArgs,
  type DeviceProfile,
  type LadderRung,
  type MediaInfo,
  type PlanInput,
} from "@loombre/playback-engine";
import { resolveFfmpeg } from "../../src/probe/ffprobe.js";
import { substituteTokens } from "../../src/transcode/args.js";
import { renderMasterPlaylist } from "../../../../apps/server/src/common/master-playlist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const FIXTURE_PATH = join(REPO_ROOT, "test-fixtures", "media", "session_long.mp4");

const ffmpegAvailable = ffmpegAvailableStrict();
const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);

/** MODULE scope, deliberately: vitest evaluates `it.skipIf(...)` at
 *  COLLECTION time, before any `beforeAll` has run. Resolving the encoder
 *  list inside `beforeAll` would leave it empty at the moment the skip
 *  predicates are read, and every codec would silently skip on a machine
 *  that has them — a green suite proving nothing, which is exactly the
 *  failure mode this fence exists to refuse. */
const ENCODER_LIST: string = (() => {
  if (!ffmpegAvailable) return "";
  const resolved = resolveFfmpeg();
  if (!resolved.ok) return "";
  return spawnSync(resolved.binary.path, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
})();
const hasEncoder = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(ENCODER_LIST);

interface ProbedVideo {
  codecName: string;
  codecTag: string;
  profile: string;
  level: number;
  bitsPerRawSample: number;
}

describe.skipIf(!ffmpegAvailable || process.platform === "win32")("master-playlist CODECS execution fence (§9.1.1)", () => {
  let ffmpegPath: string;
  let ffprobePath: string;
  let workDir: string;

  beforeAll(() => {
    execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
    const resolved = resolveFfmpeg();
    if (!resolved.ok) throw new Error("ffmpeg unresolvable after the availability gate said otherwise");
    ffmpegPath = resolved.binary.path;
    ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
    workDir = mkdtempSync(join(tmpdir(), "loombre-codecs-fence-"));
  }, 120_000 * TIME_SCALE);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function media(bitDepth: number): MediaInfo {
    return {
      fileId: "fence",
      container: "mp4",
      durationMs: 150_000,
      sizeBytes: 10_000_000,
      overallBitrateBps: 1_200_000,
      video: [
        {
          index: 0,
          codec: "h264",
          profile: "high",
          level: null,
          width: 320,
          height: 240,
          bitDepth,
          frameRate: 25,
          bitrateBps: 1_000_000,
          hdr: "none",
          dvProfile: null,
          dvBlCompatId: null,
          interlaced: false,
          openGop: false,
        },
      ],
      audio: [
        { index: 1, codec: "aac", channels: 2, sampleRate: 48000, bitrateBps: 128_000, language: null, isDefault: true, hasAtmos: false },
      ],
      subtitle: [],
    };
  }

  const device: DeviceProfile = {
    profileId: "fence-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    // No maxLevel anywhere: §6's `-level` emission is device-driven, and
    // leaving it unset is what forces the ENCODER to choose the level — so
    // what ffprobe reports is the encoder's own honest answer, not an echo
    // of something this test asked for.
    video: [
      { codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
      { codec: "hevc", maxProfile: "main10", maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
      { codec: "av1", maxProfile: null, maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };

  function planInput(bitDepth: number): PlanInput {
    return {
      media: media(bitDepth),
      device,
      network: { maxBitrateBps: 100_000_000, isLocal: true },
      policy: {
        allowTranscode: true,
        allowToneMapCpu: "always",
        tier: 2,
        preferredTextSubMode: "hls-vtt",
        preserveAssStyling: false,
        audioTranscodeCodecPriority: ["aac", "opus"],
        maxSimultaneousTranscodes: 1,
        ladderRungs: [],
        segmentDurationSec: 6,
        hevcEncodePreferred: false,
        av1EncodePreferred: false,
      },
      caps: { backends: [] },
      selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
      mode: "stream",
    };
  }

  /** Runs the REAL argv until it has written an init segment + at least one
   *  media segment, then stops it. Returns ffprobe's view of the init
   *  segment's video stream. */
  function encodeAndProbe(rung: LadderRung, bitDepth: number, label: string): ProbedVideo {
    const runDir = join(workDir, label);
    const args = substituteTokens(
      buildFfmpegArgs(planInput(bitDepth), {
        container: "fmp4-hls",
        video: { action: "transcode", targetCodec: rung.codec, encoder: "software" },
        audio: { action: "copy" },
        subtitle: { strategy: "none" },
        rung,
      }, { withSeek: false }),
      { input: FIXTURE_PATH, runDir, segDurSec: 6, startSeg: 0 },
    );

    // `-t 4` keeps the encode to a couple of segments; injected into the
    // GLOBAL options position (before `-i`), which is exactly where
    // args.ts's own readrate injection goes, so it cannot disturb the
    // output-side flags this fence is reading.
    const inputIdx = args.indexOf("-i");
    const bounded = [...args.slice(0, inputIdx), "-t", "4", ...args.slice(inputIdx)];

    mkdirSync(runDir, { recursive: true });
    const result = spawnSync(ffmpegPath, bounded, { encoding: "utf8", timeout: 120_000 * TIME_SCALE });
    if (result.status !== 0) {
      throw new Error(`ffmpeg failed for ${label} (exit ${result.status}):\n${result.stderr?.slice(-3000)}`);
    }

    // The init segment carries the decoder configuration record — the very
    // bytes a client's `MediaSource.isTypeSupported` verdict is about — but
    // an init segment ALONE has no samples, and ffprobe reports profile and
    // level only once it has parsed one. Concatenating init + the first
    // media segment is exactly what a client's SourceBuffer does, and it
    // makes the probe read the real decoder configuration record rather
    // than a container guess.
    const probePath = join(runDir, "probe.mp4");
    writeFileSync(probePath, Buffer.concat([readFileSync(join(runDir, "init.mp4")), readFileSync(join(runDir, "s000000.m4s"))]));
    const probe = spawnSync(
      ffprobePath,
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,codec_tag_string,profile,level,bits_per_raw_sample",
        "-of", "json",
        probePath,
      ],
      { encoding: "utf8" },
    );
    if (probe.status !== 0) throw new Error(`ffprobe failed for ${label}: ${probe.stderr}`);
    const stream = (JSON.parse(probe.stdout) as { streams: Record<string, unknown>[] }).streams[0]!;
    return {
      codecName: String(stream["codec_name"]),
      codecTag: String(stream["codec_tag_string"]),
      profile: String(stream["profile"]),
      level: Number(stream["level"]),
      bitsPerRawSample: Number(stream["bits_per_raw_sample"] ?? 8),
    };
  }

  /** The CODECS attribute a client really receives for this rung. */
  function advertisedCodecs(rung: LadderRung, bitDepth: number): string {
    const text = renderMasterPlaylist({
      ladder: [rung],
      video: { widthPx: 320, heightPx: 240, frameRate: 25, bitDepth, codec: "h264" },
      audio: { codec: "aac", bitrateBps: 128_000 },
      overallBitrateBps: 1_200_000,
    });
    return /CODECS="([^"]*)"/.exec(text)![1]!;
  }

  it(
    "h264 8-bit: the advertised avc1 profile matches the real bitstream and the declared level is never BELOW it",
    { timeout: 180_000 * TIME_SCALE },
    () => {
      const rung: LadderRung = { heightPx: 240, videoBitrateBps: 600_000, audioBitrateBps: 128_000, codec: "h264" };
      const probed = encodeAndProbe(rung, 8, "h264-8bit");
      const codecs = advertisedCodecs(rung, 8);
      const [video, audio] = codecs.split(",");

      expect(probed.codecName).toBe("h264");
      expect(video!.startsWith("avc1.")).toBe(true);

      // profile_idc: the renderer says High (0x64) for 8-bit.
      expect(probed.profile).toBe("High");
      expect(video!.slice(5, 7)).toBe("64");

      // Level: declared >= actual. ffprobe reports the raw level_idc
      // (30 = 3.0, 31 = 3.1, ...), the string carries it as one hex byte.
      const declaredLevel = Number.parseInt(video!.slice(9, 11), 16);
      expect(
        declaredLevel,
        `advertised level 0x${video!.slice(9, 11)} (${declaredLevel}) must not be BELOW the encoder's own ${probed.level}`,
      ).toBeGreaterThanOrEqual(probed.level);

      // The audio half is the one a copied AAC track really is.
      expect(audio).toBe("mp4a.40.2");
    },
  );

  it.skipIf(!hasEncoder("libx265"))(
    "hevc 8-bit: the advertised hvc1 profile/tier matches the real bitstream, and the SAMPLE ENTRY really is hvc1",
    { timeout: 180_000 * TIME_SCALE },
    () => {
      const rung: LadderRung = { heightPx: 240, videoBitrateBps: 600_000, audioBitrateBps: 128_000, codec: "hevc" };
      const probed = encodeAndProbe(rung, 8, "hevc-8bit");
      const video = advertisedCodecs(rung, 8).split(",")[0]!;

      expect(probed.codecName).toBe("hevc");
      expect(video.startsWith("hvc1.")).toBe(true);
      // §6 emits `-tag:v hvc1`; the master advertises `hvc1.…`. If the
      // muxer had actually written `hev1` the two would disagree and
      // Safari in particular would refuse the variant — this is the one
      // assertion that catches that pairing coming apart.
      expect(probed.codecTag).toBe("hvc1");
      // Main profile (general_profile_idc 1) for 8-bit.
      expect(probed.profile).toBe("Main");
      expect(video.startsWith("hvc1.1.6.")).toBe(true);

      const declaredLevel = Number.parseInt(/L(\d+)/.exec(video)![1]!, 10);
      expect(declaredLevel, "declared general_level_idc must not be below the encoder's own").toBeGreaterThanOrEqual(probed.level);
    },
  );

  it.skipIf(!hasEncoder("libsvtav1"))(
    "av1: the advertised av01 profile and bit depth match the real bitstream",
    { timeout: 180_000 * TIME_SCALE },
    () => {
      const rung: LadderRung = { heightPx: 240, videoBitrateBps: 300_000, audioBitrateBps: 128_000, codec: "av1" };
      const probed = encodeAndProbe(rung, 8, "av1-8bit");
      const video = advertisedCodecs(rung, 8).split(",")[0]!;

      expect(probed.codecName).toBe("av1");
      // av01.<profile>.<levelTier>.<bitDepth>. Profile 0 is Main, which is
      // the only profile §6 interpretation M ever produces.
      expect(video.startsWith("av01.0.")).toBe(true);
      expect(probed.profile).toBe("Main");
      // The bit-depth field is two digits at the end.
      expect(video.endsWith(".08")).toBe(true);
      expect(probed.bitsPerRawSample).toBe(8);
    },
  );

  it(
    "the fence would CATCH a drifted table: a deliberately wrong profile byte does not match the real bitstream",
    { timeout: 180_000 * TIME_SCALE },
    () => {
      // Non-vacuity. Everything above compares two things this repo
      // produces; if the comparison were somehow trivially true it would
      // pass while proving nothing. Here the SAME probe is compared against
      // the string a High10 table would have emitted for the same 8-bit
      // encode — and it must NOT match.
      const rung: LadderRung = { heightPx: 240, videoBitrateBps: 600_000, audioBitrateBps: 128_000, codec: "h264" };
      const tenBitString = advertisedCodecs(rung, 10).split(",")[0]!;
      expect(tenBitString.slice(5, 7)).toBe("6e"); // High10, which the 8-bit encode is not
      const probed = encodeAndProbe(rung, 8, "h264-8bit-nonvacuity");
      expect(probed.profile).toBe("High");
      expect(tenBitString.slice(5, 7)).not.toBe("64");
    },
  );
});
