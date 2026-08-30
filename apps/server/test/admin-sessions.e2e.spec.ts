// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/admin-sessions.e2e.spec.ts
//
// HTTP-level test for GET /admin/sessions (STATE.md P2.8/deliverable E,
// websocket-presence lane). The query-layer redaction math is already
// proven directly against packages/db/src/query/admin.ts in
// packages/db/test/admin-sessions.spec.ts; this file proves the WIRE-UP:
// requireAdmin (403 for a non-admin token), and the exact JSON shape —
// including that a restricted session's itemTitle is null + contentHidden
// true when the requesting admin isn't currently gate-5 unlocked, and
// becomes visible once they are — using the SAME seed-admin account both
// times (only their live unlock state changes), through the real HTTP
// surface (POST /restricted/unlock, GET /admin/sessions).
//
// Session rows are seeded directly via @loombre/db's createPlaybackSession
// (same technique apps/server/test/ws-broadcaster.e2e.spec.ts uses for
// event rows) rather than a real POST /playback/sessions round-trip —
// that endpoint additionally requires a browser-compatible DeviceProfile
// to pass checkStaticCompat, which is orthogonal to what this file is
// proving (the admin redaction contract, not direct-play compatibility).
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed).

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, createPlaybackSession, ensureTestDatabase, type ViewerContext } from "@loombre/db";
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

