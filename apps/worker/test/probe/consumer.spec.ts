// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/probe/consumer.spec.ts
//
// Live-DB integration test for the 'probe' job handler (deliverable B,
// docs/PLAN.md §8.3/P1.5): generated fixture -> runProbe() -> typed
// media_streams rows in the DB match the fixture's expected properties
// (including the migrations/0002 hdr/dv_profile/dv_bl_compat_id/has_atmos/
// interlaced columns), and the raw ffprobe JSON is stored on media_files.
// Skips cleanly (whole describe block, not individual assertions) without
// ffprobe/ffmpeg — mirrors test/probe/probe.integration.spec.ts's own
// convention exactly (same fixture generator, same skip condition).

import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMediaFileById } from "@loombre/db/internal";
import { runProbe } from "../../src/probe/consumer.js";
import { resolveFfprobe } from "../../src/probe/ffprobe.js";
import { createLibrary, makeDb, makeRawClient, resetSchema } from "../scan/helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const MEDIA_DIR = join(REPO_ROOT, "test-fixtures", "media");

interface ManifestEntry {
  file: string;
  container: string;
  videoCodec?: string;
  audioCodec?: string;
  subtitleCodec?: string;
  channels?: number;
  interlaced?: boolean;
  bitDepth?: number;
}

const ffprobeAvailable = resolveFfprobe().ok;
const ffmpegAvailable = ffmpegAvailableStrict();
const toolsAvailable = ffprobeAvailable && ffmpegAvailable;

