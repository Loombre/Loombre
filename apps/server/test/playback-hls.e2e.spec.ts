// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/playback-hls.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for the HLS + segmented-VTT subtitle file-serving surfaces
// (Phase 3 §11 step 6b, docs/PLAYBACK.md §9, STATE.md P3.9(e)):
//   GET /playback/sessions/{id}/hls/media.m3u8
//   GET /playback/sessions/{id}/hls/{file}
//   GET /playback/sessions/{id}/subtitles/media.m3u8
//   GET /playback/sessions/{id}/subtitles/{file}
//
// SEAM-LEVEL MOCK (reported honestly, per this step's own instructions:
// "integration with REAL worker runtime if feasible ... else document the
// seam-level mock honestly"): this file does NOT run a real ffmpeg/worker
// process. apps/worker's transcode runtime is exercised end-to-end
// elsewhere (apps/worker/test/transcode/session.integration.spec.ts, a
// SEPARATE app/test-suite with real ffmpeg). Lane B's own scope — the HTTP
// layer's polling/guard/seek-request logic — depends only on the
// PLAYBACK_SESSIONS ROW COLUMNS the worker writes (status/staging_dir/
// produced_segment, docs/PLAYBACK.md §9 / migrations/0012's column-
// ownership contract) and FILES the worker writes under staging_dir. Both
// are simulated directly here: a real session row is created via the real
// HTTP API, then its worker-owned columns/files are set exactly as the
// worker would leave them, via raw SQL + real filesystem writes — proving
// every one of Lane B's own request-handling rules (blocking-poll timeout,
// filename-pattern guard, traversal guard, seek-ahead detection,
// Cache-Control headers, query-token auth) without needing a real ffmpeg
// binary in this test run. This is the "seam-level mock", named and
// justified as instructed rather than silently substituted.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function forcedTranscodeDeviceProfile() {
  return {
    profileId: "hls-e2e-h264-only",
    directPlayContainers: ["mp4", "webm"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      { codec: "h264", maxProfile: null, maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: 20_000_000 },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

function loginDeviceProfile(profileId: string) {
  return {
    profileId,
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let adminToken: string;
let casualToken: string;
let harborLightsItemId: string;
let stagingRoot: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "playback-hls-e2e-test-secret-not-for-production";
  // Generous admission cap for this whole suite (security review F9 gave
  // transcode.maxSimultaneousTranscodes a schema ceiling of 64 — was
  // previously pinned to 1000, an arbitrary "large enough" value that now
  // exceeds that ceiling and would fall back to the tier-0 default of 1).
  process.env["LOOMBRE_MAX_TRANSCODES"] = "64";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "playback_hls_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "playback-hls-e2e-admin",
    deviceProfile: loginDeviceProfile("playback-hls-e2e-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "playback-hls-e2e-casual",
    deviceProfile: loginDeviceProfile("playback-hls-e2e-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;

  const db = createDb(databaseUrl);
  try {
    const item = await db.selectFrom("catalog_items").select("id").where("title", "=", "Harbor Lights").executeTakeFirstOrThrow();
    harborLightsItemId = item.id;
  } finally {
    await db.destroy();
  }

  stagingRoot = mkdtempSync(path.join(tmpdir(), "loombre-hls-e2e-"));
}, 30_000);

afterAll(async () => {
  await app.close();
});

function admin() {
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${adminToken}`),
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`),
  };
}
function casual() {
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${casualToken}`),
  };
}

/** Creates a real (forced-transcode) session via the HTTP API, then
 *  simulates the worker's OWN column/file writes for it — see this file's
 *  header for why. Returns the session id + its (test-owned) staging dir. */
async function createSimulatedTranscodeSession(): Promise<{ sessionId: string; sessionDir: string }> {
  const created = await admin()
    .post("/playback/sessions")
    .send({
      itemId: harborLightsItemId,
      device: forcedTranscodeDeviceProfile(),
      network: { maxBitrateBps: 50_000_000, isLocal: true },
      mode: "stream",
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const sessionId = created.body.id as string;
  const sessionDir = path.join(stagingRoot, sessionId);
  return { sessionId, sessionDir };
}

async function markSessionActiveWithProducedSegment(sessionId: string, sessionDir: string, producedSegment: number): Promise<void> {
  const db = createDb(process.env["DATABASE_URL"]!);
  try {
    await db
      .updateTable("playback_sessions")
      .set({ status: "active", staging_dir: sessionDir, produced_segment: producedSegment, updated_at_ms: Date.now() })
      .where("id", "=", sessionId)
      .execute();
  } finally {
    await db.destroy();
  }
}

/** Exactly what the worker's segment-ahead throttle writes when it
 *  SIGSTOPs a too-far-ahead encode (apps/worker/src/transcode/throttle.ts
 *  'suspend-for-throttle'). */
async function markSessionSuspendedByThrottle(sessionId: string): Promise<void> {
  const db = createDb(process.env["DATABASE_URL"]!);
  try {
    await db
      .updateTable("playback_sessions")
      .set({ status: "suspended", suspended_by_throttle: true, updated_at_ms: Date.now() })
      .where("id", "=", sessionId)
      .execute();
  } finally {
    await db.destroy();
  }
}

/** The OTHER cause of `status = 'suspended'` (migrations/0012's
 *  `suspended_by_throttle` column comment / opus review finding 9):
 *  server-authored heartbeat-staleness, disambiguated from the worker's
 *  own throttle-suspend by `suspended_by_throttle = false`. Exactly what a
 *  stale-heartbeat sweeper would leave behind — everything the throttle
 *  test above sets EXCEPT suspended_by_throttle. */
async function markSessionSuspendedByHeartbeatStale(sessionId: string): Promise<void> {
  const db = createDb(process.env["DATABASE_URL"]!);
  try {
    await db
      .updateTable("playback_sessions")
      .set({ status: "suspended", suspended_by_throttle: false, updated_at_ms: Date.now() })
      .where("id", "=", sessionId)
      .execute();
  } finally {
    await db.destroy();
  }
}

describe("GET /playback/sessions/{id}/hls/media.m3u8", () => {
  it("503 + Retry-After before the worker has produced anything (status still 'created')", async () => {
    const { sessionId } = await createSimulatedTranscodeSession();
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
  }, 15_000);

  it("200 with the real playlist content once status=active + produced_segment set + the worker's file exists", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    mkdirSync(sessionDir, { recursive: true });
    const playlistText = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrun0/s000000.m4s\n";
    writeFileSync(path.join(sessionDir, "media.m3u8"), playlistText, "utf8");
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 0);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/vnd\.apple\.mpegurl/);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.text).toBe(playlistText);
  }, 15_000);

  it("200 while throttle-SUSPENDED — a paused-ahead encode still serves everything already produced", async () => {
    // Field bug (2026-08-08 owner QA, live-DB verified): the segment-ahead
    // throttle SIGSTOPs ffmpeg at ahead > 10 and writes status='suspended'
    // — but this manifest route only served status='active', so every
    // hls.js event-playlist re-poll got 503 once the throttle kicked in.
    // The client then stalled on its FIRST playlist snapshot (~4 segments,
    // the "timeline always shows 20-24s then pauses" report), never
    // requested past segment 3, requested_segment never climbed, ahead
    // never dropped to the resume threshold — a deadlock the throttle
    // design cannot escape without this route serving suspended sessions.
    // Everything already produced sits on disk; suspended is exactly the
    // state in which serving it is the POINT.
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    mkdirSync(sessionDir, { recursive: true });
    const playlistText = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrun0/s000000.m4s\n";
    writeFileSync(path.join(sessionDir, "media.m3u8"), playlistText, "utf8");
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 14);
    await markSessionSuspendedByThrottle(sessionId);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(playlistText);
  }, 15_000);

  it("200 while heartbeat-stale SUSPENDED — the OTHER cause of status='suspended' (opus review finding 9) is served identically", async () => {
    // migrations/0012's suspended_by_throttle column disambiguates TWO
    // independent causes sharing one `status='suspended'` enum value: the
    // worker's own segment-ahead throttle (suspended_by_throttle=true,
    // covered above) and a server-side heartbeat-staleness sweep
    // (suspended_by_throttle=false). Both leave everything already
    // produced sitting on disk, and both are exactly the resume path an
    // authed owner's manifest re-fetch needs — this route intentionally
    // does not (and must not need to) distinguish the two to decide
    // servability, see hls-file.controller.ts's own comment.
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    mkdirSync(sessionDir, { recursive: true });
    const playlistText = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrun0/s000000.m4s\n";
    writeFileSync(path.join(sessionDir, "media.m3u8"), playlistText, "utf8");
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 14);
    await markSessionSuspendedByHeartbeatStale(sessionId);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(playlistText);
  }, 15_000);

  it("404 for a nonexistent session", async () => {
    const res = await admin().get("/playback/sessions/11111111-1111-4111-8111-111111111111/hls/media.m3u8");
    expect(res.status).toBe(404);
  });

  it("cross-user access is 404", async () => {
    const { sessionId } = await createSimulatedTranscodeSession();
    const res = await casual().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(res.status).toBe(404);
  });

  it("?token= works with no Authorization header (P2.18 pattern extended to this route)", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, "media.m3u8"), "#EXTM3U\n", "utf8");
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 0);

    const res = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/hls/media.m3u8?token=${adminToken}`);
    expect(res.status).toBe(200);
  }, 15_000);

  it("an invalid ?token= never gets echoed back in the 401/503 body", async () => {
    const { sessionId } = await createSimulatedTranscodeSession();
    const res = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/hls/media.m3u8?token=not-a-real-token`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("not-a-real-token");
  });
});

describe("GET /playback/sessions/{id}/hls/{file} — segment/init serving", () => {
  async function setupWithSegments(producedSegment: number): Promise<{ sessionId: string; sessionDir: string }> {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    mkdirSync(path.join(sessionDir, "run0"), { recursive: true });
    writeFileSync(path.join(sessionDir, "run0", "init.mp4"), Buffer.from("fake-init-mp4-bytes"));
    for (let i = 0; i <= producedSegment; i += 1) {
      writeFileSync(path.join(sessionDir, "run0", `s${String(i).padStart(6, "0")}.m4s`), Buffer.from(`fake-segment-${i}`));
    }
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, producedSegment);
    return { sessionId, sessionDir };
  }

  it("200 for a valid, produced segment — correct bytes, Cache-Control private/immutable, Content-Type", async () => {
    const { sessionId } = await setupWithSegments(2);
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000001.m4s`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, immutable");
    expect(res.headers["content-type"]).toBe("video/iso.segment");
    expect((res.body as Buffer).toString()).toBe("fake-segment-1");
  });

  it("200 for init.mp4", async () => {
    const { sessionId } = await setupWithSegments(0);
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/init.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect((res.body as Buffer).toString()).toBe("fake-init-mp4-bytes");
  });

  it("updates requested_segment on a segment GET (worker throttle input, docs/PLAYBACK.md §9)", async () => {
    const { sessionId } = await setupWithSegments(2);
    await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000002.m4s`);

    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const row = await db.selectFrom("playback_sessions").select(["requested_segment"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
      expect(row.requested_segment).toBe(2);
    } finally {
      await db.destroy();
    }
  });

  it("a segment far AHEAD of produced_segment (>3 lookahead) -> 503 + Retry-After, and writes seek_target_ms", async () => {
    const { sessionId } = await setupWithSegments(0);
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000010.m4s`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");

    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const row = await db.selectFrom("playback_sessions").select(["seek_target_ms"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
      expect(row.seek_target_ms).toBe(10 * 6 * 1000); // segmentIndex * segmentDurationSec(6) * 1000
    } finally {
      await db.destroy();
    }
  });

  it("a segment that passes the ahead-check but doesn't exist on disk (pruned/before run-start) -> 503 + seek requested", async () => {
    const { sessionId } = await setupWithSegments(2); // s000000..s000002 exist; s000001 within lookahead but let's request one that was never written
    // Overwrite produced_segment upward without writing the file, to land
    // "within lookahead" yet ENOENT (simulates a pruned/not-yet-flushed
    // segment — module header's BIND part (b)).
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      await db.updateTable("playback_sessions").set({ produced_segment: 4 }).where("id", "=", sessionId).execute();
    } finally {
      await db.destroy();
    }

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000003.m4s`);
    expect(res.status).toBe(503);

    const checkDb = createDb(process.env["DATABASE_URL"]!);
    try {
      const row = await checkDb.selectFrom("playback_sessions").select(["seek_target_ms"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
      expect(row.seek_target_ms).toBe(3 * 6 * 1000);
    } finally {
      await checkDb.destroy();
    }
  });

  // ── C3: seek-target derivation from REAL produced durations + clamp ──
  //
  // The two tests above pin the LAST-RESORT arithmetic (no served playlist
  // on disk => nominal `index * 6s`). The two below are the real thing: a
  // session that HAS a served `media.m3u8` (which every live session does
  // — apps/worker/src/transcode/runner.ts rewrites it on every poll) whose
  // `#EXTINF` durations are what ffmpeg ACTUALLY produced. Nominal 6.000s
  // arithmetic is wrong there by construction: `-hls_time 6` +
  // `-force_key_frames expr:gte(t,n_forced*6)` cuts at the first keyframe
  // AT OR AFTER each 6s mark, so real segments run 6.006s..9.176s and the
  // error COMPOUNDS with the index. Both tests seek TWICE (the confirmed
  // defect window: today's coverage stops at a first seek), across a
  // retention-pruned window in both directions.

  interface ServedRun {
    runDirName: string;
    segments: { index: number; durationMs: number }[];
  }

  /** Writes the session-root served playlist byte-identically to
   *  apps/worker/src/transcode/playlist.ts's `renderServedPlaylist()`
   *  (fmp4 shape: per-run `#EXT-X-MAP`, `#EXT-X-DISCONTINUITY` before
   *  every run after the first, run-relative URIs). */
  function writeServedPlaylist(sessionDir: string, runs: ServedRun[]): void {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:10", "#EXT-X-PLAYLIST-TYPE:EVENT"];
    runs.forEach((run, i) => {
      if (i > 0) lines.push("#EXT-X-DISCONTINUITY");
      lines.push(`#EXT-X-MAP:URI="${run.runDirName}/init.mp4"`);
      for (const seg of run.segments) {
        lines.push(`#EXTINF:${(seg.durationMs / 1000).toFixed(3)},`);
        lines.push(`${run.runDirName}/s${String(seg.index).padStart(6, "0")}.m4s`);
      }
    });
    writeFileSync(path.join(sessionDir, "media.m3u8"), lines.join("\n") + "\n", "utf8");
  }

  function writeRunSegmentFiles(sessionDir: string, run: ServedRun): void {
    mkdirSync(path.join(sessionDir, run.runDirName), { recursive: true });
    writeFileSync(path.join(sessionDir, run.runDirName, "init.mp4"), Buffer.from("fake-init-mp4-bytes"));
    for (const seg of run.segments) {
      writeFileSync(path.join(sessionDir, run.runDirName, `s${String(seg.index).padStart(6, "0")}.m4s`), Buffer.from(`fake-segment-${seg.index}`));
    }
  }

  /** Exactly what apps/worker/src/transcode/runner.ts does when it picks a
   *  seek up: `consumeSeekTarget` nulls the column inside its own restart
   *  transaction, then the new run advances `produced_segment`. Without
   *  this the second seek of a double-seek test would be reading the FIRST
   *  seek's leftover value. */
  async function simulateWorkerConsumedSeekAndProduced(sessionId: string, producedSegment: number): Promise<void> {
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      await db
        .updateTable("playback_sessions")
        .set({ seek_target_ms: null, produced_segment: producedSegment, status: "active", updated_at_ms: Date.now() })
        .where("id", "=", sessionId)
        .execute();
    } finally {
      await db.destroy();
    }
  }

  async function readSeekTargetMs(sessionId: string): Promise<number | null> {
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const row = await db.selectFrom("playback_sessions").select(["seek_target_ms"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
      return row.seek_target_ms === null ? null : Number(row.seek_target_ms);
    } finally {
      await db.destroy();
    }
  }

  /** The session's own source duration — the clamp ceiling. Read from the
   *  DB rather than hardcoded so the seed can change without silently
   *  turning the clamp assertion into a tautology. */
  async function readSessionDurationMs(sessionId: string): Promise<number> {
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const row = await db
        .selectFrom("playback_sessions")
        .innerJoin("media_files", "media_files.id", "playback_sessions.file_id")
        .select(["media_files.duration_ms as duration_ms"])
        .where("playback_sessions.id", "=", sessionId)
        .executeTakeFirstOrThrow();
      return Number(row.duration_ms);
    } finally {
      await db.destroy();
    }
  }

  it("DOUBLE SEEK forward-then-back across a pruned window: both targets are derived from the REAL served durations, not index x 6000ms", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();

    // run0 as ffmpeg really produced it: ten segments, NONE of them 6.000s.
    // sum = 67_066 ms, mean = 6_706.6 ms.
    const run0All = [6006, 6006, 8341, 6006, 6006, 7507, 6006, 6006, 6006, 9176].map((durationMs, index) => ({ index, durationMs }));
    const run0: ServedRun = { runDirName: "run0", segments: run0All };
    writeRunSegmentFiles(sessionDir, run0);
    writeServedPlaylist(sessionDir, [run0]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 9);

    // ── SEEK 1 (forward, past the produced window) ──────────────────────
    const forward = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000020.m4s`);
    expect(forward.status).toBe(503);
    expect(forward.headers["retry-after"]).toBe("1");

    // The whole listed window is exact (67_066 ms of real content for
    // indices 0..9); indices past its end extrapolate at the MEASURED mean
    // (6_706.6 ms), never the nominal 6_000: 67_066 + (20 - 9 - 1) *
    // 6_706.6 = 134_132 ms. The nominal answer, 120_000 ms, is 14 seconds
    // of content early — and that error only grows with the index.
    expect(await readSeekTargetMs(sessionId)).toBe(134_132);

    // ── the worker restarts, produces run1, retention prunes run0's head ─
    const run1: ServedRun = {
      runDirName: "run1",
      segments: Array.from({ length: 20 }, (_, i) => ({ index: 10 + i, durationMs: 9009 })),
    };
    writeRunSegmentFiles(sessionDir, run1);
    for (let i = 0; i <= 4; i += 1) {
      rmSync(path.join(sessionDir, "run0", `s${String(i).padStart(6, "0")}.m4s`));
    }
    const run0Survivors: ServedRun = { runDirName: "run0", segments: run0All.slice(5) };
    writeServedPlaylist(sessionDir, [run0Survivors, run1]);
    await simulateWorkerConsumedSeekAndProduced(sessionId, 29);
    expect(await readSeekTargetMs(sessionId)).toBeNull();

    // ── SEEK 2 (backward, into the pruned window) ──────────────────────
    // s000002 is BEHIND produced_segment, so the >3-lookahead check does
    // not fire — this is the ENOENT/pruned path, the exact window the
    // field defect lives in.
    const backward = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000002.m4s`);
    expect(backward.status).toBe(503);

    // Nothing before index 5 survives in the playlist, so index 2 is
    // extrapolated backwards at the measured mean of everything that IS
    // listed: (34_701 ms of run0 survivors + 180_180 ms of run1) / 25
    // segments = 8_595.24 ms; 2 * 8_595.24 = 17_190 ms (rounded). Nominal
    // arithmetic says 12_000 ms.
    expect(await readSeekTargetMs(sessionId)).toBe(17_190);
  }, 20_000);

  it("DOUBLE SEEK back-then-forward: the derived target is clamped to [0, durationMs]", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    const durationMs = await readSessionDurationMs(sessionId);
    expect(durationMs).toBeGreaterThan(0);

    // A session whose run0 head has ALREADY been retention-pruned: the
    // playlist starts at index 5, and every surviving segment is 9.009s.
    const run0: ServedRun = { runDirName: "run0", segments: Array.from({ length: 5 }, (_, i) => ({ index: 5 + i, durationMs: 9009 })) };
    writeRunSegmentFiles(sessionDir, run0);
    writeServedPlaylist(sessionDir, [run0]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 9);

    // ── SEEK 1 (backward, into the pruned window) ──────────────────────
    const backward = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000001.m4s`);
    expect(backward.status).toBe(503);
    // mean = 9_009 ms, so index 1 is 9_009 ms in — not 6_000.
    const firstTarget = await readSeekTargetMs(sessionId);
    expect(firstTarget).toBe(9_009);
    expect(firstTarget).toBeGreaterThanOrEqual(0);

    // ── the worker restarts and produces run1 ──────────────────────────
    const run1: ServedRun = { runDirName: "run1", segments: Array.from({ length: 6 }, (_, i) => ({ index: 10 + i, durationMs: 6006 })) };
    writeRunSegmentFiles(sessionDir, run1);
    writeServedPlaylist(sessionDir, [run0, run1]);
    await simulateWorkerConsumedSeekAndProduced(sessionId, 15);

    // ── SEEK 2 (forward, absurdly far — a stale/corrupt client request) ─
    // 999_999 is the largest index the `sNNNNNN` filename pattern can even
    // express. Un-clamped, ANY derivation puts it hours past the end of a
    // 108-minute file, and the worker would hand ffmpeg an `-ss` beyond
    // EOF: the restart produces nothing, forever. The clamp is what makes
    // that impossible.
    const forward = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s999999.m4s`);
    expect(forward.status).toBe(503);
    expect(await readSeekTargetMs(sessionId)).toBe(durationMs);
  }, 20_000);

  it("filename pattern guard: rejects anything not matching runN/sNNNNNN.{m4s,ts}|init.mp4 -> 404", async () => {
    const { sessionId } = await setupWithSegments(0);
    for (const badFile of ["run0/segment.txt", "runX/s000000.m4s", "s000000.m4s", "run0/s1.m4s", "run0/../init.mp4"]) {
      const res = await admin().get(`/playback/sessions/${sessionId}/hls/${badFile}`);
      expect(res.status, `${badFile} -> expected 404`).toBe(404);
    }
  });

  it("traversal attempt -> 404 (pattern rejects it before any filesystem access)", async () => {
    const { sessionId } = await setupWithSegments(0);
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/..%2F..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(404);
  });

  it("cross-user access is 404", async () => {
    const { sessionId } = await setupWithSegments(0);
    const res = await casual().get(`/playback/sessions/${sessionId}/hls/run0/init.mp4`);
    expect(res.status).toBe(404);
  });

  it("?token= works on the segment route too", async () => {
    const { sessionId } = await setupWithSegments(0);
    const res = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/hls/run0/init.mp4?token=${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /playback/sessions/{id}/subtitles/media.m3u8 + {file} (STATE.md P3.9(e))", () => {
  async function createAnySessionWithSubsDir(): Promise<{ sessionId: string; subsDir: string }> {
    // Deliberately a DIRECT-PLAY-eligible device this time — proves the
    // subtitle side-track surface is independent of the session's own
    // video/audio decision (deliverable 6's BIND: "works for direct-play
    // sessions too").
    const created = await admin()
      .post("/playback/sessions")
      .send({
        itemId: harborLightsItemId,
        device: {
          profileId: "hls-subs-e2e-device",
          directPlayContainers: ["mkv"],
          hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
          video: [{ codec: "hevc", maxProfile: null, maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null }],
          hdr: { hdr10: true, hlg: true, dolbyVision: false },
          audio: [{ codec: "eac3", maxChannels: 6, passthrough: true }],
          subtitles: { renderText: [], hlsVtt: true, renderImage: false },
          maxStreamBitrateBps: null,
        },
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.plan.decision).toBe("direct-play");
    const sessionId = created.body.id as string;
    const sessionDir = path.join(stagingRoot, `${sessionId}-subs-only`);
    const subsDir = path.join(sessionDir, "subs");

    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      await db.updateTable("playback_sessions").set({ staging_dir: sessionDir, updated_at_ms: Date.now() }).where("id", "=", sessionId).execute();
    } finally {
      await db.destroy();
    }

    return { sessionId, subsDir };
  }

  it("503 before the 'subtitle-extract' job has written anything", async () => {
    const { sessionId } = await createAnySessionWithSubsDir();
    const res = await admin().get(`/playback/sessions/${sessionId}/subtitles/media.m3u8`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
  });

  it("200 with the real playlist + vtt content once written, on a DIRECT-PLAY session", async () => {
    const { sessionId, subsDir } = await createAnySessionWithSubsDir();
    mkdirSync(subsDir, { recursive: true });
    const playlistText = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6480\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6480.000,\nsub0.vtt\n#EXT-X-ENDLIST\n";
    writeFileSync(path.join(subsDir, "media.m3u8"), playlistText, "utf8");
    const vttText = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nLoombre fixture\n";
    writeFileSync(path.join(subsDir, "sub0.vtt"), vttText, "utf8");

    const manifestRes = await admin().get(`/playback/sessions/${sessionId}/subtitles/media.m3u8`);
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers["content-type"]).toMatch(/application\/vnd\.apple\.mpegurl/);
    expect(manifestRes.headers["cache-control"]).toBe("private, no-store");
    expect(manifestRes.text).toBe(playlistText);

    const fileRes = await admin().get(`/playback/sessions/${sessionId}/subtitles/sub0.vtt`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers["content-type"]).toBe("text/vtt");
    expect(fileRes.headers["cache-control"]).toBe("private, immutable");
    // supertest/superagent has no registered body-parser for text/vtt, so
    // `res.body` stays `{}` — the raw text lands on `.text` instead
    // (unlike the binary .m4s/.mp4 assertions above, which DO parse to a
    // Buffer since their content types fall through to the binary default).
    expect(fileRes.text).toBe(vttText);
  });

  it("wrong filename (anything but sub0.vtt) -> 404", async () => {
    const { sessionId, subsDir } = await createAnySessionWithSubsDir();
    mkdirSync(subsDir, { recursive: true });
    writeFileSync(path.join(subsDir, "sub0.vtt"), "WEBVTT\n", "utf8");
    const res = await admin().get(`/playback/sessions/${sessionId}/subtitles/sub1.vtt`);
    expect(res.status).toBe(404);
  });

  it("cross-user access is 404", async () => {
    const { sessionId, subsDir } = await createAnySessionWithSubsDir();
    mkdirSync(subsDir, { recursive: true });
    writeFileSync(path.join(subsDir, "sub0.vtt"), "WEBVTT\n", "utf8");
    const res = await casual().get(`/playback/sessions/${sessionId}/subtitles/sub0.vtt`);
    expect(res.status).toBe(404);
  });

  it("?token= works on both subtitle routes with no Authorization header", async () => {
    const { sessionId, subsDir } = await createAnySessionWithSubsDir();
    mkdirSync(subsDir, { recursive: true });
    writeFileSync(path.join(subsDir, "media.m3u8"), "#EXTM3U\n", "utf8");
    writeFileSync(path.join(subsDir, "sub0.vtt"), "WEBVTT\n", "utf8");

    const manifestRes = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/subtitles/media.m3u8?token=${adminToken}`);
    expect(manifestRes.status).toBe(200);
    const fileRes = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/subtitles/sub0.vtt?token=${adminToken}`);
    expect(fileRes.status).toBe(200);
  });

  it("an invalid ?token= is never echoed back", async () => {
    const { sessionId } = await createAnySessionWithSubsDir();
    const res = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/subtitles/sub0.vtt?token=not-a-real-token`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("not-a-real-token");
  });
});
