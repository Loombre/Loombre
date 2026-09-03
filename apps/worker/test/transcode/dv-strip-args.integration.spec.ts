// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/dv-strip-args.integration.spec.ts
//
// REAL-EXECUTION verification of the Dolby Vision strip (LD-3 + LD-15,
// docs/PLAYBACK.md §3/§6). The engine has always FIRED the informational
// reason `dv-stripped-to-hdr10` on a DV profile-7/8 copy into a repackaged
// container, and both the reason taxonomy and PLAYBACK.md §3 described it
// as a "metadata strip in arg builder" — but the arg builder emitted
// nothing at all, so `-c:v copy` carried every DOVI RPU NAL unit straight
// through to the client. An HDR10-only device was handed a stream still
// signalling Dolby Vision, and for dual-layer profile 7 the entire
// enhancement layer came along too. This suite is the regression fence
// that makes the reason TRUE.
//
// It mirrors vt-tonemap-args.integration.spec.ts exactly in structure:
// build a real plan with the PURE engine, substitute the §6 tokens, run
// REAL ffmpeg, and inspect what actually landed on disk. Engine purity is
// untouched — this suite lives in the worker, which already owns the other
// real-ffmpeg integration suites.
//
// THE ORACLE (three independent probes; all three must be clean):
//   1. NAL scan  — zero HEVC UNSPEC62 (RPU) and UNSPEC63 (enhancement
//      layer) units in the produced segments.
//      NOTE, EMPIRICAL (2026-08-11): this probe reads the Annex-B bytes
//      DIRECTLY rather than using ffmpeg's `trace_headers` bsf. CBS never
//      decomposes unspecified NAL types, so trace_headers emits no
//      nal_unit_type line for 62/63 at all — a trace_headers-based probe
//      is structurally BLIND to exactly the units this oracle exists to
//      find, and would have reported a clean stream over a fully intact
//      RPU. apps/worker/src/probe/opengop.ts's trace_headers scan is
//      correct for ITS purpose (types 8/9/16-21 are all specified).
//   2. Container record — no "DOVI configuration record" in the output's
//      stream side data.
//   3. Per-frame side data — no "Dolby Vision RPU Data" / "Dolby Vision
//      Metadata" on any frame.
// Plus the sample-entry fourcc: a DV rip's video sample entry is
// `dvh1`/`dvhe`, which is itself DV signalling; the output must be `hvc1`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildFfmpegArgs,
  plan,
  type DeviceProfile,
  type MediaInfo,
  type PlanInput,
  type VideoStream,
} from "@loombre/playback-engine";
import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { resolveFfmpeg, resolveFfprobe } from "../../src/probe/ffprobe.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const FIXTURE_DIR = join(REPO_ROOT, "test-fixtures", "media");
const DV81_FIXTURE = join(FIXTURE_DIR, "dv81_hevc_hdr10_compat.mp4");
const DV7_FIXTURE = join(FIXTURE_DIR, "dv7_dual_layer.mp4");

const ffmpegAvailable = ffmpegAvailableStrict();
const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);
const RUN_TIMEOUT_MS = 60_000 * TIME_SCALE;

/** DV fixtures need only ffmpeg + libx265: the generator falls back to its
 *  own synthetic UNSPEC62/63 splice when dovi_tool is absent, so this
 *  suite has no second tool gate — the CI floor tier always runs. Mirrors
 *  require-ffmpeg.ts's posture: a fixture that cannot be built is a loud
 *  skip locally and a HARD failure under LOOMBRE_REQUIRE_FFMPEG, so a
 *  regression fence can never go dark unnoticed on the gate. */