function buildDeviceProfile(profileId: string) {
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
let databaseUrl: string;

beforeAll(async () => {
  process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
  process.env["LOOMBRE_JWT_SECRET"] = "admin-sessions-test-secret-not-for-production";

  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_sessions_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
}, 30_000);

afterAll(async () => {
  await app.close();
});

describe("GET /admin/sessions (STATE.md P2.8/deliverable E)", () => {
  it("403s for a non-admin (casual) token", async () => {
    const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "admin-sessions-test-casual",
      deviceProfile: buildDeviceProfile("admin-sessions-test-casual"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);

    const res = await request(app.getHttpServer())
      .get("/admin/sessions")
      .set("Authorization", `Bearer ${casualLogin.body.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("redacts a restricted session's item to the SAME admin before unlock, and reveals it after", async () => {
    const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "admin-sessions-test-admin",
      deviceProfile: buildDeviceProfile("admin-sessions-test-admin"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;
    const adminDeviceId: string = adminLogin.body.deviceId;
    const adminUserId: string = JSON.parse(
      Buffer.from(adminToken.split(".")[1]!, "base64url").toString("utf8"),
    ).sub;

    // Seed a playback session directly against the restricted item, using
    // a FULLY-CLEARED ViewerContext (this is just DB setup — establishing
    // the fixture, not testing the guard) so the session row is guaranteed
    // to exist regardless of the HTTP-level unlock state we test below.
    const db = createDb(databaseUrl);
    let restrictedSessionId: string;
    try {
      const restrictedItem = await db
        .selectFrom("catalog_items")
        .select("id")
        .where("title", "=", "After Hours Redline")
        .executeTakeFirstOrThrow();
      const restrictedFile = await db
        .selectFrom("media_files")
        .select("id")
        .where("item_id", "=", restrictedItem.id)
        .executeTakeFirstOrThrow();
      const allLibraryIds = (await db.selectFrom("libraries").select("id").execute()).map((r) => r.id);

      const seedingCtx: ViewerContext = { userId: adminUserId, allowedLibraryIds: allLibraryIds, restrictedCleared: true, surface: "restricted" };
      const session = await createPlaybackSession(db, seedingCtx, {
        itemId: restrictedItem.id,
        fileId: restrictedFile.id,
        deviceId: adminDeviceId,
        // A distinctive plan+detail: proves BOTH that plan is delivered
        // wire-side (deliverable D's "why is this transcoding" panel reads
        // this) AND that it is redacted (not merely a look-alike default)
        // when contentHidden — the leak-check below greps for this exact
        // detail string, not just the item title.
        plan: {
          decision: "transcode",
          reasons: [{ code: "video-codec-unsupported", detail: "After Hours Redline requires HEVC transcode" }],
        },
        engineVersion: "phase3-engine-1.0.0",
        nowMs: Date.now(),
      });
      expect(session).toBeDefined();
      restrictedSessionId = session!.id;
    } finally {
      await db.destroy();
    }

    // --- Direction 1: admin has NOT unlocked yet -> redacted ---
    const beforeUnlock = await request(app.getHttpServer())
      .get("/admin/sessions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(beforeUnlock.status, JSON.stringify(beforeUnlock.body)).toBe(200);
    const rowBefore = beforeUnlock.body.items.find((r: { id: string }) => r.id === restrictedSessionId);
    expect(rowBefore, JSON.stringify(beforeUnlock.body.items)).toBeDefined();
    expect(rowBefore.itemTitle).toBeNull();
    expect(rowBefore.contentHidden).toBe(true);
    expect(rowBefore.username).toBe("admin");
    // plan/engineVersion are REDACTED (present as null), not omitted —
    // same "redaction-not-omission" law as itemTitle, tested at the wire.
    expect(rowBefore.plan).toBeNull();
    expect("plan" in rowBefore).toBe(true);
    expect(rowBefore.engineVersion).toBeNull();
    expect(JSON.stringify(rowBefore)).not.toContain("After Hours Redline");

    // --- Direction 2: same admin, now unlocked -> visible ---
    const unlock = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pin: "0000" });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);

    const afterUnlock = await request(app.getHttpServer())
      .get("/admin/sessions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(afterUnlock.status).toBe(200);
    const rowAfter = afterUnlock.body.items.find((r: { id: string }) => r.id === restrictedSessionId);
    expect(rowAfter).toBeDefined();
    expect(rowAfter.itemTitle).toBe("After Hours Redline");
    expect(rowAfter.contentHidden).toBe(false);
    expect(rowAfter.itemId).toBe(rowBefore.itemId);
    // Deliverable D "why is this transcoding" panel input: the reasons
    // view's data is present once this admin is cleared to see it.
    expect(rowAfter.plan).toEqual({
      decision: "transcode",
      reasons: [{ code: "video-codec-unsupported", detail: "After Hours Redline requires HEVC transcode" }],
    });
    expect(rowAfter.engineVersion).toBe("phase3-engine-1.0.0");
  });

  // browser-admin-F2 (QA 2026-08-20/21, P1): the QA repro was literally
  // `curl /admin/sessions` returning 0 items while a 4K stream played,
  // because the segment-ahead throttle had parked the transcode at
  // status='suspended' and the query filtered it out. The query-layer
  // proof lives in packages/db/test/admin-sessions.spec.ts; this is the
  // wire-level half — the row reaches the client, carrying the status the
  // pill renders.
  it("lists a throttle-suspended session, with status suspended on the wire (browser-admin-F2)", async () => {
    const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "admin-sessions-test-suspended",
      deviceProfile: buildDeviceProfile("admin-sessions-test-suspended"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;
    const adminDeviceId: string = adminLogin.body.deviceId;
    const adminUserId: string = JSON.parse(
      Buffer.from(adminToken.split(".")[1]!, "base64url").toString("utf8"),
    ).sub;

    const db = createDb(databaseUrl);
    let suspendedSessionId: string;
    try {
      const item = await db
        .selectFrom("catalog_items")
        .select("id")
        .where("title", "=", "Harbor Lights")
        .executeTakeFirstOrThrow();
      const file = await db.selectFrom("media_files").select("id").where("item_id", "=", item.id).executeTakeFirstOrThrow();
      const allLibraryIds = (await db.selectFrom("libraries").select("id").execute()).map((r) => r.id);
      const seedingCtx: ViewerContext = { userId: adminUserId, allowedLibraryIds: allLibraryIds, restrictedCleared: true, surface: "restricted" };

      const session = await createPlaybackSession(db, seedingCtx, {
        itemId: item.id,
        fileId: file.id,
        deviceId: adminDeviceId,
        plan: { decision: "transcode", reasons: [] },
        engineVersion: "phase3-engine-1.0.0",
        nowMs: Date.now(),
      });
      expect(session).toBeDefined();
      suspendedSessionId = session!.id;

      // What apps/worker/src/transcode/throttle.ts's SIGSTOP branch writes
      // (packages/db/src/internal/transcode-sessions.ts setThrottleSuspended).
      await db
        .updateTable("playback_sessions")
        .set({ status: "suspended", suspended_by_throttle: true, updated_at_ms: Date.now() })
        .where("id", "=", suspendedSessionId)
        .execute();
    } finally {
      await db.destroy();
    }

    const res = await request(app.getHttpServer()).get("/admin/sessions").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.items.find((r: { id: string }) => r.id === suspendedSessionId);
    expect(row, JSON.stringify(res.body.items)).toBeDefined();
    expect(row.status).toBe("suspended");
    expect(row.itemTitle).toBe("Harbor Lights");
  });

  // d3-e3 (browser-admin-F2 follow-up, P2): the wire half of "an abandoned
  // session must not look like a healthy one". Two rows, both `suspended`,
  // both non-terminal, and — before this — byte-identical on the wire apart
  // from their ids: one is the worker's segment-ahead throttle parking a
  // stream someone IS watching, the other is the sweeper's 90s heartbeat
  // suspend on a viewer who walked away 10 minutes ago and whom nothing
  // will end for another 5.
  it("distinguishes a throttle-parked session from an abandoned one on the wire (suspendedByThrottle + heartbeatStale)", async () => {
    const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "admin-sessions-test-presence",
      deviceProfile: buildDeviceProfile("admin-sessions-test-presence"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;
    const adminDeviceId: string = adminLogin.body.deviceId;
    const adminUserId: string = JSON.parse(
      Buffer.from(adminToken.split(".")[1]!, "base64url").toString("utf8"),
    ).sub;

    const db = createDb(databaseUrl);
    let watchedSessionId: string;
    let abandonedSessionId: string;
    try {
      const item = await db
        .selectFrom("catalog_items")
        .select("id")
        .where("title", "=", "Harbor Lights")
        .executeTakeFirstOrThrow();
      const file = await db.selectFrom("media_files").select("id").where("item_id", "=", item.id).executeTakeFirstOrThrow();
      const allLibraryIds = (await db.selectFrom("libraries").select("id").execute()).map((r) => r.id);
      const seedingCtx: ViewerContext = { userId: adminUserId, allowedLibraryIds: allLibraryIds, restrictedCleared: true, surface: "restricted" };
      const nowMs = Date.now();

      const watched = await createPlaybackSession(db, seedingCtx, {
        itemId: item.id,
        fileId: file.id,
        deviceId: adminDeviceId,
        plan: { decision: "transcode", reasons: [] },
        engineVersion: "phase3-engine-1.0.0",
        nowMs,
      });
      const abandoned = await createPlaybackSession(db, seedingCtx, {
        itemId: item.id,
        fileId: file.id,
        deviceId: adminDeviceId,
        plan: { decision: "direct-play", reasons: [] },
        engineVersion: "phase3-engine-1.0.0",
        nowMs: nowMs - 600_000,
      });
      expect(watched).toBeDefined();
      expect(abandoned).toBeDefined();
      watchedSessionId = watched!.id;
      abandonedSessionId = abandoned!.id;

      // Worker's SIGSTOP branch (setThrottleSuspended) — heartbeat is
      // current, someone is watching.
      await db
        .updateTable("playback_sessions")
        .set({ status: "suspended", suspended_by_throttle: true, last_heartbeat_ms: nowMs, updated_at_ms: nowMs })
        .where("id", "=", watchedSessionId)
        .execute();
      // Sweeper's heartbeat-stale branch (suspendStalePlaybackSession) —
      // nothing has been heard from this one in 10 minutes.
      await db
        .updateTable("playback_sessions")
        .set({
          status: "suspended",
          suspended_by_throttle: false,
          last_heartbeat_ms: nowMs - 600_000,
          updated_at_ms: nowMs - 600_000,
        })
        .where("id", "=", abandonedSessionId)
        .execute();
    } finally {
      await db.destroy();
    }

    const res = await request(app.getHttpServer()).get("/admin/sessions").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const watchedRow = res.body.items.find((r: { id: string }) => r.id === watchedSessionId);
    const abandonedRow = res.body.items.find((r: { id: string }) => r.id === abandonedSessionId);
    expect(watchedRow, JSON.stringify(res.body.items)).toBeDefined();
    expect(abandonedRow, JSON.stringify(res.body.items)).toBeDefined();

    expect(watchedRow.status).toBe("suspended");
    expect(watchedRow.suspendedByThrottle).toBe(true);
    expect(watchedRow.heartbeatStale).toBe(false);

    expect(abandonedRow.status).toBe("suspended");
    expect(abandonedRow.suspendedByThrottle).toBe(false);
    expect(abandonedRow.heartbeatStale).toBe(true);
  });
});
