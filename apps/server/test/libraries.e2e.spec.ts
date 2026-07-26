// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/libraries.e2e.spec.ts
//
// HTTP-level regression test for the gap-closure lane finding: POST
// /libraries granted no permission to its creator, so a freshly created
// library was invisible via GET /libraries (and GET /libraries/{id}) to
// EVERYONE including the creating admin until a separate PUT
// /libraries/{id}/permissions call ran. The query-layer fix + both-ways
// unit coverage lives in packages/db/test/catalog-detail.spec.ts
// ("createLibrary" describe block); this file proves the real HTTP round
// trip through the admin JWT + guarded read path end to end, and the §6.4
// gate-4 call: general libraries auto-grant the creator, restricted
// libraries still require the explicit PUT (default-deny holds even for
// the creating admin).
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed), same
// convention as admin-sessions.e2e.spec.ts.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
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
let adminToken: string;

beforeAll(async () => {
  process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
  process.env["LOOMBRE_JWT_SECRET"] = "libraries-e2e-test-secret-not-for-production";

  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "libraries_e2e_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "libraries-e2e-admin",
    deviceProfile: buildDeviceProfile("libraries-e2e-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app.close();
});

describe("POST /libraries creator visibility (gap-closure regression)", () => {
  it("a freshly created GENERAL library is immediately visible to its creator via GET /libraries and GET /libraries/{id}, with no PUT permissions call", async () => {
    const create = await request(app.getHttpServer())
      .post("/libraries")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Gap Closure General", mediaKind: "movie", paths: ["/data/gap-closure-general"] });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const libraryId: string = create.body.id;
    // Wave 1c (Phosphor retheme, "contract enablers" lane): itemCount is
    // additive on Library and always sent — a freshly created library has
    // no items yet.
    expect(create.body.itemCount).toBe(0);

    const getOne = await request(app.getHttpServer())
      .get(`/libraries/${libraryId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getOne.status, JSON.stringify(getOne.body)).toBe(200);
    expect(getOne.body.id).toBe(libraryId);
    expect(getOne.body.itemCount).toBe(0);

    const list = await request(app.getHttpServer())
      .get("/libraries?limit=200")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((l: { id: string }) => l.id === libraryId)).toBe(true);
    const listedEntry = list.body.items.find((l: { id: string }) => l.id === libraryId);
    expect(listedEntry.itemCount).toBe(0);
    // Every OTHER (pre-seeded, non-empty) general library in the same page
    // carries a real itemCount too — proves this isn't just "always 0".
    expect(
      list.body.items.some((l: { itemCount: number; contentClass: string }) => l.contentClass === "general" && l.itemCount > 0),
    ).toBe(true);

    const permissions = await request(app.getHttpServer())
      .get(`/libraries/${libraryId}/permissions`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(permissions.status).toBe(200);
    expect(permissions.body.permissions).toEqual(
      expect.arrayContaining([expect.objectContaining({ granted: true })])
    );
  });

  it("a freshly created RESTRICTED library stays invisible to its creator (gate 4 default-deny) until the explicit PUT permissions grant", async () => {
    const create = await request(app.getHttpServer())
      .post("/libraries")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Gap Closure Restricted", mediaKind: "movie", paths: ["/data/gap-closure-restricted"], contentClass: "restricted" });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const libraryId: string = create.body.id;

    // Unlock gate 5 for the admin so ONLY gate 4 (the permission grant) is
    // the variable under test.
    const unlock = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pin: "0000" });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);

    const getOneBefore = await request(app.getHttpServer())
      .get(`/libraries/${libraryId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getOneBefore.status).toBe(404); // invisible: no library_permissions grant yet

    const permissionsBefore = await request(app.getHttpServer())
      .get(`/libraries/${libraryId}/permissions`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(permissionsBefore.status).toBe(200);
    expect(permissionsBefore.body.permissions).toEqual([]);

    const adminUserId: string = JSON.parse(
      Buffer.from(adminToken.split(".")[1]!, "base64url").toString("utf8")
    ).sub;

    const grant = await request(app.getHttpServer())
      .put(`/libraries/${libraryId}/permissions`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ permissions: [{ userId: adminUserId, granted: true }] });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);

    const getOneAfter = await request(app.getHttpServer())
      .get(`/libraries/${libraryId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getOneAfter.status).toBe(200);
    expect(getOneAfter.body.id).toBe(libraryId);
  });
});

// Wave 1c (STATE.md Phosphor retheme, "contract enablers" lane): storage-
// pool meter + restricted zone aggregate count, real HTTP round trip.
// LOOMBRE_RESTRICTED_ENABLED=true is already set in this file's beforeAll,
// and the seed admin holds gates 1-4 (adult birth_date, opt-in+PIN,
// explicit library_permissions grant on the seeded "Restricted" library —
// packages/db/seed/seed.mjs) — this is the entitled-viewer counterpart to
// conformance.spec.ts's not-entitled-on-that-suite's-DB 404 case.
describe("GET /system/info storagePool + GET /restricted/count (Wave 1c)", () => {
  it("GET /system/info always sends storagePool (additive) — null on this host since seed library paths (/data/...) don't exist", async () => {
    const res = await request(app.getHttpServer())
      .get("/system/info")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("storagePool");
    expect(res.body.storagePool).toBeNull();
  });

  it("GET /restricted/count: the entitled seed admin gets the real zone count REGARDLESS of lock state", async () => {
    // Force locked (gate 5 false) first — an earlier test in this file
    // unlocks the admin, so don't rely on ambient state either way.
    const lock = await request(app.getHttpServer())
      .post("/restricted/lock")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(lock.status).toBe(204);

    const lockedCount = await request(app.getHttpServer())
      .get("/restricted/count")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(lockedCount.status, JSON.stringify(lockedCount.body)).toBe(200);
    expect(lockedCount.body.count).toBeGreaterThan(0);

    const unlock = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pin: "0000" });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);

    const unlockedCount = await request(app.getHttpServer())
      .get("/restricted/count")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlockedCount.status).toBe(200);
    // Identical to the locked read — lock state changes nothing here.
    expect(unlockedCount.body.count).toBe(lockedCount.body.count);
    expect(Object.keys(unlockedCount.body)).toEqual(["count"]);
  });

  it("GET /restricted/count: 404 for a viewer with no restricted-library entitlement at all (seed 'casual' user)", async () => {
    const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "libraries-e2e-casual",
      deviceProfile: buildDeviceProfile("libraries-e2e-casual"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
    const casualToken: string = casualLogin.body.accessToken;

    const res = await request(app.getHttpServer())
      .get("/restricted/count")
      .set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(404);
  });
});

// Wave 2 (STATE.md Phosphor retheme, lane L8): the zone's own item listing,
// GET /restricted/items — real HTTP round trip alongside GET /restricted/
// count's own coverage above. UNLIKE count, this IS lock-sensitive (see
// packages/db/src/query/restricted-zone.ts's "Restricted zone item
// listing" section header).
describe("GET /restricted/items (Wave 2, lane L8)", () => {
  it("404 for a viewer with no restricted-library entitlement at all (seed 'casual' user) — same posture as GET /restricted/count", async () => {
    const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "libraries-e2e-casual-items",
      deviceProfile: buildDeviceProfile("libraries-e2e-casual-items"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
    const casualToken: string = casualLogin.body.accessToken;

    const res = await request(app.getHttpServer())
      .get("/restricted/items")
      .set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(404);
  });

  it("entitled admin: 200 with an EMPTY page while locked, real titles/artwork once unlocked", async () => {
    const lock = await request(app.getHttpServer())
      .post("/restricted/lock")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(lock.status).toBe(204);

    const lockedItems = await request(app.getHttpServer())
      .get("/restricted/items")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(lockedItems.status, JSON.stringify(lockedItems.body)).toBe(200);
    expect(lockedItems.body.items).toEqual([]);
    expect(lockedItems.body.nextCursor).toBeNull();

    const unlock = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pin: "0000" });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);

    const unlockedItems = await request(app.getHttpServer())
      .get("/restricted/items")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlockedItems.status, JSON.stringify(unlockedItems.body)).toBe(200);
    expect(Array.isArray(unlockedItems.body.items)).toBe(true);
    expect(unlockedItems.body.items.length).toBeGreaterThan(0);
    expect(unlockedItems.body.items.every((it: { contentClass: string }) => it.contentClass === "restricted")).toBe(
      true,
    );
    // Same aggregate the count surface reports for the identical (now
    // unlocked) admin — one page is enough at seed scale (contract default
    // limit 50, seed's restricted library holds 4 items).
    const countRes = await request(app.getHttpServer())
      .get("/restricted/count")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(countRes.status).toBe(200);
    expect(unlockedItems.body.items.length).toBe(countRes.body.count);
    expect(unlockedItems.body.nextCursor).toBeNull();

    // Every item carries the additive genres/images/quality fields the
    // contract's RestrictedZoneItem schema requires — proves the mapping
    // from packages/db's row shape reached the wire intact.
    for (const item of unlockedItems.body.items) {
      expect(Array.isArray(item.genres)).toBe(true);
      expect(Array.isArray(item.images)).toBe(true);
      expect(item.quality).toEqual(expect.objectContaining({ is4k: expect.any(Boolean), hdr: expect.any(String) }));
    }
  });
});
