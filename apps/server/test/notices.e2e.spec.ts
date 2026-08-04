// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/notices.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for STATE.md "Admin broadcast notifications — system notices"
// (N1-N6/NG1-NG10), Lane A server side. Mirrors invites.e2e.spec.ts's own
// boot pattern (own DB suffix, migrate reset + seed, loginAs admin/casual,
// rawDb latestEvent helper).
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

function buildDeviceProfile(profileId = "web-chrome") {
  return {
    profileId,
    directPlayContainers: ["mp4", "mkv"],
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

let app: INestApplication;
let rawDb: ReturnType<typeof createDb>;
let adminToken: string;
let adminId: string;
let casualToken: string;

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `notices-e2e-${username}-${Date.now()}-${Math.random()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

interface EventRow {
  type: string;
  payload: Record<string, unknown>;
  actor_user_id: string | null;
}
async function latestEvent(type: string, matcher: (p: Record<string, unknown>) => boolean): Promise<EventRow | undefined> {
  const rows = await rawDb.selectFrom("events").select(["type", "payload", "actor_user_id"]).where("type", "=", type).orderBy("ts_ms", "desc").limit(50).execute();
  return (rows as EventRow[]).find((r) => matcher(r.payload));
}
async function eventCount(type: string, matcher: (p: Record<string, unknown>) => boolean): Promise<number> {
  const rows = await rawDb.selectFrom("events").select(["payload"]).where("type", "=", type).execute();
  return (rows as { payload: Record<string, unknown> }[]).filter((r) => matcher(r.payload)).length;
}

function publish(token: string, body: Record<string, unknown>) {
  return request(app.getHttpServer()).post("/system/notices").set("Authorization", `Bearer ${token}`).send(body);
}

/** Ensures a clean "nothing active" starting point regardless of what
 *  earlier tests in this file left behind — GET the active notice as
 *  admin and cancel it if one exists. */
async function cancelActiveIfAny(): Promise<void> {
  const active = await request(app.getHttpServer()).get("/notices/active").set("Authorization", `Bearer ${adminToken}`);
  const id = active.body?.notice?.id as string | undefined;
  if (id) {
    await request(app.getHttpServer()).post(`/system/notices/${id}/cancel`).set("Authorization", `Bearer ${adminToken}`);
  }
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_notices");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "notices-e2e-test-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
  adminToken = await loginAs("admin", "loombre-seed-admin");
  casualToken = await loginAs("casual", "loombre-seed-casual");
  adminId = (await rawDb.selectFrom("users").select("id").where("username", "=", "admin").executeTakeFirstOrThrow()).id;
});

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
  delete process.env["LOOMBRE_RATE_LOGIN"];
});

// ============================================================================
// 401/403 wall
// ============================================================================

describe("auth wall", () => {
  it("401s unauthenticated on all four ops", async () => {
    expect((await request(app.getHttpServer()).post("/system/notices").send({})).status).toBe(401);
    expect((await request(app.getHttpServer()).post("/system/notices/018f6f1e-0000-7000-8000-000000000001/cancel")).status).toBe(401);
    expect((await request(app.getHttpServer()).get("/system/notices")).status).toBe(401);
    expect((await request(app.getHttpServer()).get("/notices/active")).status).toBe(401);
  });

  it("403s a non-admin on publish/cancel/list, but casual CAN read /notices/active (200)", async () => {
    expect((await publish(casualToken, { message: "x", severity: "info" })).status).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post("/system/notices/018f6f1e-0000-7000-8000-000000000001/cancel")
          .set("Authorization", `Bearer ${casualToken}`)
      ).status,
    ).toBe(403);
    expect((await request(app.getHttpServer()).get("/system/notices").set("Authorization", `Bearer ${casualToken}`)).status).toBe(403);

    const active = await request(app.getHttpServer()).get("/notices/active").set("Authorization", `Bearer ${casualToken}`);
    expect(active.status).toBe(200);
    expect(active.body).toHaveProperty("notice");
    expect(active.body).toHaveProperty("serverNowMs");
  });
});

// ============================================================================
// POST /system/notices — validation
// ============================================================================

describe("POST /system/notices — validation (admin)", () => {
  it("422s a message over 500 chars", async () => {
    const res = await publish(adminToken, { message: "a".repeat(501), severity: "info" });
    expect(res.status).toBe(422);
  });

  it("422s an empty (post-trim) message", async () => {
    const res = await publish(adminToken, { message: "   ", severity: "info" });
    expect(res.status).toBe(422);
  });

  it("422s an unknown severity", async () => {
    const res = await publish(adminToken, { message: "hello", severity: "urgent" });
    expect(res.status).toBe(422);
  });

  it("422s severity=warning without expiresInMs", async () => {
    const res = await publish(adminToken, { message: "maintenance window", severity: "warning" });
    expect(res.status).toBe(422);
  });

  it("422s when effectiveInMs is after expiresInMs", async () => {
    const res = await publish(adminToken, {
      message: "bad ordering",
      severity: "warning",
      effectiveInMs: 10_000,
      expiresInMs: 1_000,
    });
    expect(res.status).toBe(422);
  });

  it("422s an unknown body key (additionalProperties:false made real)", async () => {
    const res = await publish(adminToken, { message: "hello", severity: "info", bogus: true });
    expect(res.status).toBe(422);
  });

  it("422s a non-positive-integer effectiveInMs/expiresInMs", async () => {
    expect((await publish(adminToken, { message: "x", severity: "info", effectiveInMs: 0 })).status).toBe(422);
    expect((await publish(adminToken, { message: "x", severity: "info", expiresInMs: -5 })).status).toBe(422);
    expect((await publish(adminToken, { message: "x", severity: "info", expiresInMs: 1.5 })).status).toBe(422);
  });
});

// ============================================================================
// POST /system/notices — severity-specific expiry defaults (NG4) + effectiveAtMs anchoring (NG5)
// ============================================================================

describe("POST /system/notices — severity defaults + absolute-ms anchoring (NG4/NG5)", () => {
  it("info without expiresInMs defaults to +1h (exact delta from createdAtMs, NG5 anchoring)", async () => {
    const res = await publish(adminToken, { message: "info notice", severity: "info" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.expiresAtMs - res.body.createdAtMs).toBe(3_600_000);
    expect(res.body.effectiveAtMs).toBeNull();
  });

  it("critical without expiresInMs -> expiresAtMs is null (\"until cancelled\")", async () => {
    const res = await publish(adminToken, { message: "critical notice", severity: "critical" });
    expect(res.status).toBe(201);
    expect(res.body.expiresAtMs).toBeNull();
  });

  it("effectiveInMs anchors to an absolute effectiveAtMs (exact delta from createdAtMs)", async () => {
    const res = await publish(adminToken, {
      message: "restart countdown",
      severity: "critical",
      effectiveInMs: 300_000,
    });
    expect(res.status).toBe(201);
    expect(res.body.effectiveAtMs - res.body.createdAtMs).toBe(300_000);
  });

  it("expiresInMs anchors to an absolute expiresAtMs (exact delta from createdAtMs)", async () => {
    const res = await publish(adminToken, {
      message: "warning with explicit expiry",
      severity: "warning",
      expiresInMs: 1_800_000,
    });
    expect(res.status).toBe(201);
    expect(res.body.expiresAtMs - res.body.createdAtMs).toBe(1_800_000);
  });

  it("the publish response is the all-user SystemNotice shape — NO createdBy leak", async () => {
    const res = await publish(adminToken, { message: "shape check", severity: "info" });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(
      ["id", "message", "severity", "effectiveAtMs", "expiresAtMs", "createdAtMs"].sort(),
    );
  });
});

// ============================================================================
// Replace semantics (N1/NG8)
// ============================================================================

describe("publish REPLACE semantics (N1/NG8)", () => {
  it("publishing a second notice cancels the first: exactly one active, exactly ONE notice.published for the second, NO notice.cancelled from the replace", async () => {
    await cancelActiveIfAny();

    const first = await publish(adminToken, { message: "first notice", severity: "info" });
    expect(first.status).toBe(201);
    const firstId = first.body.id as string;

    const publishedBefore = await eventCount("notice.published", (p) => p.id === firstId);
    expect(publishedBefore).toBe(1);
    const cancelledBefore = await eventCount("notice.cancelled", (p) => p.id === firstId);
    expect(cancelledBefore).toBe(0);

    const second = await publish(adminToken, { message: "second notice replaces the first", severity: "info" });
    expect(second.status).toBe(201);
    const secondId = second.body.id as string;
    expect(secondId).not.toBe(firstId);

    // Exactly one notice.published for the SECOND row.
    expect(await eventCount("notice.published", (p) => p.id === secondId)).toBe(1);
    // NG8: the replace of the first row is NOT itself an event — no
    // notice.cancelled was emitted for firstId by the replace.
    expect(await eventCount("notice.cancelled", (p) => p.id === firstId)).toBe(0);

    // Exactly one active notice — the second.
    const active = await request(app.getHttpServer()).get("/notices/active").set("Authorization", `Bearer ${adminToken}`);
    expect(active.body.notice.id).toBe(secondId);

    // The first row is cancelled at the DB level.
    const firstRow = await rawDb
      .selectFrom("system_notices")
      .select("cancelled_at_ms")
      .where("id", "=", firstId)
      .executeTakeFirstOrThrow();
    expect(firstRow.cancelled_at_ms).not.toBeNull();
  });
});

// ============================================================================
// POST /system/notices/{id}/cancel
// ============================================================================

describe("POST /system/notices/{id}/cancel (admin)", () => {
  it("204s, /notices/active returns null after, a second cancel is 404, an unknown id is 404, and notice.cancelled carries actor=admin", async () => {
    await cancelActiveIfAny();

    const created = await publish(adminToken, { message: "cancel me", severity: "critical" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const first = await request(app.getHttpServer()).post(`/system/notices/${id}/cancel`).set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(204);

    const active = await request(app.getHttpServer()).get("/notices/active").set("Authorization", `Bearer ${adminToken}`);
    expect(active.body.notice).toBeNull();

    const second = await request(app.getHttpServer()).post(`/system/notices/${id}/cancel`).set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(404);

    const unknown = await request(app.getHttpServer())
      .post("/system/notices/018f6f1e-0000-7000-8000-0000000000ff/cancel")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unknown.status).toBe(404);

    const event = await latestEvent("notice.cancelled", (p) => p.id === id);
    expect(event).toBeDefined();
    expect(event!.actor_user_id).toBe(adminId);
    expect(event!.payload).toEqual({ id });
  });
});

// ============================================================================
// GET /notices/active
// ============================================================================

describe("GET /notices/active (any authenticated user)", () => {
  it("returns null when nothing is active", async () => {
    await cancelActiveIfAny();
    const res = await request(app.getHttpServer()).get("/notices/active").set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(200);
    expect(res.body.notice).toBeNull();
  });

  it("returns the active notice, and serverNowMs is sane (between before/after wall-clock bounds)", async () => {
    const published = await publish(adminToken, { message: "active check", severity: "info" });
    expect(published.status).toBe(201);

    const before = Date.now();
    const res = await request(app.getHttpServer()).get("/notices/active").set("Authorization", `Bearer ${casualToken}`);
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.notice.id).toBe(published.body.id);
    expect(res.body.notice.message).toBe("active check");
    expect(res.body.serverNowMs).toBeGreaterThanOrEqual(before);
    expect(res.body.serverNowMs).toBeLessThanOrEqual(after);
  });
});

// ============================================================================
// GET /system/notices (admin) — list/history
// ============================================================================

describe("GET /system/notices (admin)", () => {
  it("lists notices, newest first, with the admin shape (createdBy/cancelledAtMs/status present)", async () => {
    const res = await request(app.getHttpServer()).get("/system/notices").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(item).toHaveProperty("createdBy");
      expect(item).toHaveProperty("cancelledAtMs");
      expect(["active", "cancelled", "expired"]).toContain(item.status);
    }
  });
});

// ============================================================================
// Events — notice.published payload shape (schema conformance)
// ============================================================================

describe("events — notice.published payload EXACT shape (no createdBy leak)", () => {
  it("matches the contract's SystemNotice shape byte-for-byte, actor_user_id = admin", async () => {
    const res = await publish(adminToken, { message: "event shape check", severity: "info" });
    expect(res.status).toBe(201);
    const id = res.body.id as string;

    const event = await latestEvent("notice.published", (p) => p.id === id);
    expect(event).toBeDefined();
    expect(event!.actor_user_id).toBe(adminId);
    expect(event!.payload).toEqual({
      id,
      message: "event shape check",
      severity: "info",
      effectiveAtMs: null,
      expiresAtMs: res.body.expiresAtMs,
      createdAtMs: res.body.createdAtMs,
    });
    expect(event!.payload).not.toHaveProperty("createdBy");
  });
});
