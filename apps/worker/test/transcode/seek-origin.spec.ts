// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/seek-origin.spec.ts
//
// The stream-copy seek landing probe (src/transcode/seek-origin.ts): pure
// parsing/arg-shape cases always; a real-ffmpeg case against the generated
// x264 fixture (a keyframe every second) when the tooling is present.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { resolveFfmpeg } from "../../src/probe/ffprobe.js";
import { measureCopySeekOriginMs, parseFramecrcFirstPts, seekOriginProbeArgs, videoTypeIndexFromArgs } from "../../src/transcode/seek-origin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const FIXTURE = join(REPO_ROOT, "test-fixtures", "media", "h264_opengop.mkv");

describe("parseFramecrcFirstPts", () => {
  it("scales the first packet's pts by the #tb timebase into milliseconds (mkv 1/1000, mp4 1/16000)", () => {
    expect(parseFramecrcFirstPts("#tb 0: 1/1000\n#media_type 0: video\n0,       1920,       2000,       40,     5399, 0x54d19734\n")).toBe(2000);
    expect(parseFramecrcFirstPts("#tb 0: 1/16000\n0,      61440,      64000,      640,     5375, 0xa61983b6\n")).toBe(4000);
    expect(parseFramecrcFirstPts("#tb 0: 1/1000\n0,        -80,          0,       40,     4748, 0x1853ce2d\n")).toBe(0);
  });

  it("returns null without a timebase or a packet line", () => {
    expect(parseFramecrcFirstPts("")).toBeNull();
    expect(parseFramecrcFirstPts("#tb 0: 1/1000\n")).toBeNull();
    expect(parseFramecrcFirstPts("0, 1, 2, 3, 4, 0x0\n")).toBeNull();
  });
});

describe("seekOriginProbeArgs / videoTypeIndexFromArgs", () => {
  it("is an input seek, one copied packet, source timestamps kept, framecrc to stdout", () => {
    expect(seekOriginProbeArgs({ ffmpegPath: "ffmpeg", filePath: "/m/a.mkv", videoTypeIndex: 1, seekTargetMs: 300_000 })).toEqual([
      "-hide_banner", "-nostdin", "-v", "error", "-ss", "300", "-i", "/m/a.mkv", "-map", "0:v:1", "-c", "copy", "-copyts", "-frames:v", "1", "-f", "framecrc", "-",
    ]);
  });

  it("reads the plan's own -map 0:v:N, defaulting to 0", () => {
    expect(videoTypeIndexFromArgs(["-ss", "1", "-i", "x", "-map", "0:v:2", "-map", "0:a:0"])).toBe(2);
    expect(videoTypeIndexFromArgs(["-i", "x", "-map", "0:a:0"])).toBe(0);
  });
});

const toolsAvailable = ffmpegAvailableStrict() && resolveFfmpeg().ok;

describe.skipIf(!toolsAvailable)("measureCopySeekOriginMs (real ffmpeg, generated x264 fixture)", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
  }, 60_000);

  function ffmpegPath(): string {
    const resolved = resolveFfmpeg();
    if (!resolved.ok) throw new Error("unreachable: guarded by skipIf");
    return resolved.binary.path;
  }

  it("lands on a keyframe at or before the target, never after — and 0 for a seek to 0", async () => {
    expect(await measureCopySeekOriginMs({ ffmpegPath: ffmpegPath(), filePath: FIXTURE, videoTypeIndex: 0, seekTargetMs: 2_500 })).toBe(2_000); // keyframes every 1s (keyint=25@25fps)
    expect(await measureCopySeekOriginMs({ ffmpegPath: ffmpegPath(), filePath: FIXTURE, videoTypeIndex: 0, seekTargetMs: 4_700 })).toBe(4_000);
    expect(await measureCopySeekOriginMs({ ffmpegPath: ffmpegPath(), filePath: FIXTURE, videoTypeIndex: 0, seekTargetMs: 0 })).toBe(0);
  }, 30_000);

  it("resolves null (caller falls back to the target) for an unreadable file", async () => {
    expect(await measureCopySeekOriginMs({ ffmpegPath: ffmpegPath(), filePath: "/definitely/not/here.mkv", videoTypeIndex: 0, seekTargetMs: 1_000 })).toBeNull();
  }, 15_000);
});
