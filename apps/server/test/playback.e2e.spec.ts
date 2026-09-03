// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/playback.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for Phase 3 §11 step 6b (STATE.md P3.7, docs/PLAYBACK.md §9):
// POST /playback/plan (the REAL plan() engine, full §5 shape), POST
// /playback/sessions (admission control, 409 'media-unplayable', 429
// 'transcode-slots-exhausted', a non-direct-play decision now succeeds and
// enqueues a 'transcode' job), GET/DELETE /playback/sessions/{id}, GET
// /playback/sessions/{id}/file (HTTP range serving, unchanged since
// Phase 2), the extended heartbeat sweeper (15-min end + 90s suspend), and
// query-token auth (?token=) on the direct-play file route. HLS/subtitle
// file-serving coverage lives in its own file, playback-hls.e2e.spec.ts
// (a self-contained "seam-level mock" of the worker's on-disk output — see
// that file's header for exactly why and what that means).
//
// Self-sufficient: own ensureTestDatabase suffix, own reset+reseed — same
// convention as apps/server/test/seeded-conformance.spec.ts, whose "repoint
// a seeded row at a real temp file" trick this file reuses (media_files
// rows point at plausible-but-nonexistent paths in seed data; range/byte
// serving needs REAL bytes on disk).

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { countActiveTranscodeSessions, createDb, ensureTestDatabase, getUserByUsername } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import {
  HEARTBEAT_SUSPEND_CUTOFF_MS,
  PlaybackSessionSweeperService,
  STALE_SESSION_CUTOFF_MS,
} from "../src/playback/session-sweeper.service.js";
import { SettingsService } from "../src/settings/settings.service.js";

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