function ensureFixtures(): boolean {
  if (!ffmpegAvailable) return false;
  if (existsSync(DV81_FIXTURE) && existsSync(DV7_FIXTURE)) return true;
  spawnSync(process.execPath, [GEN_SCRIPT], { encoding: "utf8", timeout: RUN_TIMEOUT_MS * 4 });
  const ok = existsSync(DV81_FIXTURE) && existsSync(DV7_FIXTURE);
  if (!ok) {
    const msg =
      "dv-strip-args.integration: Dolby Vision fixtures could not be generated " +
      `(expected ${DV81_FIXTURE} and ${DV7_FIXTURE}). Run scripts/gen-media-fixtures.mjs; ` +
      "libx265 is required, dovi_tool optional.";
    if (process.env["LOOMBRE_REQUIRE_FFMPEG"]) throw new Error(`LOOMBRE_REQUIRE_FFMPEG is set: ${msg}`);
    console.warn(msg);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Plan input: a DV profile-7/8 hevc source whose CONTAINER the device cannot
// direct-play, against an HDR10-capable / DV-INCAPABLE device. That is
// exactly Stage C's strip branch (matrix cases 165/174/175): video stays a
// COPY, the decision is direct-stream, and `dv-stripped-to-hdr10` fires
// because Stage A required repackaging.
// ---------------------------------------------------------------------------

function videoStream(overrides: Partial<VideoStream>): VideoStream {
  return {
    index: 0,
    codec: "hevc",
    profile: "main10",
    level: 123,
    width: 320,
    height: 240,
    bitDepth: 10,
    frameRate: 24,
    bitrateBps: 2_000_000,
    hdr: "dv",
    dvProfile: 8,
    dvBlCompatId: 1,
    interlaced: false,
    openGop: false,
    ...overrides,
  };
}

function makeMedia(video: VideoStream): MediaInfo {
  return {
    fileId: "dv-strip-int",
    // mp4 on disk, but declared as a container the device below does NOT
    // direct-play so Stage A forces the repackage the strip rides on.
    container: "mkv",
    durationMs: 2_000,
    sizeBytes: 97_299,
    overallBitrateBps: 2_100_000,
    video: [video],
    audio: [],
    subtitle: [],
  };
}

/** HDR10 yes, Dolby Vision NO — the device that must never see an RPU. */
function makeDevice(): DeviceProfile {
  return {
    profileId: "dv-strip-int-hdr10-only",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      { codec: "hevc", maxProfile: "main10", maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ],
    hdr: { hdr10: true, hlg: true, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 6, passthrough: true }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

function makeInput(video: VideoStream): PlanInput {
  return {
    media: makeMedia(video),
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
      ladderRungs: [{ heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" }],
      segmentDurationSec: 2,
      hevcEncodePreferred: false,
    },
    caps: {
      backends: [
        { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1_750_000_000_000 },
      ],
    },
    selection: { videoStreamIndex: 0, audioStreamIndex: null, subtitleStreamIndex: null },
    mode: "stream",
  };
}

function substituteTokens(args: string[], sessionDir: string, fixture: string, seekSeconds = "0"): string[] {
  const substituted = args.map((arg) =>
    arg
      .replaceAll("{INPUT}", fixture)
      .replaceAll("{SESSION_DIR}", sessionDir)
      .replaceAll("{SEG_DUR}", "1")
      .replaceAll("{START_SEG}", "0")
      .replaceAll("{SEEK_SECONDS}", seekSeconds),
  );
  for (const arg of substituted) {
    expect(arg, `token survived substitution: ${arg}`).not.toContain("{");
  }
  return substituted;
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

interface DvResidue {
  rpuNalCount: number;
  elNalCount: number;
  containerRecord: string;
  codecTag: string;
  frameSideData: string;
}

function probeDvResidue(target: string): DvResidue {
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  if (!ffmpeg.ok || !ffprobe.ok) throw new Error("ffmpeg/ffprobe unresolvable inside a gated suite");
  const ffmpegPath = ffmpeg.binary.path;
  const ffprobePath = ffprobe.binary.path;

  // Probe 1 — Annex-B byte scan (see this file's header for why NOT
  // trace_headers).
  const dir = mkdtempSync(join(tmpdir(), "dv-oracle-"));
  const esPath = join(dir, "es.hevc");
  spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", target, "-map", "0:v:0", "-c:v", "copy", "-f", "hevc", esPath], { timeout: RUN_TIMEOUT_MS });
  let rpuNalCount = 0;
  let elNalCount = 0;
  if (existsSync(esPath)) {
    const es = readFileSync(esPath);
    for (let i = 0; i + 4 < es.length; i += 1) {
      if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1) {
        const nalType = (es[i + 3]! >> 1) & 0x3f;
        if (nalType === 62) rpuNalCount += 1;
        if (nalType === 63) elNalCount += 1;
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });

  // Probes 2 + 3 — ffprobe stream side data and per-frame side data.
  const streams = spawnSync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-select_streams", "v:0", target], { encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  let containerRecord = "none";
  let codecTag = "?";
  try {
    const s = JSON.parse(streams.stdout).streams[0];
    codecTag = String(s.codec_tag_string ?? "?");
    const hits = (s.side_data_list ?? []).filter((sd: unknown) => /dolby|dovi/i.test(JSON.stringify(sd)));
    if (hits.length > 0) containerRecord = JSON.stringify(hits);
  } catch {
    containerRecord = "probe-parse-failed";
  }

  const frames = spawnSync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_frames", "-read_intervals", "%+#8", "-select_streams", "v:0", target], { encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  let frameSideData = "none";
  try {
    const parsed = JSON.parse(frames.stdout).frames ?? [];
    const types = new Set<string>();
    for (const f of parsed) for (const sd of f.side_data_list ?? []) types.add(String(sd.side_data_type));
    const dv = [...types].filter((t) => /dolby|dovi/i.test(t));
    if (dv.length > 0) frameSideData = dv.join(" + ");
  } catch {
    frameSideData = "probe-parse-failed";
  }

  return { rpuNalCount, elNalCount, containerRecord, codecTag, frameSideData };
}

function runPipeline(fixture: string, video: VideoStream, withSeek: boolean): { args: string[]; playlist: string; dir: string } {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg.ok) throw new Error("ffmpeg unresolvable inside a gated suite");
  const dir = mkdtempSync(join(tmpdir(), "dv-strip-run-"));
  const result = plan(makeInput(video));
  expect(result.decision, JSON.stringify(result.reasons)).toBe("direct-stream");
  expect(result.video.action).toBe("copy");
  expect(result.reasons.map((r) => r.code)).toContain("dv-stripped-to-hdr10");

  const args = buildFfmpegArgs(
    makeInput(video),
    { container: result.container as "fmp4-hls", video: result.video, audio: result.audio, subtitle: result.subtitle },
    { withSeek },
  );
  const substituted = substituteTokens(args, dir, fixture);
  const run = spawnSync(ffmpeg.binary.path, ["-y", ...substituted], { encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  expect(run.status, `ffmpeg failed:\n${run.stderr ?? ""}`).toBe(0);
  return { args, playlist: join(dir, "media.m3u8"), dir };
}

// ---------------------------------------------------------------------------

let fixturesReady = false;
beforeAll(() => {
  fixturesReady = ensureFixtures();
}, 600_000);

describe.skipIf(!ffmpegAvailable)("Dolby Vision strip — real ffmpeg (LD-3 / LD-15)", () => {
  it("the FIXTURES really carry Dolby Vision (guards the oracle against passing on an empty stream)", () => {
    if (!fixturesReady) return;
    const dv81 = probeDvResidue(DV81_FIXTURE);
    expect(dv81.rpuNalCount, "profile 8.1 fixture must carry RPU NAL units").toBeGreaterThan(0);
    expect(dv81.containerRecord).not.toBe("none");
    expect(dv81.codecTag).toBe("dvh1");

    const dv7 = probeDvResidue(DV7_FIXTURE);
    expect(dv7.rpuNalCount, "profile 7 fixture must carry RPU NAL units").toBeGreaterThan(0);
    expect(dv7.elNalCount, "profile 7 fixture must carry ENHANCEMENT-LAYER NAL units").toBeGreaterThan(0);
  }, 600_000);

  it("profile 8.1 repackage leaves ZERO Dolby Vision residue", () => {
    if (!fixturesReady) return;
    const { playlist, dir } = runPipeline(DV81_FIXTURE, videoStream({ dvProfile: 8 }), false);
    try {
      const residue = probeDvResidue(playlist);
      expect(residue.rpuNalCount, "DOVI RPU NAL units survived the repackage").toBe(0);
      expect(residue.elNalCount).toBe(0);
      expect(residue.containerRecord, "container DOVI configuration record survived").toBe("none");
      expect(residue.frameSideData, "per-frame Dolby Vision side data survived").toBe("none");
      expect(residue.codecTag, "the DV sample-entry fourcc survived — dvh1/dvhe is itself DV signalling").toBe("hvc1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it("profile 7 DUAL-LAYER repackage drops the enhancement layer as well as the RPU (LD-15)", () => {
    if (!fixturesReady) return;
    const { playlist, dir } = runPipeline(DV7_FIXTURE, videoStream({ dvProfile: 7 }), false);
    try {
      const residue = probeDvResidue(playlist);
      expect(residue.rpuNalCount, "DOVI RPU NAL units survived").toBe(0);
      expect(residue.elNalCount, "enhancement-layer NAL units survived — the profile-7 EL was not dropped").toBe(0);
      expect(residue.containerRecord).toBe("none");
      expect(residue.frameSideData).toBe("none");
      expect(residue.codecTag).toBe("hvc1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it("open-GOP + DV compose into ONE -bsf:v — a second flag would silently overwrite the first", () => {
    if (!fixturesReady) return;
    // EMPIRICAL (2026-08-11): ffmpeg keeps only the LAST -bsf:v given for a
    // stream. Emitting the open-GOP strip and the DV strip as two separate
    // flags silently drops the open-GOP one — verified by running exactly
    // that and finding RASL NAL units 8/9 intact in the output. The builder
    // must therefore merge them into a single filter_units invocation.
    const { args, playlist, dir } = runPipeline(DV7_FIXTURE, videoStream({ dvProfile: 7, openGop: true }), true);
    try {
      const bsfFlags = args.filter((a) => a === "-bsf:v");
      expect(bsfFlags.length, `expected exactly one -bsf:v, got ${bsfFlags.length}: ${JSON.stringify(args)}`).toBe(1);
      const value = args[args.indexOf("-bsf:v") + 1]!;
      expect(value, "the merged value must strip RASL leading pictures").toMatch(/8-9/);
      expect(value, "the merged value must strip DV RPU + EL units").toMatch(/62-63/);

      const residue = probeDvResidue(playlist);
      expect(residue.rpuNalCount).toBe(0);
      expect(residue.elNalCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