describe.skipIf(!toolsAvailable)("probe consumer integration (real ffmpeg/ffprobe)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let manifestFiles: ManifestEntry[];
  let libraryId: string;

  beforeAll(async () => {
    execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
    const manifestPath = join(MEDIA_DIR, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: ManifestEntry[] };
    manifestFiles = manifest.files;
    expect(manifestFiles.length).toBeGreaterThan(0);

    resetSchema();
    await raw.connect();
    libraryId = await createLibrary(raw, { name: "Probe Consumer Test Library", mediaKind: "movie", paths: [MEDIA_DIR] });
  }, 60_000);

  afterAll(async () => {
    await dbHandle.destroy();
    await raw.end();
  });

  // media_files.path is UNIQUE (D16 identity) — this suite probes the same
  // manifest entry from more than one `it()`, so seeding is upsert-by-path
  // (idempotent) rather than a bare INSERT, matching how the real scanner
  // would also never create two rows for the same on-disk path.
  async function seedMediaFile(entry: ManifestEntry): Promise<string> {
    const filePath = join(MEDIA_DIR, entry.file);
    const now = Date.now();
    const item = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', $2, $2, $3, $3) RETURNING id`,
      [libraryId, entry.file, now]
    );
    const itemId = item.rows[0]!.id;
    const file = await raw.query<{ id: string }>(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (path) DO UPDATE SET content_hash = excluded.content_hash
       RETURNING id`,
      [itemId, filePath, `probe-test-${entry.file}`, statSync(filePath).size]
    );
    return file.rows[0]!.id;
  }

  it("stores raw ffprobe JSON + derives duration/container, and writes typed media_streams incl. 0002 columns", async () => {
    const mp4Entry = manifestFiles.find((f) => f.file === "h264_aac.mp4");
    expect(mp4Entry, "expected h264_aac.mp4 in the manifest").toBeDefined();
    const fileId = await seedMediaFile(mp4Entry!);

    await runProbe({ db: dbHandle }, { mediaFileId: fileId });

    const fileRow = await getMediaFileById(dbHandle, fileId);
    expect(fileRow?.probe).not.toBeNull();
    expect((fileRow?.probe as { format?: unknown })?.format).toBeDefined();
    expect(fileRow?.probed_at_ms).not.toBeNull();
    expect(fileRow?.duration_ms).toBeGreaterThan(0);
    expect(fileRow?.container).toBe("mp4");

    const streams = await raw.query<{
      stream_type: string;
      codec: string;
      channels: number | null;
      hdr: string | null;
      dv_profile: number | null;
      dv_bl_compat_id: number | null;
      has_atmos: boolean | null;
      interlaced: boolean | null;
    }>("SELECT * FROM media_streams WHERE file_id = $1 ORDER BY stream_index", [fileId]);

    expect(streams.rows.length).toBeGreaterThanOrEqual(2); // at least video + audio

    const video = streams.rows.find((s) => s.stream_type === "video");
    expect(video?.codec).toBe("h264");
    expect(video?.hdr).toBe("none");
    expect(video?.dv_profile).toBeNull();
    expect(video?.dv_bl_compat_id).toBeNull();
    expect(video?.interlaced).toBe(false);

    const audio = streams.rows.find((s) => s.stream_type === "audio");
    expect(audio?.codec).toBe("aac");
    expect(audio?.channels).toBe(2);
    expect(audio?.has_atmos).toBe(false);
  }, 30_000);

  it("detects the interlaced mpeg2 transport-stream fixture via the 0002 `interlaced` column", async () => {
    const tsEntry = manifestFiles.find((f) => f.container === "ts");
    expect(tsEntry, "expected a .ts fixture in the manifest").toBeDefined();
    const fileId = await seedMediaFile(tsEntry!);

    await runProbe({ db: dbHandle }, { mediaFileId: fileId });

    const streams = await raw.query<{ stream_type: string; interlaced: boolean | null }>(
      "SELECT stream_type, interlaced FROM media_streams WHERE file_id = $1",
      [fileId]
    );
    const video = streams.rows.find((s) => s.stream_type === "video");
    expect(video?.interlaced).toBe(true);
  }, 30_000);

  it("re-probing a file atomically replaces its media_streams rows (no duplicate/stale rows)", async () => {
    const mp4Entry = manifestFiles.find((f) => f.file === "h264_aac.mp4")!;
    const fileId = await seedMediaFile(mp4Entry);

    await runProbe({ db: dbHandle }, { mediaFileId: fileId });
    const firstCount = await raw.query<{ n: string }>("SELECT count(*)::text AS n FROM media_streams WHERE file_id = $1", [fileId]);

    await runProbe({ db: dbHandle }, { mediaFileId: fileId });
    const secondCount = await raw.query<{ n: string }>("SELECT count(*)::text AS n FROM media_streams WHERE file_id = $1", [fileId]);

    expect(secondCount.rows[0]!.n).toBe(firstCount.rows[0]!.n);
  }, 30_000);

  it("fails cleanly (rejects, does not crash) for a media_files row that does not exist", async () => {
    await expect(runProbe({ db: dbHandle }, { mediaFileId: "018f0000-0000-7000-8000-00000000dead" })).rejects.toThrow();
  });
});

describe.skipIf(toolsAvailable)("probe consumer integration (skipped: ffmpeg/ffprobe unavailable)", () => {
  it("is skipped cleanly, not failing, when the tooling is absent", () => {
    expect(toolsAvailable).toBe(false);
  });
});

// Deterministic (no ffmpeg needed): drive runProbe through its runFfprobe
// seam with the checked-in HDR10 raw fixture and assert the media_streams
// video row carries BOTH the derived typed `hdr` enum AND the raw
// `color_transfer` column. PLAN §6.3 lists color_transfer as a stored
// field; the §2.1 typed VideoStream drops it in favour of `hdr`, so the
// consumer backfills the column from raw — this is the regression guard for
// that (found empty during the §6 real-library validation on real HDR10
// HEVC content).
describe("probe consumer: color_transfer column backfill (PLAN §6.3)", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let libraryId: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    libraryId = await createLibrary(raw, {
      name: "Probe ColorTransfer Test Library",
      mediaKind: "movie",
      paths: ["/nonexistent/probe-color-transfer"],
    });
  }, 60_000);

  afterAll(async () => {
    await dbHandle.destroy();
    await raw.end();
  });

  it("writes color_transfer=smpte2084 AND hdr=hdr10 for an HDR10 HEVC stream", async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "raw", "02_hevc10_hdr10.json"), "utf8"),
    );
    const now = Date.now();
    const item = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', 'HDR10 Sample', 'HDR10 Sample', $2, $2) RETURNING id`,
      [libraryId, now],
    );
    const fileRow = await raw.query<{ id: string }>(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes)
       VALUES ($1, '/nonexistent/probe-color-transfer/hdr10.mkv', 'ct-test', 1024) RETURNING id`,
      [item.rows[0]!.id],
    );
    const fileId = fileRow.rows[0]!.id;

    await runProbe({ db: dbHandle, runFfprobe: async () => fixture }, { mediaFileId: fileId });

    const streams = await raw.query<{ hdr: string | null; color_transfer: string | null }>(
      "SELECT hdr, color_transfer FROM media_streams WHERE file_id = $1 AND stream_type = 'video'",
      [fileId],
    );
    expect(streams.rows).toHaveLength(1);
    expect(streams.rows[0]!.hdr).toBe("hdr10");
    expect(streams.rows[0]!.color_transfer).toBe("smpte2084");
  });
});