// Harbor Lights (seed.mjs) is hevc/3840x2160/10-bit/mkv + eac3 6ch, no
// subtitle streams, profile/level both NULL (see seed.mjs's INSERT column
// list) — h264-only devices always fail on codec alone regardless of
// profile/level, and a hevc/eac3/mkv-capable device always passes since
// there's no profile/level constraint to violate.
function incompatibleDeviceProfile() {
  return {
    profileId: "web-chrome-h264-only",
    directPlayContainers: ["mp4", "webm"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "h264",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
        maxBitrateBps: 20_000_000,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

function compatibleDeviceProfile() {
  return {
    profileId: "capable-client",
    directPlayContainers: ["mp4", "mkv", "webm"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "hevc",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: 60,
        maxBitrateBps: 80_000_000,
      },
    ],
    hdr: { hdr10: true, hlg: true, dolbyVision: false },
    audio: [{ codec: "eac3", maxChannels: 6, passthrough: true }],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

// Everything about this device is COMPATIBLE with the HDR fixture (hevc,
// 10-bit, 3840x2160, aac 2ch) EXCEPT hdr.hdr10 — isolating Stage C's
// hdr-tone-map-required path (docs/PLAYBACK.md §3) as the ONLY reason that
// fires, so the resulting plan is genuinely refused (tone-map-refused-by-
// policy, empty ladder/ffmpegArgs) for exactly the reason under test, not
// as a side effect of also failing codec/container checks.
function hdrIncompatibleDeviceProfile() {
  return {
    profileId: "hdr-refusal-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "hevc",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: 60,
        maxBitrateBps: null,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

// Login's own DeviceProfile — irrelevant to the playback checks above, just
// has to pass DeviceProfileValidatorService's schema.
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
let hdrFixtureItemId: string;
let realFilePath: string;
const REAL_FILE_SIZE = 10_000;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "playback-e2e-test-secret-not-for-production";
  // Generous default admission cap for this whole suite — the real
  // tier-0 default is 2 (resolve-policy.ts, SPF-8), which every OTHER
  // describe block in this file would immediately exhaust the moment more
  // than two non-direct-play sessions accumulate (none of them ever
  // DELETE the sessions they create). Only the dedicated 429 test below
  // deliberately narrows this, and restores it in a `finally`. 64 (not
  // 1000 — security review F9 gave transcode.maxSimultaneousTranscodes a
  // schema ceiling of 64) is still far more than this suite ever needs
  // concurrently.
  process.env["LOOMBRE_MAX_TRANSCODES"] = "64";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "playback_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "playback-e2e-admin",
    deviceProfile: loginDeviceProfile("playback-e2e-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "playback-e2e-casual",
    deviceProfile: loginDeviceProfile("playback-e2e-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;

  // Repoint the seeded Harbor Lights media_files row at a real temp file
  // with deterministic byte content (index % 251, a prime close to 256 so
  // the pattern doesn't alias against common range sizes) — see this
  // file's header for why (mirrors seeded-conformance.spec.ts's images
  // trick, applied to media_files instead).
  const db = createDb(databaseUrl);
  try {
    const item = await db.selectFrom("catalog_items").select(["id", "library_id"]).where("title", "=", "Harbor Lights").executeTakeFirstOrThrow();
    harborLightsItemId = item.id;
    const file = await db.selectFrom("media_files").select("id").where("item_id", "=", item.id).executeTakeFirstOrThrow();

    const tmpDir = mkdtempSync(path.join(tmpdir(), "loombre-playback-e2e-"));
    realFilePath = path.join(tmpDir, "harbor-lights.mkv");
    const bytes = Buffer.alloc(REAL_FILE_SIZE);
    for (let i = 0; i < REAL_FILE_SIZE; i += 1) bytes[i] = i % 251;
    writeFileSync(realFilePath, bytes);

    await db
      .updateTable("media_files")
      .set({ path: realFilePath, content_hash: "e2e-real-file-hash" })
      .where("id", "=", file.id)
      .execute();

    // A SECOND, ISOLATED item + file for the genuinely-unplayable 409 test
    // (tone-map-refused-by-policy) — deliberately separate from Harbor
    // Lights so setting its video stream's `hdr` flag can never leak into
    // any other test's expectations (Harbor Lights' own hdr stays NULL/
    // 'none', matching every other describe block's assumptions).
    const now = Date.now();
    const hdrItem = await db
      .insertInto("catalog_items")
      .values({
        library_id: item.library_id,
        item_type: "movie",
        parent_id: null,
        title: "HDR Refusal Fixture",
        sort_title: "hdr refusal fixture",
        year: null,
        community_rating: null,
        added_at_ms: now,
        updated_at_ms: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    hdrFixtureItemId = hdrItem.id;

    const hdrFile = await db
      .insertInto("media_files")
      .values({
        item_id: hdrFixtureItemId,
        // Distinct, plausible-but-nonexistent path (media_files.path is
        // UNIQUE; this fixture's 409 test never touches bytes on disk, so
        // it doesn't need to point at anything real, unlike Harbor Lights'
        // own repointed file above).
        path: `/data/movies/hdr-refusal-fixture-${hdrFixtureItemId}.mkv`,
        content_hash: "e2e-hdr-fixture-hash",
        size_bytes: REAL_FILE_SIZE,
        container: "mkv",
        duration_ms: 108 * 60_000,
        probed_at_ms: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("media_streams")
      .values({
        file_id: hdrFile.id,
        stream_index: 0,
        stream_type: "video",
        codec: "hevc",
        width: 3840,
        height: 2160,
        bit_depth: 10,
        frame_rate: 24,
        is_default: true,
        is_forced: false,
        hdr: "hdr10",
      })
      .execute();
    await db
      .insertInto("media_streams")
      .values({
        file_id: hdrFile.id,
        stream_index: 1,
        stream_type: "audio",
        codec: "aac",
        channels: 2,
        sample_rate: 48000,
        is_default: true,
        is_forced: false,
      })
      .execute();
  } finally {
    await db.destroy();
  }
}, 30_000);

afterAll(async () => {
  await app.close();
});

function admin() {
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${adminToken}`),
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set("Authorization", `Bearer ${adminToken}`),
    put: (url: string) => request(app.getHttpServer()).put(url).set("Authorization", `Bearer ${adminToken}`),
  };
}
function casual() {
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${casualToken}`),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set("Authorization", `Bearer ${casualToken}`),
  };
}

async function createDirectPlaySession(): Promise<string> {
  const res = await admin()
    .post("/playback/sessions")
    .send({
      itemId: harborLightsItemId,
      device: compatibleDeviceProfile(),
      network: { maxBitrateBps: 50_000_000, isLocal: true },
      mode: "stream",
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const ENGINE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Asserts `body` is a structurally complete §5 PlaybackPlan (docs/
 *  PLAYBACK.md §5) — every REQUIRED top-level field present with the right
 *  shape. Used by both the plan-preview and session-create describe
 *  blocks below since both now return the SAME real plan() output. */
function expectFullPlaybackPlanShape(body: Record<string, unknown>): void {
  expect(["direct-play", "direct-stream", "remux", "transcode"]).toContain(body["decision"]);
  expect(Array.isArray(body["reasons"])).toBe(true);
  expect(["source", "fmp4-hls", "ts-hls", "mp4"]).toContain(body["container"]);
  expect(body["video"]).toMatchObject({ action: expect.stringMatching(/^(copy|transcode|none)$/) });
  expect(body["audio"]).toMatchObject({ action: expect.stringMatching(/^(copy|transcode|none)$/) });
  expect(body["subtitle"]).toMatchObject({ strategy: expect.stringMatching(/^(none|embed|hls-vtt|burn-in)$/) });
  expect(Array.isArray(body["ladder"])).toBe(true);
  expect(Array.isArray(body["ffmpegArgs"])).toBe(true);
  expect(typeof body["engineVersion"]).toBe("string");
  expect(body["engineVersion"] as string).toMatch(ENGINE_VERSION_PATTERN);
}

describe("POST /playback/plan (Phase 3 §11 step 6b — the real plan() engine, full §5 shape)", () => {
  it("compatible device -> direct-play, empty reasons, full §5 shape", async () => {
    const res = await admin()
      .post("/playback/plan")
      .send({
        itemId: harborLightsItemId,
        device: compatibleDeviceProfile(),
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectFullPlaybackPlanShape(res.body);
    expect(res.body.decision).toBe("direct-play");
    expect(res.body.reasons).toEqual([]);
    expect(res.body.container).toBe("source");
    expect(res.body.ffmpegArgs).toEqual([]);
    expect(res.body.ladder).toEqual([]);
  });

  it("incompatible device (forced transcode fixture) -> full §5 shape with a real ladder + non-empty ffmpegArgs", async () => {
    const res = await admin()
      .post("/playback/plan")
      .send({
        itemId: harborLightsItemId,
        device: incompatibleDeviceProfile(),
        network: { maxBitrateBps: 50_000_000, isLocal: false },
        mode: "stream",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectFullPlaybackPlanShape(res.body);
    expect(res.body.decision).toBe("transcode");
    const codes = (res.body.reasons as Array<{ code: string }>).map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(["container-not-direct-playable", "video-codec-unsupported", "audio-codec-unsupported"]),
    );
    expect(res.body.video.action).toBe("transcode");
    expect(res.body.ladder.length).toBeGreaterThan(0);
    expect(res.body.ffmpegArgs.length).toBeGreaterThan(0);
    // No hardware capability snapshot exists in this isolated test DB ->
    // resolve-caps.ts's software-only fallback -> Stage G routes through
    // 'software' (docs/PLAYBACK.md §8.3 rule iii).
    expect(res.body.video.encoder).toBe("software");
  });

  it("W1/D-1: a PERSISTED capability snapshot with ZERO backends still routes software (empty == missing)", async () => {
    // A current snapshot row exists but persisted no backend rows.
    // resolve-caps.ts used to pass {backends: []} to plan() verbatim,
    // bypassing the software-only fallback synthesis. NOTE (honest scope,
    // opus review W1-R4): with this h264-only device profile the plan is
    // byte-identical either way (Stage G rule (iii) routes software
    // unconditionally), so this is an integration SMOKE through the real
    // HTTP surface, not the revert-detector — the branch itself is pinned
    // at the unit level by resolve-caps.spec.ts's capabilitiesFromSnapshot
    // cases, which DO fail on revert.
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      await db
        .insertInto("hw_capability_snapshots")
        .values({
          ffmpeg_build_hash: "sha256-w1-empty",
          gpu_fingerprint: "",
          platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
          verified_at_ms: Date.now(),
          is_current: true,
        })
        .execute();

      const res = await admin()
        .post("/playback/plan")
        .send({
          itemId: harborLightsItemId,
          device: incompatibleDeviceProfile(),
          network: { maxBitrateBps: 50_000_000, isLocal: false },
          mode: "stream",
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.decision).toBe("transcode");
      expect(res.body.video.encoder).toBe("software");
      expect(res.body.ffmpegArgs.length).toBeGreaterThan(0);
    } finally {
      await db.deleteFrom("hw_capability_backends").execute();
      await db.deleteFrom("hw_capability_snapshots").execute();
      await db.destroy();
    }
  });

  it("bodyless -> 422", async () => {
    const res = await admin().post("/playback/plan").send();
    expect(res.status).toBe(422);
  });

  it("nonexistent item -> 404", async () => {
    const res = await admin()
      .post("/playback/plan")
      .send({
        itemId: "11111111-1111-4111-8111-111111111111",
        device: compatibleDeviceProfile(),
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
      });
    expect(res.status).toBe(404);
  });

  it("respects a request-body selection pin (docs/PLAYBACK.md §2.6)", async () => {
    const res = await admin()
      .post("/playback/plan")
      .send({
        itemId: harborLightsItemId,
        device: compatibleDeviceProfile(),
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
        selection: { audioStreamIndex: 1 },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Harbor Lights has exactly one audio stream (index 1, eac3) — pinning
    // it explicitly must not change the outcome, but proves the pin is at
    // least accepted/parsed without a validation error.
    expect(res.body.decision).toBe("direct-play");
  });
});

describe("POST /playback/sessions (Phase 3 §11 step 6b: admission control + real engine)", () => {
  it("direct-playable -> 201 with a direct-play PlaybackSession, real engineVersion, null manifestUrl", async () => {
    const res = await admin()
      .post("/playback/sessions")
      .send({
        itemId: harborLightsItemId,
        device: compatibleDeviceProfile(),
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.itemId).toBe(harborLightsItemId);
    expect(res.body.status).toBe("active");
    expectFullPlaybackPlanShape(res.body.plan);
    expect(res.body.plan.decision).toBe("direct-play");
    expect(res.body.manifestUrl).toBeNull();

    // Gap-closure regression (Phase 2): PlaybackSession.media (web track
    // pickers need the selected file's stream metadata) must be populated
    // on create — Harbor Lights (seed.mjs) is hevc/3840x2160/10-bit/mkv +
    // eac3 6ch, no subtitle streams.
    expect(res.body.media).toBeDefined();
    expect(res.body.media.container).toBe("mkv");
    expect(res.body.media.video).toHaveLength(1);
    expect(res.body.media.video[0].codec).toBe("hevc");
    expect(res.body.media.video[0].width).toBe(3840);
    expect(res.body.media.audio).toHaveLength(1);
    expect(res.body.media.audio[0].codec).toBe("eac3");
    expect(res.body.media.audio[0].channels).toBe(6);
    expect(res.body.media.subtitle).toEqual([]);
  });

  it("a device requiring transcode now SUCCEEDS (201) instead of the old Phase 2 blanket 409 — 'created' status, non-null manifestUrl", async () => {
    const res = await admin()
      .post("/playback/sessions")
      .send({
        itemId: harborLightsItemId,
        device: incompatibleDeviceProfile(),
        network: { maxBitrateBps: 5_000_000, isLocal: false },
        mode: "stream",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("created"); // decision !== direct-play -> waits for the worker
    expectFullPlaybackPlanShape(res.body.plan);
    expect(res.body.plan.decision).toBe("transcode");
    expect(res.body.plan.ffmpegArgs.length).toBeGreaterThan(0);
    // why (Wave C2 / owner-decision V5, docs/PLAYBACK.md §9.1.2 item 3):
    // `manifestUrl` now points at the MULTI-VARIANT master playlist for
    // every HLS session, ladder-empty ones included — one client path, no
    // branch, and the variants a client may switch to come from the plan's
    // own ladder. Value semantics only; the schema is untouched, and the
    // media playlist still serves the same bytes at v{K}/media.m3u8.
    expect(res.body.manifestUrl).toBe(`/playback/sessions/${res.body.id}/hls/master.m3u8`);
  });

  it("a genuinely UNPLAYABLE plan (tone-map refused by policy) -> 409 'media-unplayable' carrying real reasons", async () => {
    const res = await admin()
      .post("/playback/sessions")
      .send({
        itemId: hdrFixtureItemId,
        device: hdrIncompatibleDeviceProfile(),
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("media-unplayable");
    expect(Array.isArray(res.body.reasons)).toBe(true);
    const codes = (res.body.reasons as Array<{ code: string }>).map((r: { code: string }) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["hdr-tone-map-required", "tone-map-refused-by-policy"]));
  });

  it("429 'transcode-slots-exhausted' when the admission cap is reached (self-contained: measures the current count first) — Addendum A: cap comes from SettingsService, mutated via the SAME admin API path an operator would use, not a raw env poke", async () => {
    // Addendum A, lane S3: SettingsService caches its resolution (env-pin
    // > DB > default, A8) and only re-reads process.env at bootstrap/
    // reload() — it does NOT poll process.env on every admission check
    // (env vars don't change at runtime for a real deployment either).
    // This suite's beforeAll env-pins LOOMBRE_MAX_TRANSCODES=64 for every
    // OTHER test's sake; a pinned setting is LOCKED against DB writes
    // (settings.service.ts's updateSetting() 409s on a locked key), so
    // this test must temporarily lift the pin to drive the cap through a
    // real DB write instead — exactly the mechanism an admin's PUT
    // /v1/admin/settings/transcode.maxSimultaneousTranscodes call uses
    // under the hood (lane S2 wires that controller; this test calls the
    // same SettingsService method directly since the HTTP route isn't
    // wired into this AppModule instance's test yet).
    const settingsService = app.get(SettingsService);
    const db = createDb(process.env["DATABASE_URL"]!);
    let currentActive: number;
    let adminId: string;
    try {
      currentActive = await countActiveTranscodeSessions(db);
      const adminUser = await getUserByUsername(db, "admin");
      if (!adminUser) throw new Error("seed did not create an admin user");
      adminId = adminUser.id;
    } finally {
      await db.destroy();
    }

    delete process.env["LOOMBRE_MAX_TRANSCODES"];
    await settingsService.reload();
    try {
      await settingsService.updateSetting({
        key: "transcode.maxSimultaneousTranscodes",
        value: currentActive + 1,
        actorUserId: adminId,
        nowMs: Date.now(),
      });

      const first = await admin()
        .post("/playback/sessions")
        .send({
          itemId: harborLightsItemId,
          device: incompatibleDeviceProfile(),
          network: { maxBitrateBps: 5_000_000, isLocal: false },
          mode: "stream",
        });
      expect(first.status, JSON.stringify(first.body)).toBe(201);

      const second = await admin()
        .post("/playback/sessions")
        .send({
          itemId: harborLightsItemId,
          device: incompatibleDeviceProfile(),
          network: { maxBitrateBps: 5_000_000, isLocal: false },
          mode: "stream",
        });
      expect(second.status, JSON.stringify(second.body)).toBe(429);
      expect(second.body.code).toBe("transcode-slots-exhausted");

      // A5 LAW: the session admitted above (`first`) must survive this
      // reduction untouched — a settings change never drops an active
      // session, it only changes what happens for the NEXT admission
      // check (already proven above: `second` was refused, `first` was
      // not retroactively touched).
      const stillThere = await admin().get(`/playback/sessions/${first.body.id}`);
      expect(stillThere.status, JSON.stringify(stillThere.body)).toBe(200);
      expect(stillThere.body.status).not.toBe("ended");
      expect(stillThere.body.status).not.toBe("failed");
    } finally {
      // Restore the suite-wide generous default (see beforeAll) — NOT
      // `delete`, which would fall back to the tier-0 default of 1 and
      // starve every later test in this file.
      process.env["LOOMBRE_MAX_TRANSCODES"] = "64";
      await settingsService.reload();
    }
  });

  it("bodyless -> 422", async () => {
    const res = await admin().post("/playback/sessions").send();
    expect(res.status).toBe(422);
  });
});

describe("SPF-9 admission-time reclamation — a heartbeat-suspended transcode session can be reclaimed to admit a new request at the cap", () => {
  /** Same lift-the-env-pin-then-write-through-SettingsService dance the
   *  429 test above uses (LOOMBRE_MAX_TRANSCODES is env-pinned suite-wide
   *  — a pinned key 409s on updateSetting). Pins the cap to EXACTLY the
   *  current baseline + 1, so the ONE session this test creates itself is
   *  what puts admission at the cap — never a hardcoded `1` racing this
   *  file's other (never-cleaned-up) sessions. */
  async function pinCapToBaselinePlusOne(settingsService: SettingsService, adminId: string): Promise<number> {
    const db = createDb(process.env["DATABASE_URL"]!);
    let baseline: number;
    try {
      baseline = await countActiveTranscodeSessions(db);
    } finally {
      await db.destroy();
    }
    delete process.env["LOOMBRE_MAX_TRANSCODES"];
    await settingsService.reload();
    await settingsService.updateSetting({
      key: "transcode.maxSimultaneousTranscodes",
      value: baseline + 1,
      actorUserId: adminId,
      nowMs: Date.now(),
    });
    return baseline + 1;
  }

  async function restoreGenerousCap(settingsService: SettingsService): Promise<void> {
    process.env["LOOMBRE_MAX_TRANSCODES"] = "64";
    await settingsService.reload();
  }

  it("evicts the stalest heartbeat-suspended session (suspended_by_throttle=false) to admit a new create at the cap", async () => {
    const settingsService = app.get(SettingsService);
    const db = createDb(process.env["DATABASE_URL"]!);
    let adminId: string;
    try {
      const adminUser = await getUserByUsername(db, "admin");
      if (!adminUser) throw new Error("seed did not create an admin user");
      adminId = adminUser.id;
    } finally {
      await db.destroy();
    }

    try {
      await pinCapToBaselinePlusOne(settingsService, adminId);

      const first = await admin()
        .post("/playback/sessions")
        .send({
          itemId: harborLightsItemId,
          device: incompatibleDeviceProfile(),
          network: { maxBitrateBps: 5_000_000, isLocal: false },
          mode: "stream",
        });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const firstId = first.body.id as string;

      // Simulate the sweeper's own 90s heartbeat-stale suspend having
      // already happened (no real client is heartbeating in this suite —
      // same seam-level-mock rationale as the sweeper describe block
      // above): status suspended, suspended_by_throttle FALSE (a
      // heartbeat cause, never the worker's throttle), last_heartbeat_ms
      // safely past the default 90s cutoff.
      const backdateDb = createDb(process.env["DATABASE_URL"]!);
      try {
        await backdateDb
          .updateTable("playback_sessions")
          .set({
            status: "suspended",
            suspended_by_throttle: false,
            last_heartbeat_ms: Date.now() - HEARTBEAT_SUSPEND_CUTOFF_MS - 5_000,
          })
          .where("id", "=", firstId)
          .execute();
      } finally {
        await backdateDb.destroy();
      }

      // The cap is exactly at capacity (first occupies the +1 slot) — a
      // bare admission would 429 here without SPF-9's reclaim.
      const second = await admin()
        .post("/playback/sessions")
        .send({
          itemId: harborLightsItemId,
          device: incompatibleDeviceProfile(),
          network: { maxBitrateBps: 5_000_000, isLocal: false },
          mode: "stream",
        });
      expect(second.status, JSON.stringify(second.body)).toBe(201);

      const firstAfter = await admin().get(`/playback/sessions/${firstId}`);
      expect(firstAfter.status).toBe(200);
      expect(firstAfter.body.status).toBe("failed");
      expect(firstAfter.body.errorCode).toBe("evicted-for-admission");
    } finally {
      await restoreGenerousCap(settingsService);
    }
  });

  it("does NOT reclaim an ACTIVE session — a second create at the cap still 429s", async () => {
    const settingsService = app.get(SettingsService);
    const db = createDb(process.env["DATABASE_URL"]!);
    let adminId: string;
    try {
      const adminUser = await getUserByUsername(db, "admin");
      if (!adminUser) throw new Error("seed did not create an admin user");
      adminId = adminUser.id;
    } finally {
      await db.destroy();
    }

    try {
      await pinCapToBaselinePlusOne(settingsService, adminId);

      const first = await admin()
        .post("/playback/sessions")
        .send({
          itemId: harborLightsItemId,
          device: incompatibleDeviceProfile(),
          network: { maxBitrateBps: 5_000_000, isLocal: false },
          mode: "stream",
        });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const firstId = first.body.id as string;

      // ACTIVE, not suspended, and well past any staleness cutoff — the
      // A5 law (no admission decision may drop an active session) means
      // this is never an eviction candidate no matter how stale its
      // heartbeat looks.
      const backdateDb = createDb(process.env["DATABASE_URL"]!);
      try {
        await backdateDb
          .updateTable("playback_sessions")
          .set({ status: "active", last_heartbeat_ms: Date.now() - HEARTBEAT_SUSPEND_CUTOFF_MS - 5_000 })
          .where("id", "=", firstId)
          .execute();
      } finally {
        await backdateDb.destroy();
      }

      const second = await admin()
        .post("/playback/sessions")
        .send({
          itemId: harborLightsItemId,
          device: incompatibleDeviceProfile(),
          network: { maxBitrateBps: 5_000_000, isLocal: false },
          mode: "stream",
        });
      expect(second.status, JSON.stringify(second.body)).toBe(429);
      expect(second.body.code).toBe("transcode-slots-exhausted");

      const firstAfter = await admin().get(`/playback/sessions/${firstId}`);
      expect(firstAfter.status).toBe(200);
      expect(firstAfter.body.status).toBe("active");
    } finally {
      await restoreGenerousCap(settingsService);
    }
  });

  it("direct-play creates are unaffected: they never enter the gate, so a full transcode cap never blocks one", async () => {
    const settingsService = app.get(SettingsService);
    const db = createDb(process.env["DATABASE_URL"]!);
    let adminId: string;
    try {
      const adminUser = await getUserByUsername(db, "admin");
      if (!adminUser) throw new Error("seed did not create an admin user");
      adminId = adminUser.id;
    } finally {
      await db.destroy();
    }

    try {
      await pinCapToBaselinePlusOne(settingsService, adminId);

      const first = await admin()
        .post("/playback/sessions")
        .send({
          itemId: harborLightsItemId,
          device: incompatibleDeviceProfile(),
          network: { maxBitrateBps: 5_000_000, isLocal: false },
          mode: "stream",
        });
      expect(first.status, JSON.stringify(first.body)).toBe(201);

      const backdateDb = createDb(process.env["DATABASE_URL"]!);
      try {
        await backdateDb
          .updateTable("playback_sessions")
          .set({ status: "active", last_heartbeat_ms: Date.now() })
          .where("id", "=", first.body.id)
          .execute();
      } finally {
        await backdateDb.destroy();
      }

      const directPlay = await createDirectPlaySession();
      const gotDirectPlay = await admin().get(`/playback/sessions/${directPlay}`);
      expect(gotDirectPlay.status).toBe(200);
      expect(gotDirectPlay.body.status).toBe("active");
    } finally {
      await restoreGenerousCap(settingsService);
    }
  });
});

describe("GET/DELETE /playback/sessions/{id}", () => {
  it("owner can GET; DELETE ends it (204); GET afterward shows status ended", async () => {
    const sessionId = await createDirectPlaySession();

    const got = await admin().get(`/playback/sessions/${sessionId}`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("active");
    // Gap-closure regression: GET re-assembles media too, not just create.
    expect(got.body.media).toBeDefined();
    expect(got.body.media.container).toBe("mkv");
    // SPF-7: an active session never carries an error detail.
    expect(got.body.errorDetail).toBeNull();

    const ended = await admin().delete(`/playback/sessions/${sessionId}`);
    expect(ended.status).toBe(204);

    const gotAfter = await admin().get(`/playback/sessions/${sessionId}`);
    expect(gotAfter.status).toBe(200);
    expect(gotAfter.body.status).toBe("ended");
  });

  it("SPF-7: a failed session's GET carries errorCode + a path-stripped errorDetail derived from the worker's stderr tail", async () => {
    const sessionId = await createDirectPlaySession();
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      // Simulates what apps/worker/src/transcode/runner.ts's
      // markSessionFailed actually persists: a specific error_code (SPF-7's
      // classifyFfmpegFailure) plus the RAW ffmpeg stderr tail — the server
      // never stores a separately-sanitized detail column.
      await db
        .updateTable("playback_sessions")
        .set({
          status: "failed",
          error_code: "transcode-input-missing",
          stderr_tail: "/srv/media/x.mkv: No such file or directory",
        })
        .where("id", "=", sessionId)
        .execute();

      const got = await admin().get(`/playback/sessions/${sessionId}`);
      expect(got.status).toBe(200);
      expect(got.body.status).toBe("failed");
      expect(got.body.errorCode).toBe("transcode-input-missing");
      expect(got.body.errorDetail).toBe("x.mkv: No such file or directory");
      // The server-side directory must never leak into the response.
      expect(JSON.stringify(got.body)).not.toContain("/srv/media");
    } finally {
      await db.destroy();
    }
  });

  it("cross-user access is 404 for both GET and DELETE", async () => {
    const sessionId = await createDirectPlaySession();

    const casualGet = await casual().get(`/playback/sessions/${sessionId}`);
    expect(casualGet.status).toBe(404);

    const casualDelete = await casual().delete(`/playback/sessions/${sessionId}`);
    expect(casualDelete.status).toBe(404);

    // Still ends fine for the real owner afterward.
    const adminDelete = await admin().delete(`/playback/sessions/${sessionId}`);
    expect(adminDelete.status).toBe(204);
  });

  it("nonexistent session id -> 404", async () => {
    const res = await admin().get("/playback/sessions/11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(404);
  });
});

describe("GET /playback/sessions/{id}/file (HTTP range serving)", () => {
  it("no Range -> 200, full body, Accept-Ranges: bytes, ETag present", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await admin().get(`/playback/sessions/${sessionId}/file`);
    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(String(REAL_FILE_SIZE));
    expect(res.headers["etag"]).toBe('"e2e-real-file-hash"');
    expect(res.headers["cache-control"]).toBe("private");
    expect((res.body as Buffer).length).toBe(REAL_FILE_SIZE);
  });

  it("single Range -> 206 with correct Content-Range/Content-Length and exact bytes", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await admin().get(`/playback/sessions/${sessionId}/file`).set("Range", "bytes=100-199");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 100-199/${REAL_FILE_SIZE}`);
    expect(res.headers["content-length"]).toBe("100");
    const body = res.body as Buffer;
    expect(body.length).toBe(100);
    expect(body[0]).toBe(100 % 251);
    expect(body[99]).toBe(199 % 251);
  });

  it("open-ended Range -> 206 through end of file", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await admin()
      .get(`/playback/sessions/${sessionId}/file`)
      .set("Range", `bytes=${REAL_FILE_SIZE - 10}-`);
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes ${REAL_FILE_SIZE - 10}-${REAL_FILE_SIZE - 1}/${REAL_FILE_SIZE}`);
    expect(res.headers["content-length"]).toBe("10");
  });

  it("malformed Range -> 416", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await admin().get(`/playback/sessions/${sessionId}/file`).set("Range", "bytes=abc-def");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${REAL_FILE_SIZE}`);
  });

  it("unsatisfiable Range (start beyond size) -> 416", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await admin()
      .get(`/playback/sessions/${sessionId}/file`)
      .set("Range", `bytes=${REAL_FILE_SIZE + 1000}-${REAL_FILE_SIZE + 2000}`);
    expect(res.status).toBe(416);
  });

  it("If-Range mismatch -> Range safely ignored, full 200", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await admin()
      .get(`/playback/sessions/${sessionId}/file`)
      .set("Range", "bytes=0-99")
      .set("If-Range", '"stale-etag"');
    expect(res.status).toBe(200);
    expect((res.body as Buffer).length).toBe(REAL_FILE_SIZE);
  });

  it("If-Range match -> Range honored, 206", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await admin()
      .get(`/playback/sessions/${sessionId}/file`)
      .set("Range", "bytes=0-99")
      .set("If-Range", '"e2e-real-file-hash"');
    expect(res.status).toBe(206);
  });

  it("cross-user access is 404 (byte-identical shape to nonexistent)", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await casual().get(`/playback/sessions/${sessionId}/file`);
    expect(res.status).toBe(404);
  });

  it("no Authorization and no ?token= -> 401", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/file`);
    expect(res.status).toBe(401);
  });
});

describe("query-token auth (P2.18) — scoped to exactly the two decorated GET routes", () => {
  it("?token= works on GET /playback/sessions/{id}/file with no Authorization header", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/file?token=${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("?token= works on GET /images/{entityType}/{id}/{kind} with no Authorization header", async () => {
    // No real image row is guaranteed to exist for Harbor Lights in this
    // isolated seed, so this only proves AUTH passes (not 401) — the
    // resource itself may legitimately 404. Query-token auth is the thing
    // under test here, not the image pipeline (already covered by
    // seeded-conformance.spec.ts's images round trip).
    const res = await request(app.getHttpServer()).get(
      `/images/movie/${harborLightsItemId}/poster?token=${adminToken}`,
    );
    expect(res.status).not.toBe(401);
  });

  it("a malformed/invalid ?token= on a decorated route -> 401", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/file?token=not-a-real-token`);
    expect(res.status).toBe(401);
  });

  it("?token= is REJECTED on a non-decorated route (GET /progress) -> still 401", async () => {
    const res = await request(app.getHttpServer()).get(`/progress?token=${adminToken}`);
    expect(res.status).toBe(401);
  });

  it("header auth still works unchanged on a decorated route", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await admin().get(`/playback/sessions/${sessionId}/file`);
    expect(res.status).toBe(200);
  });

  it("a 401 from query-token auth never echoes the token back in the problem body", async () => {
    const sessionId = await createDirectPlaySession();
    const res = await request(app.getHttpServer()).get(`/playback/sessions/${sessionId}/file?token=not-a-real-token`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("not-a-real-token");
  });
});

describe("PUT /progress/{itemId} with sessionId heartbeats the session (docs/PLAYBACK.md §9)", () => {
  it("heartbeats last_heartbeat_ms and keeps status active", async () => {
    const sessionId = await createDirectPlaySession();

    const put = await admin()
      .put(`/progress/${harborLightsItemId}`)
      .send({ positionMs: 60_000, durationMs: 6_480_000, state: "in-progress", sessionId });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.durationMs).toBe(6_480_000);

    const session = await admin().get(`/playback/sessions/${sessionId}`);
    expect(session.status).toBe(200);
    expect(session.body.status).toBe("active");
  });

  it("an invalid sessionId does not fail the progress write itself", async () => {
    const put = await admin()
      .put(`/progress/${harborLightsItemId}`)
      .send({ positionMs: 1000, state: "in-progress", sessionId: "11111111-1111-4111-8111-111111111111" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  });

  // ── Reported positions are SOURCE time; stored VERBATIM (gap-F6 r3) ───
  //
  // The V8 client reports SOURCE-axis positions: §9.1.5 rule 7 stamps
  // every served segment with a PROGRAM-DATE-TIME whose epoch IS source
  // time, the player's watched/displayed positions are mapped through it
  // (apps/web lib/source-clock.ts, lib/watched-progress.ts), and its seek
  // targets are source-ms by definition. The old ingestion conversion
  // (presentation -> source through the CURRENT served playlist) assumed a
  // `video.currentTime` reporter — and double-mapped every V8 report on a
  // multi-run session. Live 2026-08-24 (gap-F6 verify refutation): an
  // honest watched position of 23_880 (0:23.9) PUT against a 3-run session
  // was stored as 522_280 (8:42) — the phantom resume point for content
  // never watched. The conversion was also unsound on its own terms: the
  // client's presentation axis is anchored at ITS first playlist load,
  // while the server walked the CURRENT (head-pruned) playlist — the two
  // agree only while nothing has pruned. These cases pin verbatim storage.
  async function createTranscodeSessionWithRuns(): Promise<{ sessionId: string; sessionDir: string }> {
    const created = await admin()
      .post("/playback/sessions")
      .send({
        itemId: harborLightsItemId,
        device: {
          profileId: "progress-map-e2e-h264-only",
          directPlayContainers: ["mp4", "webm"],
          hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
          video: [{ codec: "h264", maxProfile: null, maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: 20_000_000 }],
          hdr: { hdr10: false, hlg: false, dolbyVision: false },
          audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
          subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
          maxStreamBitrateBps: null,
        },
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sessionId = created.body.id as string;
    const sessionDir = mkdtempSync(path.join(tmpdir(), "loombre-progress-map-"));

    // Two runs. Run 0 covers source 0..60s as ten 6.006s segments; run 1 is
    // a forward seek to 10:00 producing ten 6.006s segments numbered 10..19.
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:7", "#EXT-X-PLAYLIST-TYPE:EVENT", '#EXT-X-MAP:URI="run0/init.mp4"'];
    for (let i = 0; i < 10; i += 1) {
      lines.push("#EXTINF:6.006,");
      lines.push(`run0/s${String(i).padStart(6, "0")}.m4s`);
    }
    lines.push("#EXT-X-DISCONTINUITY");
    lines.push('#EXT-X-MAP:URI="run1/init.mp4"');
    for (let i = 10; i < 20; i += 1) {
      lines.push("#EXTINF:6.006,");
      lines.push(`run1/s${String(i).padStart(6, "0")}.m4s`);
    }
    writeFileSync(path.join(sessionDir, "media.m3u8"), lines.join("\n") + "\n", "utf8");

    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      await db
        .updateTable("playback_sessions")
        .set({ status: "active", staging_dir: sessionDir, produced_segment: 19, updated_at_ms: Date.now() })
        .where("id", "=", sessionId)
        .execute();
      for (const run of [
        { run_index: 0, start_segment: 0, source_origin_ms: 0 },
        { run_index: 1, start_segment: 10, source_origin_ms: 600_000 },
      ]) {
        await db.insertInto("transcode_runs").values({ session_id: sessionId, ...run, created_at_ms: Date.now() }).execute();
      }
    } finally {
      await db.destroy();
    }
    return { sessionId, sessionDir };
  }

  async function readStoredPositionMs(): Promise<number> {
    const res = await admin().get(`/progress/${harborLightsItemId}`);
    expect(res.status).toBe(200);
    return Number(res.body.positionMs);
  }

  it("a multi-run heartbeat stores the client's SOURCE position VERBATIM — no ingestion re-mapping (gap-F6 round 3)", async () => {
    const { sessionId } = await createTranscodeSessionWithRuns();

    // The viewer has WATCHED to source 66_066 ms (the client's watched
    // position is source-axis by construction). The old conversion read
    // this as presentation time, walked the playlist into run 1, and
    // stored 606_006 — a resume point 9 minutes past anything the viewer
    // ever saw (the live phantom's exact mechanism).
    const put = await admin()
      .put(`/progress/${harborLightsItemId}`)
      .send({ positionMs: 66_066, durationMs: 6_480_000, state: "in-progress", sessionId });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    expect(await readStoredPositionMs()).toBe(66_066);
  });

  it("a position inside run 0 of a multi-run session is stored verbatim too (identity either way)", async () => {
    const { sessionId } = await createTranscodeSessionWithRuns();
    const put = await admin()
      .put(`/progress/${harborLightsItemId}`)
      .send({ positionMs: 30_030, durationMs: 6_480_000, state: "in-progress", sessionId });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await readStoredPositionMs()).toBe(30_030);
  });

  it("a direct-play session (no runs, no playlist) stores the client position verbatim", async () => {
    const sessionId = await createDirectPlaySession();
    const put = await admin()
      .put(`/progress/${harborLightsItemId}`)
      .send({ positionMs: 123_456, durationMs: 6_480_000, state: "in-progress", sessionId });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await readStoredPositionMs()).toBe(123_456);
  });
});

describe("heartbeat sweeper (docs/PLAYBACK.md §9, 15-minute cutoff)", () => {
  it("direct invocation ends stale sessions and leaves recently-heartbeated ones alone", async () => {
    const staleSessionId = await createDirectPlaySession();
    const freshSessionId = await createDirectPlaySession();

    // Backdate the stale session's clock directly (raw SQL) rather than
    // trying to synthesize a fake "now" through the real HTTP heartbeat
    // path, which always stamps the server's REAL wall clock — there is no
    // way to inject a synthetic heartbeat time through the public API, so
    // the DB row is the only lever a test has here.
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const twentyMinAgo = Date.now() - 20 * 60_000;
      await db
        .updateTable("playback_sessions")
        .set({ started_at_ms: twentyMinAgo, updated_at_ms: twentyMinAgo })
        .where("id", "=", staleSessionId)
        .execute();
    } finally {
      await db.destroy();
    }

    // freshSessionId gets a REAL, current heartbeat.
    await admin()
      .put(`/progress/${harborLightsItemId}`)
      .send({ positionMs: 1000, state: "in-progress", sessionId: freshSessionId });

    const sweeper = app.get(PlaybackSessionSweeperService);
    const sweptCount = await sweeper.sweepOnce();
    expect(sweptCount).toBeGreaterThanOrEqual(1);

    const staleAfter = await admin().get(`/playback/sessions/${staleSessionId}`);
    expect(staleAfter.body.status).toBe("failed");
    expect(staleAfter.body.errorCode).toBe("heartbeat-timeout");

    const freshAfter = await admin().get(`/playback/sessions/${freshSessionId}`);
    expect(freshAfter.body.status).toBe("active");
  });

  it("Phase 3 §11 step 6b deliverable 5: a 90s-stale ACTIVE session is SUSPENDED (not ended), suspended_by_throttle stays false", async () => {
    // A transcode-decision session, simulating the worker having already
    // started it (status: created -> active is normally worker-driven;
    // this test drives the row directly since no real worker runs in this
    // suite — see playback-hls.e2e.spec.ts's header for the same
    // seam-level-mock rationale).
    const createRes = await admin()
      .post("/playback/sessions")
      .send({
        itemId: harborLightsItemId,
        device: incompatibleDeviceProfile(),
        network: { maxBitrateBps: 5_000_000, isLocal: false },
        mode: "stream",
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const sessionId = createRes.body.id as string;

    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const ninetyFiveSecAgo = Date.now() - 95_000;
      await db
        .updateTable("playback_sessions")
        .set({ status: "active", last_heartbeat_ms: ninetyFiveSecAgo, updated_at_ms: ninetyFiveSecAgo })
        .where("id", "=", sessionId)
        .execute();
    } finally {
      await db.destroy();
    }

    const sweeper = app.get(PlaybackSessionSweeperService);
    await sweeper.sweepOnce();

    const after = await admin().get(`/playback/sessions/${sessionId}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe("suspended");

    const checkDb = createDb(process.env["DATABASE_URL"]!);
    let rawAfter: { suspended_by_throttle: boolean };
    try {
      rawAfter = await checkDb
        .selectFrom("playback_sessions")
        .select(["suspended_by_throttle"])
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow();
    } finally {
      await checkDb.destroy();
    }
    // false: this is a HEARTBEAT-staleness suspend, not the worker's own
    // segment-ahead throttle suspend (migrations/0012's disambiguator).
    expect(rawAfter.suspended_by_throttle).toBe(false);
  });

  it("Addendum A hot-reload: a lowered sessions.staleCutoffMs applies to the very next sweep tick, no restart", async () => {
    // A session only 2 minutes stale would NOT trip the default 15-minute
    // cutoff (proven by the very first test in this describe block, which
    // uses a 20-minute backdate specifically to clear that default) — this
    // test lowers the effective cutoff to 1 minute via a real settings
    // write (the same mechanism PUT /v1/admin/settings/{key} uses) and
    // proves sweepOnce() honors it on its very next call, no restart.
    const settingsService = app.get(SettingsService);
    const db = createDb(process.env["DATABASE_URL"]!);
    let adminId: string;
    try {
      const adminUser = await getUserByUsername(db, "admin");
      if (!adminUser) throw new Error("seed did not create an admin user");
      adminId = adminUser.id;
    } finally {
      await db.destroy();
    }

    const sessionId = await createDirectPlaySession();
    const twoMinAgo = Date.now() - 2 * 60_000;
    const backdateDb = createDb(process.env["DATABASE_URL"]!);
    try {
      await backdateDb
        .updateTable("playback_sessions")
        .set({ started_at_ms: twoMinAgo, updated_at_ms: twoMinAgo })
        .where("id", "=", sessionId)
        .execute();
    } finally {
      await backdateDb.destroy();
    }

    try {
      // Security review F9 cross-field validation (settings.service.ts's
      // updateSetting): sessions.staleCutoffMs must stay > sessions.
      // heartbeatSuspendCutoffMs. The default heartbeat cutoff (90_000) is
      // itself above the 60_000 this test wants for stale, so the
      // heartbeat cutoff is lowered to its own new floor (30_000) FIRST —
      // still a real, schema-legal value — to make the stale write valid.
      await settingsService.updateSetting({
        key: "sessions.heartbeatSuspendCutoffMs",
        value: 30_000,
        actorUserId: adminId,
        nowMs: Date.now(),
      });
      await settingsService.updateSetting({
        key: "sessions.staleCutoffMs",
        value: 60_000,
        actorUserId: adminId,
        nowMs: Date.now(),
      });

      const sweeper = app.get(PlaybackSessionSweeperService);
      await sweeper.sweepOnce();

      const after = await admin().get(`/playback/sessions/${sessionId}`);
      expect(after.status).toBe(200);
      expect(after.body.status).toBe("failed");
      expect(after.body.errorCode).toBe("heartbeat-timeout");
    } finally {
      // Restore both registry defaults so later tests in this file (and
      // any other describe block relying on the 15-minute/90-second
      // cutoffs) are unaffected — stale back up FIRST (still > the
      // still-lowered 30_000 heartbeat), then heartbeat back up (now <
      // the already-reverted stale), keeping every intermediate write
      // valid under the F9 cross-field rule.
      await settingsService.updateSetting({
        key: "sessions.staleCutoffMs",
        value: STALE_SESSION_CUTOFF_MS,
        actorUserId: adminId,
        nowMs: Date.now(),
      });
      await settingsService.updateSetting({
        key: "sessions.heartbeatSuspendCutoffMs",
        value: HEARTBEAT_SUSPEND_CUTOFF_MS,
        actorUserId: adminId,
        nowMs: Date.now(),
      });
    }
  });
});
