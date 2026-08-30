// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/subtitles/subtitle-extract.integration.spec.ts
//
// Integration-style test (not pure — REAL ffmpeg, real Postgres): drives
// apps/worker/src/subtitles/runner.ts's runSubtitleExtraction against the
// checked-in fixture generator's h264_aac_subrip.mkv (real embedded
// subrip subtitle stream), probed with the REAL apps/worker/src/probe
// pipeline (not hand-crafted media_streams rows) so the subtitle stream's
// index/codec come from real ffprobe output, not a guess. Mirrors
// apps/worker/test/transcode/session.integration.spec.ts's
// skip-cleanly-without-ffmpeg + self-sufficient live-DB-reset conventions.
//
// Exercises the P3.9(e)/deliverable-6 BIND directly: a DIRECT-PLAY session
// (this device is fully h264/aac/mkv-compatible) still gets a staging
// directory JUST for its hls-vtt subtitle side-track, proving subtitle
// extraction is independent of the transcode worker runtime ever running.

import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPlaybackSession, ensureTestDatabase, resolveTestDatabaseUrl } from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import { getMediaInfoForFile } from "@loombre/db/internal";
import {
  plan,
  type DeviceProfile,
  type NetworkConditions,
  type PlanInput,
  type ServerPolicy,
  type TrackSelection,
  type VerifiedCapabilities,
} from "@loombre/playback-engine";
import { runProbe } from "../../src/probe/consumer.js";
import { runSubtitleExtraction } from "../../src/subtitles/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const MEDIA_DIR = join(REPO_ROOT, "test-fixtures", "media");
const FIXTURE_PATH = join(MEDIA_DIR, "h264_aac_subrip.mkv");
const DB_PKG_ROOT = join(REPO_ROOT, "packages", "db");

// PER-SUITE DATABASE (Wave A / A1's recommendation, swept at pre-D
// consolidation). This suite RESETS the schema in its own hook; on the
// shared `<base>_test` database a sibling package's reset landing mid-run
// wipes it out from under whatever is executing and presents as a product
// bug. `ensureTestDatabase` gives it one of its own — resolved at module
// load (top-level await) so every describe-scope handle below is built
// against the right connection string.
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), "worker_subtitle_extract_test");
const ffmpegAvailable = ffmpegAvailableStrict();

