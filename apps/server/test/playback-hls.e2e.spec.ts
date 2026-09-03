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
  // exceeds that ceiling and would fall back to the tier-0 default of 2).
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

  // ── EXT-X-MEDIA-SEQUENCE after a retention prune ───────────────────────
  //
  // apps/worker/src/transcode/playlist.ts's `pruneRetention` DELETES
  // segments from the FRONT of the served playlist (120s behind the live
  // edge) but `renderServedPlaylist` emits no `#EXT-X-MEDIA-SEQUENCE`. Per
  // RFC 8216 §4.3.3.2 an absent tag means 0 — i.e. "the first segment
  // listed is segment number 0" — so every prune silently RENUMBERS the
  // whole playlist from the client's point of view: hls.js derives each
  // fragment's `sn` (and the media-time offset it maps a seek to) from
  // that base, so after a prune its already-buffered fragments no longer
  // line up with the ones the server is naming. This is the same class of
  // defect as C3's seek-target drift and composes directly with it — the
  // server's absolute, globally-continuous segment numbering has to be
  // stated in the playlist, not assumed.
  it("a retention-pruned playlist carries #EXT-X-MEDIA-SEQUENCE equal to the first surviving absolute index", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    mkdirSync(sessionDir, { recursive: true });
    // Indices 0..4 pruned; the playlist now starts at the 6th segment ever
    // produced, exactly as the worker leaves it after a prune.
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:7", "#EXT-X-PLAYLIST-TYPE:EVENT", '#EXT-X-MAP:URI="run0/init.mp4"'];
    for (let i = 5; i <= 9; i += 1) {
      lines.push("#EXTINF:6.006,");
      lines.push(`run0/s${String(i).padStart(6, "0")}.m4s`);
    }
    writeFileSync(path.join(sessionDir, "media.m3u8"), lines.join("\n") + "\n", "utf8");
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 9);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("#EXT-X-MEDIA-SEQUENCE:5");
    // The tag must precede the first segment (RFC 8216 §4.3.3: Media
    // Playlist tags apply to the whole playlist and appear before any
    // Media Segment).
    expect(res.text.indexOf("#EXT-X-MEDIA-SEQUENCE:5")).toBeLessThan(res.text.indexOf("#EXTINF"));
    // Every segment line survives untouched — this adds a tag, it never
    // rewrites the worker's own segment bookkeeping.
    expect(res.text).toContain("run0/s000005.m4s");
    expect(res.text).toContain("run0/s000009.m4s");
  }, 15_000);

  it("an unpruned playlist is served BYTE-IDENTICAL — absent EXT-X-MEDIA-SEQUENCE already means 0", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    mkdirSync(sessionDir, { recursive: true });
    const playlistText = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:7\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="run0/init.mp4"\n#EXTINF:6.006,\nrun0/s000000.m4s\n';
    writeFileSync(path.join(sessionDir, "media.m3u8"), playlistText, "utf8");
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 0);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(playlistText);
    expect(res.text).not.toContain("#EXT-X-MEDIA-SEQUENCE");
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

  it("a segment BEYOND the live window (> 20 segments ahead of produced_segment) -> 503 + Retry-After, and writes seek_target_ms", async () => {
    const { sessionId } = await setupWithSegments(0);
    // gap-F6 widened the implicit-seek threshold from 3 segments to one
    // full 120s live window (20 segments) — index 30 is genuinely out of
    // window and still restarts.
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000030.m4s`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");

    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const row = await db.selectFrom("playback_sessions").select(["seek_target_ms"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
      expect(row.seek_target_ms).toBe(30 * 6 * 1000); // segmentIndex * segmentDurationSec(6) * 1000
    } finally {
      await db.destroy();
    }
  });

  // ── gap-F6: the implicit-seek trigger must not churn runs ─────────────
  // QA 2026-08-20/21 (P1): hls.js's ordinary forward-buffering (no caps
  // were set client-side) probed segments a handful ahead of
  // produced_segment on a fresh, untouched session; the old >3-lookahead
  // trigger read EVERY such probe as a seek and restarted the run — and
  // because forward-only numbering means a restarted run can never serve
  // the retried URI, each hls.js retry of the SAME dead URI restarted the
  // run AGAIN (run0→run7, compounding relocation, phantom progress).
  // "Outside the produced window" now means outside the 120s LIVE WINDOW
  // (SEGMENT_RETENTION_SEC / 6s = 20 segments), and a URI naming a
  // SUPERSEDED run is a stale retry by construction — never a new seek.

  it("gap-F6: a not-yet-produced segment WITHIN the live window -> 503 + Retry-After, and does NOT write seek_target_ms", async () => {
    const { sessionId } = await setupWithSegments(0);
    // ahead = 10 — exactly the kind of probe hls.js's forward buffer
    // legitimately issues; the worker is already producing toward it
    // (requested_segment above unthrottles it), so a restart is churn.
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000010.m4s`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(await readSeekTargetMs(sessionId)).toBeNull();
  }, 15_000);

  it("gap-F6: a retry of a DEAD pre-restart URI (stale run prefix, ENOENT path) never writes another seek", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    // The live-repro shape: an implicit seek already restarted the session
    // once (run1 at start_segment 16), and production has moved past the
    // originally-probed index. run0/s000020 never existed and never will.
    await recordRuns(sessionId, [
      { runIndex: 0, startSegment: 0, sourceOriginMs: 0 },
      { runIndex: 1, startSegment: 16, sourceOriginMs: 121_215 },
    ]);
    const run0: ServedRun = { runDirName: "run0", segments: Array.from({ length: 16 }, (_, i) => ({ index: i, durationMs: 6006 })) };
    const run1: ServedRun = { runDirName: "run1", segments: Array.from({ length: 16 }, (_, i) => ({ index: 16 + i, durationMs: 6006 })) };
    writeRunSegmentFiles(sessionDir, run0);
    writeRunSegmentFiles(sessionDir, run1);
    writeServedPlaylist(sessionDir, [run0, run1]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 31);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000020.m4s`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(await readSeekTargetMs(sessionId), "a stale-run retry restarted the run AGAIN — the churn loop").toBeNull();
  }, 15_000);

  it("gap-F6: a retry of a PRUNED-history URI already ANSWERED by a restart at that target never writes another seek", async () => {
    // The second churn arm, observed live: a fast-completing file races to
    // ENDLIST in seconds and retention prunes the head; the client's first
    // GET of a pruned index legitimately relocates (run1 spawned AT the
    // derived target), but every hls.js RETRY of the same dead URI derives
    // the SAME target again — the old code restarted the run once per
    // retry (runs 2..7 all sharing one source_origin_ms, re-encoding the
    // same tail). A later run already sitting (within one nominal segment)
    // at the derived target IS the answer to this request — 503, no write.
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    await recordRuns(sessionId, [
      { runIndex: 0, startSegment: 0, sourceOriginMs: 0 },
      // Exactly what the FIRST (legitimate) pruned-history relocation
      // recorded: origin == the target derived for s000070 (70 x 6_006).
      { runIndex: 1, startSegment: 96, sourceOriginMs: 420_420 },
    ]);
    const run0Survivors: ServedRun = { runDirName: "run0", segments: Array.from({ length: 21 }, (_, i) => ({ index: 75 + i, durationMs: 6006 })) };
    const run1: ServedRun = { runDirName: "run1", segments: Array.from({ length: 15 }, (_, i) => ({ index: 96 + i, durationMs: 6006 })) };
    writeRunSegmentFiles(sessionDir, run0Survivors);
    writeRunSegmentFiles(sessionDir, run1);
    writeServedPlaylist(sessionDir, [run0Survivors, run1]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 110);

    // run0/s000070 is pruned (never on disk here) and OWNED by run0, so
    // the stale-run guard alone cannot catch it — only the already-
    // answered-by-restart guard can.
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000070.m4s`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(await readSeekTargetMs(sessionId), "a pruned-history retry restarted the run AGAIN — the second churn loop").toBeNull();
  }, 15_000);

  it("gap-F6: a beyond-window request naming a SUPERSEDED run (ahead path) is a stale retry — 503, no seek", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    await recordRuns(sessionId, [
      { runIndex: 0, startSegment: 0, sourceOriginMs: 0 },
      { runIndex: 1, startSegment: 16, sourceOriginMs: 121_215 },
    ]);
    const run0: ServedRun = { runDirName: "run0", segments: Array.from({ length: 16 }, (_, i) => ({ index: i, durationMs: 6006 })) };
    const run1: ServedRun = { runDirName: "run1", segments: Array.from({ length: 5 }, (_, i) => ({ index: 16 + i, durationMs: 6006 })) };
    writeRunSegmentFiles(sessionDir, run0);
    writeRunSegmentFiles(sessionDir, run1);
    writeServedPlaylist(sessionDir, [run0, run1]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 20);

    // s000060 is 40 ahead (beyond the 20-segment window) but names run0,
    // which no longer owns segment 60 — run1 does. A CURRENT playlist
    // could never have produced this URI: it is a pre-restart retry.
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000060.m4s`);
    expect(res.status).toBe(503);
    expect(await readSeekTargetMs(sessionId)).toBeNull();
  }, 15_000);

  // ── gap-F6 ROUND 3 (verify refuted abe0daf, live re-repro 2026-08-24) ──
  // A fast-completing copy-shape file races retention past the client: the
  // whole encode lands in <1s, the head is pruned while the client is
  // still fetching its FIRST segments, and every pruned-index GET the
  // client was heading toward anyway spawned a fresh restart with a fresh
  // derived target (live: run1 origin 430_084 for s74, then run2 origin
  // 522_896 for s90 — 92.8s apart, unreachable by any ms tolerance). The
  // race is the WORKER's prune bug (F/prune-race); this route's job is to
  // never mistake it for a seek: an implicit ENOENT restart now requires
  // BACKWARD-JUMP EVIDENCE (an index at least BACKWARD_JUMP_HYSTERESIS
  // segments below the session's own requested_segment progression) — a
  // client playing forward is never seeking backward.

  it("gap-F6 round 3: a pruned index reached by the session's own FORWARD progression never restarts (the prune race is not a seek)", async () => {
    const { sessionId, sessionDir } = await setupWithSegments(24);
    // The client's own progression: s000008 served normally writes
    // requested_segment = 8.
    const served = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000008.m4s`);
    expect(served.status).toBe(200);
    // Retention prunes s000010 while the client is still heading toward
    // it (the live 1/1 repro shape: first indexed GET s74 of a window the
    // playlist listed moments earlier).
    rmSync(path.join(sessionDir, "run0", "s000010.m4s"));

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000010.m4s`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(
      await readSeekTargetMs(sessionId),
      "a forward-progression pruned GET restarted the run — the untouched-mount churn trigger",
    ).toBeNull();
  }, 15_000);

  it("gap-F6 round 3: the very FIRST indexed GET of a session racing the prune AT the live edge never restarts", async () => {
    // Live 1/1: hls.js's first indexed request (live-sync start,
    // requested_segment still NULL) hit a pruned file and spawned run1 —
    // on a completely untouched mount. An index the session's own
    // production is still standing on is the prune RACING the client, not
    // a backward seek.
    //
    // d3-f2 narrowed round 3's rule: "no progression recorded" is no
    // longer read as "no backward intent" for ANY index, only for one
    // within the hysteresis of the session's own production edge (this
    // test). The blanket form wedged a first-touch backward seek on 503
    // forever — see the d3-f2 test below.
    const { sessionId, sessionDir } = await setupWithSegments(24);
    rmSync(path.join(sessionDir, "run0", "s000023.m4s"));

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000023.m4s`);
    expect(res.status).toBe(503);
    expect(
      await readSeekTargetMs(sessionId),
      "a first-touch pruned GET at the live edge restarted the run with zero seek evidence",
    ).toBeNull();
  }, 15_000);

  // ── d3-f2 (QA 2026-08-24, P2): FIRST-TOUCH BACKWARD SEEK WEDGES ───────
  // The demoted-ENOENT path treated `requested_segment IS NULL` as "no
  // backward intent" for every index, so a client whose FIRST indexed GET
  // is a backward jump into pruned history got PRUNED_UNDERFOOT 503 with
  // no restart — and `updateRequestedSegment` then PINNED requested_segment
  // to that very index, so every retry sat inside the backward-jump
  // hysteresis OF ITSELF and the implicit restart became unreachable
  // forever (live: 15x GET run0/s000010.m4s -> 15x 503, runs stayed at 1;
  // the same GET after one served high-index GET restarted correctly).
  // With no progression recorded, the session's own produced edge is the
  // only progression there is — and an index far below it cannot be
  // reached by playing forward.

  it("d3-f2: a FIRST-TOUCH backward jump into pruned history restarts exactly once", async () => {
    const { sessionId, sessionDir } = await setupWithSegments(24);
    // requested_segment IS NULL — this session has never served a segment.
    rmSync(path.join(sessionDir, "run0", "s000003.m4s"));

    const first = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000003.m4s`);
    expect(first.status).toBe(503);
    expect(first.headers["retry-after"]).toBe("1");
    expect(
      await readSeekTargetMs(sessionId),
      "a first-touch backward jump never restarted — the 503-forever wedge",
    ).toBe(3 * 6 * 1000);

    // The worker consumes the seek (nulls the column) and relocates. The
    // client, still on its old playlist, retries the same dead URI: the
    // progression it pinned a moment ago is its OWN, so this must not
    // restart again — one restart per intention, never one per retry.
    await simulateWorkerConsumedSeekAndProduced(sessionId, 24);
    const retry = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000003.m4s`);
    expect(retry.status).toBe(503);
    expect(
      await readSeekTargetMs(sessionId),
      "a retry of the same dead URI restarted the run AGAIN — the churn loop",
    ).toBeNull();
  }, 15_000);

  // ── d4-f2 (QA backlog #104, P4): THE PROGRESSION BASELINE IS A
  // "LAST INDEX ASKED FOR" COLUMN ────────────────────────────────────────
  // `requested_segment` is written verbatim on EVERY segment GET — 503'd,
  // far-ahead and speculative ones included — so it answers "what was the
  // last URI this client named", not "how far has this client actually
  // got". The backward-jump gate needs the second question. hls.js probes
  // ahead of the produced edge as a matter of course (it buffers up to 90s
  // and the live window admits 20 segments), and every one of those probes
  // used to raise the baseline: the client's OWN next fragment — pruned
  // out from under it, round 3's prune race — then sat far below the
  // inflated baseline and read as a backward seek, restarting the run for
  // a position the viewer was walking straight into.
  // `highest_served_segment` is written only on a 200, monotonically, so it
  // is progression by construction.

  it("d4-f2: a SPECULATIVE far-ahead fetch never makes the client's own forward position look like a backward jump", async () => {
    const { sessionId, sessionDir } = await setupWithSegments(24);
    // The client's REAL position: s000008, served 200. The only kind of
    // request that is evidence the viewer reached an index.
    const served = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000008.m4s`);
    expect(served.status).toBe(200);

    // hls.js buffers ahead: s000044 is exactly at the live-window ceiling
    // (produced 24 + 20), so it is NOT an implicit seek — a plain
    // not-yet-produced 503. It still writes requested_segment = 44.
    const probe = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000044.m4s`);
    expect(probe.status).toBe(503);
    expect(
      await readSeekTargetMs(sessionId),
      "a within-window forward probe restarted the run — gap-F6's own rule",
    ).toBeNull();

    // Retention prunes the client's very next fragment. Nothing about this
    // is a seek: s000010 is two segments ahead of what it was just served.
    rmSync(path.join(sessionDir, "run0", "s000010.m4s"));
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000010.m4s`);
    expect(res.status).toBe(503);
    expect(
      await readSeekTargetMs(sessionId),
      "a forward-probe-inflated baseline turned the client's own next fragment into a backward jump",
    ).toBeNull();
  }, 15_000);

  it("d4-f2: the served watermark advances only on a 200, and only upward", async () => {
    const { sessionId, sessionDir } = await setupWithSegments(24);
    const readWatermark = async (): Promise<number | null> => {
      const db = createDb(process.env["DATABASE_URL"]!);
      try {
        const row = await db
          .selectFrom("playback_sessions")
          .select(["highest_served_segment"])
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow();
        return row.highest_served_segment === null ? null : Number(row.highest_served_segment);
      } finally {
        await db.destroy();
      }
    };

    // Nothing served yet — NULL, never 0 (index 0 is a real segment).
    expect(await readWatermark()).toBeNull();

    expect((await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000008.m4s`)).status).toBe(200);
    expect(await readWatermark()).toBe(8);

    // A 503 never moves it: a probe inside the live window, and a pruned
    // index behind the produced edge.
    expect((await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000044.m4s`)).status).toBe(503);
    rmSync(path.join(sessionDir, "run0", "s000012.m4s"));
    expect((await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000012.m4s`)).status).toBe(503);
    expect(await readWatermark(), "a refused request moved the SERVED watermark").toBe(8);

    // init.mp4 carries no segment index at all.
    expect((await admin().get(`/playback/sessions/${sessionId}/hls/run0/init.mp4`)).status).toBe(200);
    expect(await readWatermark()).toBe(8);

    expect((await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000014.m4s`)).status).toBe(200);
    expect(await readWatermark()).toBe(14);

    // hls.js issues parallel/out-of-order fragment loads as a matter of
    // course; a served LOWER index must never walk the watermark back.
    expect((await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000009.m4s`)).status).toBe(200);
    expect(await readWatermark(), "an out-of-order fragment load walked the watermark backward").toBe(14);
  }, 15_000);

  it("gap-F6 round 3: a backward-jump retry whose derived target sits NEAR (but >1 segment from) a later run's origin never restarts again", async () => {
    // The 8.8s-spacing escape: the first pruned-history relocation
    // recorded run1 at the target derived for s74 (444_444 here, nominal
    // durations); a later out-of-order request for s72 derives 432_432 —
    // 12_012ms away, past the old one-nominal-segment (6_006ms) tolerance,
    // and the session restarted AGAIN (live: run2/run3 origins 8_810ms
    // apart, 0.8s after each other). Adjacency within a few segments of an
    // already-performed relocation is a stale/racing derivation, never a
    // fresh user intention.
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    await recordRuns(sessionId, [
      { runIndex: 0, startSegment: 0, sourceOriginMs: 0 },
      { runIndex: 1, startSegment: 96, sourceOriginMs: 444_444 },
    ]);
    const run0Survivors: ServedRun = { runDirName: "run0", segments: Array.from({ length: 20 }, (_, i) => ({ index: 76 + i, durationMs: 6006 })) };
    const run1: ServedRun = { runDirName: "run1", segments: Array.from({ length: 15 }, (_, i) => ({ index: 96 + i, durationMs: 6006 })) };
    writeRunSegmentFiles(sessionDir, run0Survivors);
    writeRunSegmentFiles(sessionDir, run1);
    writeServedPlaylist(sessionDir, [run0Survivors, run1]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 110);

    // Progression high (a served run1 segment), then the out-of-order
    // backward retry for pruned run0 history.
    const served = await admin().get(`/playback/sessions/${sessionId}/hls/run1/s000100.m4s`);
    expect(served.status).toBe(200);
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000072.m4s`);
    expect(res.status).toBe(503);
    expect(
      await readSeekTargetMs(sessionId),
      "a near-miss derived target (12_012ms from run1's origin) restarted the run AGAIN — the 8.8s-spacing churn",
    ).toBeNull();
  }, 15_000);

  it("gap-F6 round 3: a GENUINE backward jump far from every recorded origin still restarts (the recovery path survives the new guards)", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    await recordRuns(sessionId, [
      { runIndex: 0, startSegment: 0, sourceOriginMs: 0 },
      { runIndex: 1, startSegment: 96, sourceOriginMs: 444_444 },
    ]);
    const run0Survivors: ServedRun = { runDirName: "run0", segments: Array.from({ length: 20 }, (_, i) => ({ index: 76 + i, durationMs: 6006 })) };
    const run1: ServedRun = { runDirName: "run1", segments: Array.from({ length: 15 }, (_, i) => ({ index: 96 + i, durationMs: 6006 })) };
    writeRunSegmentFiles(sessionDir, run0Survivors);
    writeRunSegmentFiles(sessionDir, run1);
    writeServedPlaylist(sessionDir, [run0Survivors, run1]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 110);

    const served = await admin().get(`/playback/sessions/${sessionId}/hls/run1/s000100.m4s`);
    expect(served.status).toBe(200);
    // s000020: 80 segments below the progression, target ~120s — nowhere
    // near either origin. A native client's real backward seek.
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000020.m4s`);
    expect(res.status).toBe(503);
    const target = await readSeekTargetMs(sessionId);
    expect(target, "the genuine backward-seek recovery was suppressed by the round-3 guards").not.toBeNull();
    expect(target).toBeLessThan(200_000);
  }, 15_000);

  it("a BACKWARD jump to a pruned segment (BIND part (b), with round-3 backward-jump evidence) -> 503 + seek requested", async () => {
    // gap-F6 round 3: the ENOENT-behind restart now requires backward-jump
    // evidence — an index more than the hysteresis below the session's own
    // recorded progression. Establish the progression first (a served GET
    // high in the window), then jump back to a pruned index.
    const { sessionId, sessionDir } = await setupWithSegments(24);
    const served = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000024.m4s`);
    expect(served.status).toBe(200);
    rmSync(path.join(sessionDir, "run0", "s000003.m4s"));

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
    // (index 30: beyond the gap-F6 live-window threshold of produced+20,
    // so the implicit-seek trigger genuinely fires.)
    const forward = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000030.m4s`);
    expect(forward.status).toBe(503);
    expect(forward.headers["retry-after"]).toBe("1");

    // The whole listed window is exact (67_066 ms of real content for
    // indices 0..9); indices past its end extrapolate at the MEASURED mean
    // (6_706.6 ms), never the nominal 6_000: 67_066 + (30 - 9 - 1) *
    // 6_706.6 = 201_198 ms. The nominal answer, 180_000 ms, is 21 seconds
    // of content early — and that error only grows with the index.
    expect(await readSeekTargetMs(sessionId)).toBe(201_198);

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

  // ── Exact per-run source anchoring (migration 0043's transcode_runs) ──
  //
  // Until Lane A1 recorded a durable per-run source origin, this controller
  // could only ever produce a PRESENTATION-timeline answer for runs after
  // the first: every seek run is spawned with `-ss` and no `-copyts`, so
  // its own output timestamps restart at zero while the segment counter
  // keeps climbing. The mean-extrapolation above was the best a
  // playlist-only derivation could do. With `transcode_runs` it becomes
  // EXACT: the owning run supplies the SOURCE anchor, and the run's own
  // real #EXTINF durations supply the offset within it (inside one run,
  // playlist duration maps 1:1 to source time — neither a copy nor a
  // transcode changes the rate).

  interface RunRow {
    runIndex: number;
    startSegment: number;
    sourceOriginMs: number;
  }

  /** Exactly what apps/worker/src/transcode/runner.ts's `recordTranscodeRun`
   *  writes on every spawn, run 0 included. */
  async function recordRuns(sessionId: string, runs: RunRow[]): Promise<void> {
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      for (const run of runs) {
        await db
          .insertInto("transcode_runs")
          .values({
            session_id: sessionId,
            run_index: run.runIndex,
            start_segment: run.startSegment,
            source_origin_ms: run.sourceOriginMs,
            created_at_ms: Date.now(),
          })
          .execute();
      }
    } finally {
      await db.destroy();
    }
  }

  it("TRIPLE SEEK across three runs: every target is the OWNING RUN's source origin plus its own real durations", async () => {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();

    // Three runs. Run 2's source origin is EARLIER than run 1's — a
    // backward seek — which is the whole reason ownership must follow the
    // segment counter and never the clock. Anything that ordered runs by
    // source_origin_ms would hand segment 25 to run 1 (600_000) instead of
    // run 2 (120_000).
    const runs: RunRow[] = [
      { runIndex: 0, startSegment: 0, sourceOriginMs: 0 },
      { runIndex: 1, startSegment: 10, sourceOriginMs: 600_000 },
      { runIndex: 2, startSegment: 20, sourceOriginMs: 120_000 },
    ];
    await recordRuns(sessionId, runs);

    // Retention has pruned run 0's head (indices 0..4). Each run's segments
    // have their OWN characteristic real duration, so a cross-run mean can
    // never accidentally produce the right answer.
    const run0: ServedRun = { runDirName: "run0", segments: Array.from({ length: 5 }, (_, i) => ({ index: 5 + i, durationMs: 6006 })) };
    const run1: ServedRun = { runDirName: "run1", segments: Array.from({ length: 10 }, (_, i) => ({ index: 10 + i, durationMs: 9009 })) };
    const run2: ServedRun = { runDirName: "run2", segments: Array.from({ length: 10 }, (_, i) => ({ index: 20 + i, durationMs: 7007 })) };
    writeRunSegmentFiles(sessionDir, run0);
    writeRunSegmentFiles(sessionDir, run1);
    writeRunSegmentFiles(sessionDir, run2);
    writeServedPlaylist(sessionDir, [run0, run1, run2]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 29);

    // ── SEEK 1: forward, past the produced window, inside run 2 ─────────
    // (index 50: beyond the gap-F6 live-window threshold of produced+20 —
    // and named under run2, the OWNING run, so it is not a stale retry.)
    const forward = await admin().get(`/playback/sessions/${sessionId}/hls/run2/s000050.m4s`);
    expect(forward.status).toBe(503);
    // Owner is run 2 (startSegment 20 <= 50), anchor 120_000. Its listed
    // segments 20..29 contribute 10 x 7_007 = 70_070; the twenty not yet
    // produced (30..49) extrapolate at run 2's OWN measured mean, 7_007,
    // for 140_140 more. 120_000 + 210_210 = 330_210.
    expect(await readSeekTargetMs(sessionId)).toBe(330_210);

    // ── SEEK 2: backward across runs, into run 0's PRUNED head ──────────
    // ahead is negative, so this is the ENOENT path, and the owning run is
    // run 0 — reachable only by ordering on start_segment.
    const backward = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000002.m4s`);
    expect(backward.status).toBe(503);
    // Anchor 0; segments 0 and 1 were pruned out of the playlist, so they
    // extrapolate at run 0's own mean (6_006): 2 x 6_006 = 12_012.
    expect(await readSeekTargetMs(sessionId)).toBe(12_012);

    // ── SEEK 3: into run 2, the BACKWARD-seek run — the ordering pin ────
    // Segment 25 is listed but not on disk (the worker rewrote the playlist
    // before the segment was flushed): the ENOENT path again. Round 3:
    // re-establish forward progression above the target first (SEEK 2 left
    // requested_segment at 2), so this reads as a genuine backward jump.
    const progressed = await admin().get(`/playback/sessions/${sessionId}/hls/run2/s000029.m4s`);
    expect(progressed.status).toBe(200);
    rmSync(path.join(sessionDir, "run2", "s000025.m4s"));
    const midRun = await admin().get(`/playback/sessions/${sessionId}/hls/run2/s000025.m4s`);
    expect(midRun.status).toBe(503);
    // Owner is run 2: anchor 120_000 plus its OWN segments 20..24
    // (5 x 7_007 = 35_035) = 155_035 — EXACT, nothing extrapolated.
    // Ordering by source_origin_ms would pick run 1 and land at 600_000+.
    expect(await readSeekTargetMs(sessionId)).toBe(155_035);
  }, 25_000);

  it("no transcode_runs rows (a session predating migration 0043) still derives from the playlist alone", async () => {
    // The fallback chain must survive: a session mid-flight across the
    // migration has no run rows, and "no source anchor available" must
    // never be read as "origin 0" plus a run-relative offset.
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    const run0: ServedRun = { runDirName: "run0", segments: Array.from({ length: 10 }, (_, i) => ({ index: i, durationMs: 6006 })) };
    writeRunSegmentFiles(sessionDir, run0);
    writeServedPlaylist(sessionDir, [run0]);
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 9);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000030.m4s`);
    expect(res.status).toBe(503);
    // Playlist-only derivation, unchanged: 10 listed x 6_006 = 60_060, plus
    // twenty unproduced at the measured mean 6_006 = 180_180. (Index 30 —
    // beyond the gap-F6 live-window threshold, so the trigger fires; no
    // run rows exist, so nothing can be a stale-run retry.)
    expect(await readSeekTargetMs(sessionId)).toBe(180_180);
  }, 20_000);

  it("DOUBLE SEEK back-then-forward: the derived target is clamped to the playable ceiling (durationMs − one nominal segment)", async () => {
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
    // Round 3: establish the forward progression first so the pruned-head
    // GET carries backward-jump evidence.
    const progressed = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000009.m4s`);
    expect(progressed.status).toBe(200);
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
    // that impossible — and since browser-player-F4 the ceiling is one
    // nominal segment BEFORE durationMs (seek-target.ts): durationMs
    // itself is an `-ss` AT EOF, a run with nothing displayable that
    // wedged the client's landing.
    const forward = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s999999.m4s`);
    expect(forward.status).toBe(503);
    expect(await readSeekTargetMs(sessionId)).toBe(durationMs - 6_000);
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

// ═══════════════════════════════════════════════════════════════════════════
// Wave C2 — multi-variant delivery (docs/PLAYBACK.md §9.1, LD-6 under LD-16)
//
// One session = one admission slot = at most one live pipeline, ever. A
// client's ABR switch reaches the server as a `v{K}` path and hands the
// EXISTING slot to that rung; it never starts a second transcode. These
// tests pin the HTTP half of that: the master playlist, the variant path
// family, and the switch-signal recording.
// ═══════════════════════════════════════════════════════════════════════════

async function readRungColumns(sessionId: string): Promise<{ active: number | null; pending: number | null }> {
  const db = createDb(process.env["DATABASE_URL"]!);
  try {
    const row = await db
      .selectFrom("playback_sessions")
      .select(["active_rung_index", "pending_rung_index"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    return { active: row.active_rung_index, pending: row.pending_rung_index };
  } finally {
    await db.destroy();
  }
}

async function setActiveRung(sessionId: string, rungIndex: number): Promise<void> {
  const db = createDb(process.env["DATABASE_URL"]!);
  try {
    await db
      .updateTable("playback_sessions")
      .set({ active_rung_index: rungIndex, updated_at_ms: Date.now() })
      .where("id", "=", sessionId)
      .execute();
  } finally {
    await db.destroy();
  }
}

async function storedPlanOf(sessionId: string): Promise<Record<string, unknown>> {
  const db = createDb(process.env["DATABASE_URL"]!);
  try {
    const row = await db.selectFrom("playback_sessions").select("plan").where("id", "=", sessionId).executeTakeFirstOrThrow();
    return row.plan as Record<string, unknown>;
  } finally {
    await db.destroy();
  }
}

describe("GET /playback/sessions/{id}/hls/master.m3u8 (§9.1.1)", () => {
  it("200 IMMEDIATELY after session create — this route NEVER 503s (§9.1.2 item 1)", async () => {
    // The contrast that makes this a real property: the sibling
    // media.m3u8 route 503s for this exact session (nothing produced yet,
    // status still 'created'), because a media playlist cannot exist until
    // ffmpeg has written a segment. A master playlist is fully determined
    // by the stored plan, so there is nothing to wait for and no poll loop.
    const { sessionId } = await createSimulatedTranscodeSession();

    const master = await admin().get(`/playback/sessions/${sessionId}/hls/master.m3u8`);
    expect(master.status).toBe(200);
    expect(master.headers["content-type"]).toMatch(/application\/vnd\.apple\.mpegurl/);
    expect(master.headers["cache-control"]).toBe("private, no-store");
    expect(master.text.startsWith("#EXTM3U")).toBe(true);

    const media = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(media.status).toBe(503);
  }, 20_000);

  it("advertises EXACTLY the stored plan's ladder, in array order, as v{K}/media.m3u8", async () => {
    const { sessionId } = await createSimulatedTranscodeSession();
    const plan = await storedPlanOf(sessionId);
    const ladder = plan["ladder"] as { videoBitrateBps: number; audioBitrateBps: number }[];
    expect(ladder.length).toBeGreaterThan(0);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/master.m3u8`);
    const lines = res.text.split("\n");
    const variants = lines.filter((l) => /^v\d+\/media\.m3u8$/.test(l));
    // §7.5: "the master playlist advertises plan.ladder — nothing else,
    // and all of it". Which rungs a client may switch to is a PLAN
    // decision the matrix proves, never a session-layer filter.
    expect(variants).toEqual(ladder.map((_, i) => `v${i}/media.m3u8`));

    const streamInfs = lines.filter((l) => l.startsWith("#EXT-X-STREAM-INF"));
    expect(streamInfs).toHaveLength(ladder.length);
    ladder.forEach((rung, i) => {
      expect(streamInfs[i]).toContain(`AVERAGE-BANDWIDTH=${rung.videoBitrateBps + rung.audioBitrateBps}`);
    });
    expect(res.text).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
  }, 20_000);

  it("PlaybackSession.manifestUrl points at THIS route for every HLS session (owner-decision V5)", async () => {
    const { sessionId } = await createSimulatedTranscodeSession();
    const session = await admin().get(`/playback/sessions/${sessionId}`);
    expect(session.status).toBe(200);
    expect(session.body.manifestUrl).toBe(`/playback/sessions/${sessionId}/hls/master.m3u8`);
  }, 20_000);

  it("404 for another user's session, an unknown id, and a non-uuid", async () => {
    const { sessionId } = await createSimulatedTranscodeSession();
    expect((await casual().get(`/playback/sessions/${sessionId}/hls/master.m3u8`)).status).toBe(404);
    expect((await admin().get(`/playback/sessions/11111111-1111-4111-8111-111111111111/hls/master.m3u8`)).status).toBe(404);
    expect((await admin().get(`/playback/sessions/not-a-uuid/hls/master.m3u8`)).status).toBe(404);
  }, 20_000);

  it("404 once the session is terminal", async () => {
    const { sessionId } = await createSimulatedTranscodeSession();
    expect((await admin().get(`/playback/sessions/${sessionId}/hls/master.m3u8`)).status).toBe(200);
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      await db.updateTable("playback_sessions").set({ status: "ended" }).where("id", "=", sessionId).execute();
    } finally {
      await db.destroy();
    }
    expect((await admin().get(`/playback/sessions/${sessionId}/hls/master.m3u8`)).status).toBe(404);
  }, 20_000);

  it("?token= works with no Authorization header, exactly like the sibling media routes", async () => {
    const { sessionId } = await createSimulatedTranscodeSession();
    const res = await request(app.getHttpServer()).get(
      `/playback/sessions/${sessionId}/hls/master.m3u8?token=${adminToken}`,
    );
    expect(res.status).toBe(200);
    expect(res.text.startsWith("#EXTM3U")).toBe(true);
  }, 20_000);
});

describe("GET /playback/sessions/{id}/hls/v{K}/… — the variant path family (§9.1.1)", () => {
  const PLAYLIST = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrun0/s000000.m4s\n";

  async function activeSessionWithPlaylist(): Promise<{ sessionId: string; sessionDir: string }> {
    const created = await createSimulatedTranscodeSession();
    mkdirSync(created.sessionDir, { recursive: true });
    writeFileSync(path.join(created.sessionDir, "media.m3u8"), PLAYLIST, "utf8");
    await markSessionActiveWithProducedSegment(created.sessionId, created.sessionDir, 0);
    return created;
  }

  it("v{K}/media.m3u8 serves the SAME bytes as the bare route — one pipeline, one playlist", async () => {
    const { sessionId } = await activeSessionWithPlaylist();
    await setActiveRung(sessionId, 0);

    const bare = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    const v0 = await admin().get(`/playback/sessions/${sessionId}/hls/v0/media.m3u8`);
    const v1 = await admin().get(`/playback/sessions/${sessionId}/hls/v1/media.m3u8`);
    expect(bare.status).toBe(200);
    expect(v0.text).toBe(bare.text);
    // Every variant URL serves the same playlist bytes — RFC 8216's
    // cross-variant obligations (media sequence numbers, discontinuity
    // structure, timelines "match across variants") are met trivially
    // because the variants ARE one playlist.
    expect(v1.text).toBe(bare.text);
  }, 20_000);

  it("v{K}/runN/… serves the SAME segment file as the bare path (no per-variant segment sets on disk)", async () => {
    const { sessionId, sessionDir } = await activeSessionWithPlaylist();
    mkdirSync(path.join(sessionDir, "run0"), { recursive: true });
    writeFileSync(path.join(sessionDir, "run0", "s000000.m4s"), "SEGMENT-BYTES", "utf8");
    await setActiveRung(sessionId, 0);

    const bare = await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000000.m4s`);
    const variant = await admin().get(`/playback/sessions/${sessionId}/hls/v1/run0/s000000.m4s`);
    expect(bare.status).toBe(200);
    expect(variant.status).toBe(200);
    expect(variant.text).toBe(bare.text);
  }, 20_000);

  it("a MISMATCHED K records the rung-switch request (THE PATH IS THE SWITCH SIGNAL)", async () => {
    const { sessionId } = await activeSessionWithPlaylist();
    const ladder = (await storedPlanOf(sessionId))["ladder"] as unknown[];
    expect(ladder.length).toBeGreaterThan(1); // a switch needs somewhere to switch TO
    const target = ladder.length - 1;
    await setActiveRung(sessionId, 0);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/v${target}/media.m3u8`);
    // Served completely normally — the switch is a SIDE EFFECT, not a
    // different response.
    expect(res.status).toBe(200);
    expect((await readRungColumns(sessionId)).pending).toBe(target);
  }, 20_000);

  it("a MATCHING K records nothing — absorbed at the write side, so a pinned client never storms", async () => {
    const { sessionId } = await activeSessionWithPlaylist();
    await setActiveRung(sessionId, 1);

    // A client pinned to rung 1 fetches every playlist and segment under
    // v1/, and none of them is a switch.
    await admin().get(`/playback/sessions/${sessionId}/hls/v1/media.m3u8`);
    await admin().get(`/playback/sessions/${sessionId}/hls/v1/media.m3u8`);
    expect((await readRungColumns(sessionId)).pending).toBeNull();
  }, 20_000);

  it("a BARE legacy path signals nothing at all (§9.1.2 item 2 — treated as the active rung)", async () => {
    const { sessionId } = await activeSessionWithPlaylist();
    await setActiveRung(sessionId, 1);

    await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    await admin().get(`/playback/sessions/${sessionId}/hls/run0/s000000.m4s`);
    expect((await readRungColumns(sessionId)).pending).toBeNull();
  }, 20_000);

  it("a K outside the advertised ladder is a 404 — the URL space never claims more than the master does", async () => {
    const { sessionId } = await activeSessionWithPlaylist();
    const ladder = (await storedPlanOf(sessionId))["ladder"] as unknown[];
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/v${ladder.length + 5}/media.m3u8`);
    expect(res.status).toBe(404);
    expect((await readRungColumns(sessionId)).pending).toBeNull();
  }, 20_000);

  it("the variant prefix cannot widen what the strict segment pattern admits (traversal stays impossible)", async () => {
    const { sessionId } = await activeSessionWithPlaylist();
    for (const evil of ["v0/run0/../../../etc/passwd", "vX/run0/s000000.m4s", "v0/run0/s0.m4s"]) {
      const res = await admin().get(`/playback/sessions/${sessionId}/hls/${evil}`);
      expect(res.status, evil).toBe(404);
    }
  }, 20_000);

  it("a switch request on a mismatched SEGMENT GET is recorded too (hls.js switches mid-fragment-load)", async () => {
    const { sessionId, sessionDir } = await activeSessionWithPlaylist();
    mkdirSync(path.join(sessionDir, "run0"), { recursive: true });
    writeFileSync(path.join(sessionDir, "run0", "s000000.m4s"), "SEGMENT-BYTES", "utf8");
    await setActiveRung(sessionId, 0);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/v1/run0/s000000.m4s`);
    expect(res.status).toBe(200);
    expect((await readRungColumns(sessionId)).pending).toBe(1);
  }, 20_000);

  // §9.1.7's WRITE side (pre-D consolidation item 3a, C2 review finding
  // f5). One GET, both intentions: a far-ahead index (seek) under a `v{K}`
  // naming a different rung (switch). hls.js produces exactly this when a
  // level change coincides with a scrub, or when a level switch's first
  // fragment lands past the produced edge. Both columns must come out of
  // ONE statement — a worker tick that observed only the switch would pay
  // a handoff restart at the live-edge origin and then the seek's restart,
  // two restarts for one intention.
  it("a coincident far-ahead SEGMENT GET under a new v{K} records BOTH columns (the §9.1.7 pair)", async () => {
    const { sessionId } = await activeSessionWithPlaylist();
    await setActiveRung(sessionId, 0);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/v1/run0/s000030.m4s`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");

    expect((await readRungColumns(sessionId)).pending).toBe(1);
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const row = await db.selectFrom("playback_sessions").select(["seek_target_ms"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
      expect(row.seek_target_ms).not.toBeNull();
    } finally {
      await db.destroy();
    }
  }, 20_000);

  it("a far-ahead GET under the ALREADY-ACTIVE v{K} still records the seek (the rung half absorbs, the seek must not)", async () => {
    const { sessionId } = await activeSessionWithPlaylist();
    await setActiveRung(sessionId, 1);

    const res = await admin().get(`/playback/sessions/${sessionId}/hls/v1/run0/s000030.m4s`);
    expect(res.status).toBe(503);

    // Absorb-on-match applies to the RUNG half only — folding both into one
    // statement must never let a pinned client's seek be absorbed with it.
    expect((await readRungColumns(sessionId)).pending).toBeNull();
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const row = await db.selectFrom("playback_sessions").select(["seek_target_ms"]).where("id", "=", sessionId).executeTakeFirstOrThrow();
      expect(row.seek_target_ms).not.toBeNull();
    } finally {
      await db.destroy();
    }
  }, 20_000);
});

describe("served playlist tag model over HTTP (§9.1.5, owner-decision V3)", () => {
  async function serveWorkerPlaylist(text: string): Promise<string> {
    const { sessionId, sessionDir } = await createSimulatedTranscodeSession();
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, "media.m3u8"), text, "utf8");
    await markSessionActiveWithProducedSegment(sessionId, sessionDir, 99);
    const res = await admin().get(`/playback/sessions/${sessionId}/hls/media.m3u8`);
    expect(res.status).toBe(200);
    return res.text;
  }

  it("no EXT-X-PLAYLIST-TYPE ever reaches the client", async () => {
    const served = await serveWorkerPlaylist(
      "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrun0/s000000.m4s\n",
    );
    expect(served).not.toContain("#EXT-X-PLAYLIST-TYPE");
  }, 20_000);

  it("MEDIA-SEQUENCE and DISCONTINUITY-SEQUENCE are emitted together once the head is pruned across a run boundary", async () => {
    const served = await serveWorkerPlaylist(
      "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n" +
        '#EXT-X-MAP:URI="run3/init.mp4"\n#EXTINF:6,\nrun3/s000042.m4s\n',
    );
    expect(served).toContain("#EXT-X-MEDIA-SEQUENCE:42");
    expect(served).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:3");
  }, 20_000);

  it("neither tag is emitted for an unpruned playlist — byte-identical passthrough", async () => {
    const text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrun0/s000000.m4s\n";
    expect(await serveWorkerPlaylist(text)).toBe(text);
  }, 20_000);

  it("a terminal EXT-X-ENDLIST written by the worker reaches the client intact", async () => {
    // Pre-C2 this was UNREACHABLE: a completed encode never got an ENDLIST
    // at all, so a finished stream played out and then polled forever with
    // no resolved duration and no `ended` event on the media element.
    const served = await serveWorkerPlaylist(
      "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrun0/s000000.m4s\n#EXT-X-ENDLIST\n",
    );
    expect(served.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  }, 20_000);

  it("ENDLIST survives the sequence-tag insertion on a pruned playlist", async () => {
    const served = await serveWorkerPlaylist(
      "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrun2/s000030.m4s\n#EXT-X-ENDLIST\n",
    );
    expect(served).toContain("#EXT-X-MEDIA-SEQUENCE:30");
    expect(served).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:2");
    expect(served.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  }, 20_000);
});
