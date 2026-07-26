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
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractMediaInfo } from "../../src/probe/extract.js";
import { resolveFfprobe, runFfprobe } from "../../src/probe/ffprobe.js";
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
    const tsEntry = manifest.files.find((f) => f.container === "ts");
    expect(tsEntry, "expected a .ts fixture in the manifest").toBeDefined();
    expect(tsEntry?.interlaced).toBe(true);
  });
});

describe.skipIf(toolsAvailable)("probe pipeline integration (skipped: ffmpeg/ffprobe unavailable)", () => {
  it("is skipped cleanly, not failing, when the tooling is absent", () => {
    expect(toolsAvailable).toBe(false);
  });
});