function resetSchema(): void {
  const result = spawnSync(process.execPath, [join(DB_PKG_ROOT, "scripts", "migrate.mjs"), "reset"], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`migrate.mjs reset failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

function compatibleDeviceProfile(): DeviceProfile {
  return {
    profileId: "subtitle-extract-integration-device",
    directPlayContainers: ["mkv"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      { codec: "h264", maxProfile: null, maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    // hlsVtt true forces Stage E's hls-vtt branch REGARDLESS of renderText
    // (docs/PLAYBACK.md §3 Stage E TEXT cascade condition (a) is checked
    // first) — renderText stays empty deliberately, proving that.
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

/** Same shape, but hlsVtt false AND renderText includes 'subrip' — Stage E
 *  picks 'embed' instead, so a session built from this device never
 *  enqueues (or, here, never usefully runs) subtitle-extract. */
function embedOnlyDeviceProfile(): DeviceProfile {
  const base = compatibleDeviceProfile();
  return { ...base, subtitles: { renderText: ["subrip"], hlsVtt: false, renderImage: false } };
}

describe.skipIf(!ffmpegAvailable)("subtitle-extract runtime integration (real ffmpeg, real Postgres)", () => {
  let db: ReturnType<typeof createDb>;
  let raw: pg.Client;
  let stagingRoot: string;
  let ctx: ViewerContext;
  let deviceId: string;
  let itemId: string;
  let fileId: string;

  beforeAll(async () => {
    execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
    expect(existsSync(FIXTURE_PATH)).toBe(true);

    resetSchema();
    db = createDb(DATABASE_URL);
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();

    const now = Date.now();
    const userRow = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
       VALUES ('subtitle-extract-int-test', 'subtitle-extract-int@loombre.local', 'x', $1, $1) RETURNING id`,
      [now],
    );
    const userId = userRow.rows[0]!.id;

    const deviceRow = await raw.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'subtitle-extract-integration-device', $2, $3) RETURNING id`,
      [userId, JSON.stringify(compatibleDeviceProfile()), now],
    );
    deviceId = deviceRow.rows[0]!.id;

    const libRow = await raw.query<{ id: string }>(
      `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
       VALUES ('Subtitle Extract Integration Library', 'movie', '{}', $1, $1) RETURNING id`,
      [now],
    );
    const libraryId = libRow.rows[0]!.id;
    await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

    const itemRow = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', 'Subtitle Extract Integration Movie', 'subtitle extract integration movie', $2, $2) RETURNING id`,
      [libraryId, now],
    );
    itemId = itemRow.rows[0]!.id;

    const fileRow = await raw.query<{ id: string }>(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes)
       VALUES ($1, $2, 'subtitle-extract-int-hash', 1) RETURNING id`,
      [itemId, FIXTURE_PATH],
    );
    fileId = fileRow.rows[0]!.id;

    // REAL probe (not hand-crafted rows) — the subtitle stream's absolute
    // index/codec below come straight from ffprobe's own output.
    await runProbe({ db }, { mediaFileId: fileId });

    ctx = { userId, allowedLibraryIds: [libraryId], restrictedCleared: false, surface: "restricted" };
    stagingRoot = mkdtempSync(join(tmpdir(), "loombre-subtitle-extract-integration-"));
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await raw?.end();
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  async function buildPlanInput(device: DeviceProfile): Promise<{ input: PlanInput; selection: TrackSelection }> {
    const media = await getMediaInfoForFile(db, fileId);
    expect(media).toBeDefined();
    expect(media!.subtitle.length).toBeGreaterThan(0);
    const subtitleStream = media!.subtitle[0]!;
    expect(subtitleStream.codec).toBe("subrip");

    const selection: TrackSelection = {
      videoStreamIndex: media!.video[0]?.index ?? null,
      audioStreamIndex: media!.audio[0]?.index ?? null,
      subtitleStreamIndex: subtitleStream.index,
    };
    const network: NetworkConditions = { maxBitrateBps: 100_000_000, isLocal: true };
    const policy: ServerPolicy = {
      allowTranscode: true,
      allowToneMapCpu: "tier-gated",
      tier: 0,
      preferredTextSubMode: "hls-vtt",
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"],
      maxSimultaneousTranscodes: 10,
      ladderRungs: [],
      segmentDurationSec: 6,
      hevcEncodePreferred: false,
    };
    const caps: VerifiedCapabilities = { backends: [] };
    return {
      input: { media: media as unknown as PlanInput["media"], device, network, policy, caps, selection, mode: "stream" },
      selection,
    };
  }

  async function createSessionForDevice(device: DeviceProfile): Promise<{ sessionId: string; strategy: string }> {
    const { input, selection } = await buildPlanInput(device);
    const planResult = plan(input);
    const storedPlan = { ...planResult, selection };

    const session = await createPlaybackSession(db, ctx, {
      itemId,
      fileId,
      deviceId,
      plan: storedPlan,
      engineVersion: "test",
      nowMs: Date.now(),
    });
    expect(session).toBeDefined();
    return { sessionId: session!.id, strategy: planResult.subtitle.strategy };
  }

  it("direct-play session with hls-vtt subtitle strategy: extracts sub0.vtt + writes a valid subs/media.m3u8, and records staging_dir", async () => {
    const { sessionId, strategy } = await createSessionForDevice(compatibleDeviceProfile());
    expect(strategy).toBe("hls-vtt");

    // Confirm this really is a direct-play session (deliverable-6 BIND: the
    // transcode worker runtime NEVER runs for this session — subtitle
    // extraction must still work).
    const sessionBefore = await raw.query<{ status: string; staging_dir: string | null }>(
      `SELECT status, staging_dir FROM playback_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sessionBefore.rows[0]!.status).toBe("active");
    expect(sessionBefore.rows[0]!.staging_dir).toBeNull();

    await runSubtitleExtraction({ db, stagingRoot }, sessionId);

    const vttPath = join(stagingRoot, sessionId, "subs", "sub0.vtt");
    const playlistPath = join(stagingRoot, sessionId, "subs", "media.m3u8");
    expect(existsSync(vttPath)).toBe(true);
    expect(existsSync(playlistPath)).toBe(true);

    const vttText = readFileSync(vttPath, "utf8");
    expect(vttText.startsWith("WEBVTT")).toBe(true);

    const playlistText = readFileSync(playlistPath, "utf8");
    expect(playlistText).toContain("#EXTM3U");
    expect(playlistText).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(playlistText).toContain("sub0.vtt");
    expect(playlistText).toContain("#EXT-X-ENDLIST");

    const sessionAfter = await raw.query<{ staging_dir: string | null }>(
      `SELECT staging_dir FROM playback_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sessionAfter.rows[0]!.staging_dir).toBe(join(stagingRoot, sessionId));
  }, 30_000);

  it("a session whose plan is NOT hls-vtt (embed strategy) is a no-op — no staging dir, no files", async () => {
    const { sessionId, strategy } = await createSessionForDevice(embedOnlyDeviceProfile());
    expect(strategy).toBe("embed");

    await runSubtitleExtraction({ db, stagingRoot }, sessionId);

    expect(existsSync(join(stagingRoot, sessionId))).toBe(false);
    const row = await raw.query<{ staging_dir: string | null }>(`SELECT staging_dir FROM playback_sessions WHERE id = $1`, [sessionId]);
    expect(row.rows[0]!.staging_dir).toBeNull();
  }, 30_000);
});
