// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/playback-seek.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// for POST /playback/sessions/{id}/seek — the V8 seek control channel
// (docs/PLAYBACK.md §9 "The seek control channel is the contract call";
// STATE.md "Seek model V8"). The endpoint is a thin, contract-visible
// alias of the segment-GET side effect: same `seek_target_ms` column, same
// §9.1.7 single-statement coincident-pair write. These tests assert the
// CONTRACT half — clamping, absorption-by-last-write, the 404/409/422
// walls, and the verbatim column write. The WORKER half (the restart the
// column triggers, the transcode_runs origin row) is pinned by
// apps/worker/test/transcode/seek-rung-switch.integration.spec.ts against
// a real ffmpeg.
//
// Follows playback.e2e.spec.ts's structure verbatim: isolated derived test
// database, migrate reset + seed, seeded admin/casual logins, Harbor
// Lights (hevc/eac3/mkv) as the transcode-forcing item.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// Forces a real VIDEO transcode against the seeded hevc/eac3 Harbor Lights
// mkv — h264-only, so codec alone fails direct-play (same rationale as
// playback.e2e.spec.ts's incompatibleDeviceProfile).
function transcodeForcingProfile() {
  return {
    profileId: "seek-e2e-h264-only",
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
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

// Direct-play capable against the same file (mkv+hevc+eac3) — the 409
// not-a-transcode-session wall.
function directPlayProfile() {
  return {
    profileId: "seek-e2e-capable",
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

const NETWORK = { maxBitrateBps: 50_000_000, isLocal: true };
// Seeded Harbor Lights duration (packages/db/seed/seed.mjs) — the clamp
// ceiling the past-EOF case asserts against.
const HARBOR_LIGHTS_DURATION_MS = 6_480_000;

let app: INestApplication;
let adminToken: string;
let casualToken: string;
let harborLightsItemId: string;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "playback-seek-e2e-test-secret-not-for-production";
  process.env["LOOMBRE_MAX_TRANSCODES"] = "64";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "playback_seek_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "seek-e2e-admin",
    deviceProfile: loginDeviceProfile("seek-e2e-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "seek-e2e-casual",
    deviceProfile: loginDeviceProfile("seek-e2e-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;

  db = createDb(databaseUrl);
  const item = await db
    .selectFrom("catalog_items")
    .select(["id"])
    .where("title", "=", "Harbor Lights")
    .executeTakeFirstOrThrow();
  harborLightsItemId = item.id;
  const file = await db.selectFrom("media_files").select("id").where("item_id", "=", item.id).executeTakeFirstOrThrow();

  // Real bytes on disk so nothing downstream trips on a missing path (same
  // trick as playback.e2e.spec.ts — the seed's path is fictional).
  const tmpDir = mkdtempSync(path.join(tmpdir(), "loombre-seek-e2e-"));
  const realFilePath = path.join(tmpDir, "harbor-lights.mkv");
  const bytes = Buffer.alloc(10_000);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
  writeFileSync(realFilePath, bytes);
  statSync(realFilePath);
  await db.updateTable("media_files").set({ path: realFilePath, content_hash: "seek-e2e-hash" }).where("id", "=", file.id).execute();
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await app?.close();
});

function authed() {
  return {
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set("Authorization", `Bearer ${adminToken}`),
  };
}

async function createTranscodeSession(): Promise<{ id: string; ladderLength: number; activeRungIndex: number | null }> {
  const res = await authed()
    .post("/playback/sessions")
    .send({ itemId: harborLightsItemId, mode: "stream", network: NETWORK, device: transcodeForcingProfile() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.plan.decision).toBe("transcode");
  const row = await db
    .selectFrom("playback_sessions")
    .select(["active_rung_index"])
    .where("id", "=", res.body.id)
    .executeTakeFirstOrThrow();
  return { id: res.body.id, ladderLength: res.body.plan.ladder.length, activeRungIndex: row.active_rung_index };
}

async function seekTargetOf(sessionId: string): Promise<{ seek_target_ms: number | null; pending_rung_index: number | null }> {
  return db
    .selectFrom("playback_sessions")
    .select(["seek_target_ms", "pending_rung_index"])
    .where("id", "=", sessionId)
    .executeTakeFirstOrThrow();
}

describe("POST /playback/sessions/{id}/seek — the V8 seek control channel", () => {
  it("202: records the target VERBATIM after clamping and echoes the clamped value", async () => {
    const session = await createTranscodeSession();
    const res = await authed().post(`/playback/sessions/${session.id}/seek`).send({ targetMs: 100_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toEqual({ targetMs: 100_000 });
    const row = await seekTargetOf(session.id);
    expect(row.seek_target_ms).toBe(100_000);
    await authed().delete(`/playback/sessions/${session.id}`);
  });

  it("202: a past-EOF target clamps to a PLAYABLE position — one nominal segment before the probed duration, never durationMs verbatim", async () => {
    // browser-player-F4 (QA 2026-08-20/21, P1): the old ceiling was
    // durationMs itself, and an accepted targetMs == durationMs became an
    // ffmpeg -ss at EOF — a restart whose run has (essentially) nothing
    // displayable, which the client then wedged on forever after landing.
    // The ceiling now backs off one nominal §9.1.5 segment (6 s) so the
    // seek-spawned run always carries real final frames to land on.
    const session = await createTranscodeSession();
    const res = await authed().post(`/playback/sessions/${session.id}/seek`).send({ targetMs: 99_999_999_999 });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.targetMs).toBe(HARBOR_LIGHTS_DURATION_MS - 6_000);
    const row = await seekTargetOf(session.id);
    expect(row.seek_target_ms).toBe(HARBOR_LIGHTS_DURATION_MS - 6_000);
    await authed().delete(`/playback/sessions/${session.id}`);
  });

  it("202: targetMs == durationMs (the scrubber dragged to the very end) clamps to the same playable ceiling", async () => {
    const session = await createTranscodeSession();
    const res = await authed().post(`/playback/sessions/${session.id}/seek`).send({ targetMs: HARBOR_LIGHTS_DURATION_MS });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(
      res.body.targetMs,
      "an at-EOF target was recorded verbatim — the restart produces nothing displayable and the client wedges (browser-player-F4)",
    ).toBe(HARBOR_LIGHTS_DURATION_MS - 6_000);
    const row = await seekTargetOf(session.id);
    expect(row.seek_target_ms).toBe(HARBOR_LIGHTS_DURATION_MS - 6_000);
    await authed().delete(`/playback/sessions/${session.id}`);
  });

  it("202: a target already at/below the playable ceiling is untouched by the EOF back-off", async () => {
    const session = await createTranscodeSession();
    const atCeiling = HARBOR_LIGHTS_DURATION_MS - 6_000;
    const res = await authed().post(`/playback/sessions/${session.id}/seek`).send({ targetMs: atCeiling });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.targetMs).toBe(atCeiling);
    await authed().delete(`/playback/sessions/${session.id}`);
  });

  it("absorption is last-write-wins: two posts leave exactly the second target on the column", async () => {
    const session = await createTranscodeSession();
    await authed().post(`/playback/sessions/${session.id}/seek`).send({ targetMs: 60_000 });
    const second = await authed().post(`/playback/sessions/${session.id}/seek`).send({ targetMs: 90_000 });
    expect(second.status).toBe(202);
    const row = await seekTargetOf(session.id);
    expect(row.seek_target_ms).toBe(90_000);
    await authed().delete(`/playback/sessions/${session.id}`);
  });

  it("coincident rungIndex rides the SAME statement (§9.1.7): both columns land; naming the active rung absorbs the switch half only", async () => {
    const session = await createTranscodeSession();
    expect(session.ladderLength).toBeGreaterThanOrEqual(2);

    // A rung OTHER than the active one -> both halves land.
    const other = session.activeRungIndex === 1 ? 2 % session.ladderLength : 1;
    const res = await authed().post(`/playback/sessions/${session.id}/seek`).send({ targetMs: 45_000, rungIndex: other });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    let row = await seekTargetOf(session.id);
    expect(row.seek_target_ms).toBe(45_000);
    expect(row.pending_rung_index).toBe(other);

    // Naming the ACTIVE rung: the seek half must still land (never
    // absorbed with it — the CASE lives on the rung column only).
    if (session.activeRungIndex !== null) {
      const res2 = await authed()
        .post(`/playback/sessions/${session.id}/seek`)
        .send({ targetMs: 50_000, rungIndex: session.activeRungIndex });
      expect(res2.status).toBe(202);
      row = await seekTargetOf(session.id);
      expect(row.seek_target_ms).toBe(50_000);
      // Unchanged from the earlier write — an absorbed rung half is a
      // no-op on the column, never a clear.
      expect(row.pending_rung_index).toBe(other);
    }
    await authed().delete(`/playback/sessions/${session.id}`);
  });

  it("404: another user's session (existence never leaked), unknown id, and a terminal session", async () => {
    const session = await createTranscodeSession();

    const foreign = await request(app.getHttpServer())
      .post(`/playback/sessions/${session.id}/seek`)
      .set("Authorization", `Bearer ${casualToken}`)
      .send({ targetMs: 1_000 });
    expect(foreign.status).toBe(404);

    const unknown = await authed().post(`/playback/sessions/019702e9-0000-7000-8000-000000000000/seek`).send({ targetMs: 1_000 });
    expect(unknown.status).toBe(404);

    await authed().delete(`/playback/sessions/${session.id}`);
    const ended = await authed().post(`/playback/sessions/${session.id}/seek`).send({ targetMs: 1_000 });
    expect(ended.status).toBe(404);
  });

  it("409 not-a-transcode-session: a direct-play session has no pipeline to restart", async () => {
    const res = await authed()
      .post("/playback/sessions")
      .send({ itemId: harborLightsItemId, mode: "stream", network: NETWORK, device: directPlayProfile() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.plan.decision).toBe("direct-play");

    const seek = await authed().post(`/playback/sessions/${res.body.id}/seek`).send({ targetMs: 1_000 });
    expect(seek.status).toBe(409);
    expect(seek.body.code).toBe("not-a-transcode-session");
    await authed().delete(`/playback/sessions/${res.body.id}`);
  });

  it("422: schema violations — missing/negative/non-integer targetMs, unknown keys, out-of-ladder rungIndex", async () => {
    const session = await createTranscodeSession();
    // `object[]`, not `unknown[]`: every case IS an object (that is the
    // point — deliberately malformed FIELDS, not malformed JSON), and
    // supertest's .send() only accepts string | object | undefined.
    const cases: object[] = [
      {},
      { targetMs: -1 },
      { targetMs: 1.5 },
      { targetMs: "1000" },
      { targetMs: 1_000, extra: true },
      { targetMs: 1_000, rungIndex: -1 },
      { targetMs: 1_000, rungIndex: session.ladderLength },
      { targetMs: 1_000, rungIndex: 0.5 },
    ];
    for (const body of cases) {
      const res = await authed().post(`/playback/sessions/${session.id}/seek`).send(body);
      expect(res.status, `expected 422 for ${JSON.stringify(body)}, got ${res.status}`).toBe(422);
    }
    // None of those wrote anything.
    const row = await seekTargetOf(session.id);
    expect(row.seek_target_ms).toBeNull();
    await authed().delete(`/playback/sessions/${session.id}`);
  });
});
