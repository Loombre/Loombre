// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session-integration-style test for the probe pipeline (not pure): runs
 * the checked-in fixture generator (scripts/gen-media-fixtures.mjs)
 * against real ffmpeg/ffprobe, then probes + extracts each produced file
 * and checks it against the generator's own manifest.json. Skips cleanly
 * — the whole describe block, not individual assertions — when ffprobe or
 * ffmpeg isn't available (this repo's CI runners don't provision ffmpeg;
 * see docs/PLAYBACK.md §10's "Session integration tests" note that these
 * run on all three OS CI runners for the *session* layer once it exists —
 * this probe-level version degrades to local-dev-only until then).
 */
import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractMediaInfo } from "../../src/probe/extract.js";
import { resolveFfprobe, runFfprobe } from "../../src/probe/ffprobe.js";
import { ProbeError } from "../../src/probe/errors.js";
import type { Container, AudioCodec, VideoCodec } from "../../src/probe/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const MEDIA_DIR = join(REPO_ROOT, "test-fixtures", "media");

interface ManifestEntry {
  file: string;
  container: Container;
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  subtitleCodec?: string;
  channels?: number;
  interlaced?: boolean;
  bitDepth?: number;
}

interface Manifest {
  generatedAt: string | null;
  files: ManifestEntry[];
}

const ffprobeAvailable = resolveFfprobe().ok;
const ffmpegAvailable = ffmpegAvailableStrict();
const toolsAvailable = ffprobeAvailable && ffmpegAvailable;

describe.skipIf(!toolsAvailable)("probe pipeline integration (real ffmpeg/ffprobe)", () => {
  let manifest: Manifest;

  beforeAll(() => {
    // Reuses existing output when already generated (idempotent — no
    // --force), so repeated local runs are fast.
    execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
    const manifestPath = join(MEDIA_DIR, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(manifest.files.length).toBeGreaterThan(0);
  }, 60_000);

  it("manifest lists every fixture family the generator targets", () => {
    const containers = new Set(manifest.files.map((f) => f.container));
    for (const expected of ["mp4", "mkv", "ts", "webm", "flac", "mp3", "m4a"] as const) {
      expect(containers.has(expected)).toBe(true);
    }
  });

  // STATE.md H3 — v1.1 legacy-format reinstatement: each reinstated
  // extension must probe to the RIGHT Container value against REAL
  // ffprobe output (not just the FORMAT_FACTS unit-test table).
  it("each v1.1-reinstated legacy format probes to the right Container value", () => {
    const containers = new Map(manifest.files.map((f) => [f.file, f.container]));
    expect(containers.get("wmv2_wmav2.wmv")).toBe("asf");
    expect(containers.get("mpeg2video_mp2.mpg")).toBe("mpeg");
    expect(containers.get("mpeg2_ac3.vob")).toBe("mpeg");
    expect(containers.get("h264_aac.flv")).toBe("flv");
    expect(containers.get("audio.aac")).toBe("aac");
    expect(containers.get("audio.aiff")).toBe("aiff");
  });

  // Owner ledger L1: .mts probes to the same Container as .m2ts/.ts
  // (mpegts family) against REAL ffprobe output.
  it("the .mts admission (owner ledger L1) probes to the 'ts' Container value", () => {
    const containers = new Map(manifest.files.map((f) => [f.file, f.container]));
    expect(containers.get("h264_aac.mts")).toBe("ts");
  });

  it("probes + extracts every manifest entry and matches its declared properties", async () => {
    for (const entry of manifest.files) {
      const filePath = join(MEDIA_DIR, entry.file);
      expect(existsSync(filePath), `${entry.file} should exist`).toBe(true);

      const raw = await runFfprobe(filePath);
      const sizeBytes = statSync(filePath).size;
      const info = extractMediaInfo(raw, { sizeBytes, fileId: entry.file, filenameHint: entry.file });

      expect(info.container, entry.file).toBe(entry.container);
      expect(info.sizeBytes, entry.file).toBe(sizeBytes);
      expect(info.durationMs, entry.file).toBeGreaterThan(0);

      if (entry.videoCodec) {
        expect(info.video[0]?.codec, entry.file).toBe(entry.videoCodec);
      } else {
        expect(info.video, entry.file).toHaveLength(0);
      }

      if (entry.audioCodec) {
        expect(info.audio[0]?.codec, entry.file).toBe(entry.audioCodec);
      }

      if (entry.channels !== undefined) {
        expect(info.audio[0]?.channels, entry.file).toBe(entry.channels);
      }

      if (entry.interlaced !== undefined) {
        expect(info.video[0]?.interlaced, entry.file).toBe(entry.interlaced);
      }

      if (entry.bitDepth !== undefined) {
        expect(info.video[0]?.bitDepth, entry.file).toBe(entry.bitDepth);
      }

      if (entry.subtitleCodec) {
        expect(info.subtitle.some((s) => s.codec === entry.subtitleCodec), entry.file).toBe(true);
      }
    }
  }, 30_000);

  it("the mpeg2 transport-stream fixture is genuinely detected as interlaced", () => {
    // The interlaced ts fixture must be PRESENT (generated), not silently
    // skipped: a bare container==="ts" find would match the progressive h264
    // .ts and read interlaced=false. Selecting on interlaced===true and
    // asserting existence proves mpeg2_interlaced_ac3.ts actually generated on
    // this ffmpeg build (the regression that broke the Windows CI leg).
    const tsEntry = manifest.files.find((f) => f.container === "ts" && f.interlaced === true);
    expect(tsEntry, "expected an interlaced .ts fixture (mpeg2_interlaced_ac3.ts) in the manifest").toBeDefined();
  });
});

// Owner ledger L1, adjudication A-5(b) — the honest text-file test chain's
// probe-layer link, against REAL ffprobe (not the fake-binary fixture
// ffprobe.spec.ts's own "nonzero-exit" test uses). A plain-text file
// wearing an admitted video extension (.mts — the extension L1 widened;
// nothing below is .mts-specific, any admitted extension behaves the
// same) is exactly what the scanner ingests without complaint (see
// apps/worker/test/scan/garbage-file-ingestion.spec.ts, A-5a) — this
// proves the OTHER half of the premise correction: real ffprobe genuinely
// rejects it with a typed ProbeError('nonzero-exit'), which is what the
// queue's terminal-failure seam (A-3) and the probe.failed event (A-2)
// exist to make visible.
describe.skipIf(!toolsAvailable)("probe pipeline integration: garbage (non-media) file rejection (owner ledger L1, A-5b)", () => {
  it("real ffprobe rejects a plain-text file wearing an admitted .mts extension with ProbeError('nonzero-exit')", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loombre-probe-garbage-"));
    const garbageFile = join(dir, "Fake Camcorder Clip.mts");
    writeFileSync(garbageFile, "this is not a video file, just plain text pretending to be one\n");

    await expect(runFfprobe(garbageFile)).rejects.toMatchObject({ code: "nonzero-exit" });

    try {
      await runFfprobe(garbageFile);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProbeError);
    }
  });
});

describe.skipIf(toolsAvailable)("probe pipeline integration (skipped: ffmpeg/ffprobe unavailable)", () => {
  it("is skipped cleanly, not failing, when the tooling is absent", () => {
    expect(toolsAvailable).toBe(false);
  });
});
