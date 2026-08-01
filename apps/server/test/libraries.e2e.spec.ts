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

// STATE.md Stash run (S9/K4): the dedicated Restricted Content surface's
// real HTTP round trip — SUPERSEDES the old GET /restricted/items coverage
// this block used to hold (K4: that endpoint is retired). Same
// entitled/locked/unlocked posture GET /restricted/count already proves,
// replayed at every new zone op, plus the byte-identical-404 proof for the
// three detail reads (scenes/{id}, performers/{id}, studios/{id}).
//
// Lock/unlock budget: POST /restricted/unlock is rate-limited 5/min/user
// (auth-rate-limiter.service.ts) — this suite proves the gate-5 (locked
// vs. unlocked) distinction ONCE, across home+browse together in a single
// lock/unlock cycle in beforeAll, then leaves the admin unlocked for every
// remaining test in this block (each of which only needs ONE unlocked
// state, not its own lock/unlock round trip) — well inside budget.
describe("Restricted Content surface (STATE.md Stash run, S9)", () => {
  async function casualToken(deviceSuffix: string): Promise<string> {
    const login = await request(app.getHttpServer()).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: `libraries-e2e-casual-${deviceSuffix}`,
      deviceProfile: buildDeviceProfile(`libraries-e2e-casual-${deviceSuffix}`),
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    return login.body.accessToken;
  }

  beforeAll(async () => {
    const casual = await casualToken("gate");
    const casualHome = await request(app.getHttpServer()).get("/restricted/home").set("Authorization", `Bearer ${casual}`);
    expect(casualHome.status).toBe(404);
    const casualBrowse = await request(app.getHttpServer())
      .get("/restricted/browse")
      .set("Authorization", `Bearer ${casual}`);
    expect(casualBrowse.status).toBe(404);

    const lock = await request(app.getHttpServer())
      .post("/restricted/lock")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(lock.status).toBe(204);

    const lockedHome = await request(app.getHttpServer()).get("/restricted/home").set("Authorization", `Bearer ${adminToken}`);
    expect(lockedHome.status, JSON.stringify(lockedHome.body)).toBe(200);
    expect(lockedHome.body).toEqual({ continueWatchingInZone: [], recentlyAddedInZone: [], studios: [], performers: [] });
    const lockedBrowse = await request(app.getHttpServer())
      .get("/restricted/browse")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(lockedBrowse.status, JSON.stringify(lockedBrowse.body)).toBe(200);
    expect(lockedBrowse.body).toEqual({ items: [], nextCursor: null });

    const unlock = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pin: "0000" });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
  });

  it("GET /restricted/home: real rails once unlocked", async () => {
    const res = await request(app.getHttpServer()).get("/restricted/home").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.recentlyAddedInZone.length).toBeGreaterThan(0);
    expect(res.body.studios.map((s: { name: string }) => s.name).sort()).toEqual(
      ["Aurora Media", "Nightshade Films"].sort(),
    );
    expect(res.body.performers.length).toBeGreaterThan(0);
  });

  it("GET /restricted/browse: real page + combinable filters once unlocked", async () => {
    const res = await request(app.getHttpServer()).get("/restricted/browse").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((it: { contentClass: string }) => it.contentClass === "restricted")).toBe(true);
    for (const item of res.body.items) {
      expect(item.itemType).toBe("movie");
      expect(Array.isArray(item.genres)).toBe(true);
      expect(Array.isArray(item.images)).toBe(true);
      expect(typeof item.quality.is4k).toBe("boolean");
      expect(typeof item.quality.hdr).toBe("string");
    }

    // Same aggregate GET /restricted/count reports for the identical
    // (unlocked) admin — proves the two surfaces stay guard-consistent.
    const countRes = await request(app.getHttpServer())
      .get("/restricted/count")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(countRes.status).toBe(200);
    expect(res.body.items.length).toBe(countRes.body.count);

    // Combinable filter: yearMin narrows without dropping to zero (seed
    // holds titles across 2019-2022 — packages/db/seed/seed.mjs).
    const filteredRes = await request(app.getHttpServer())
      .get("/restricted/browse?yearMin=2021")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(filteredRes.status).toBe(200);
    expect(filteredRes.body.items.length).toBeGreaterThan(0);
    expect(filteredRes.body.items.length).toBeLessThan(res.body.items.length);
    expect(filteredRes.body.items.every((it: { year: number }) => it.year >= 2021)).toBe(true);

    // House rule: a malformed filter id answers an EMPTY page, never a
    // silently dropped filter.
    const malformedRes = await request(app.getHttpServer())
      .get("/restricted/browse?performerIds=not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(malformedRes.status).toBe(200);
    expect(malformedRes.body).toEqual({ items: [], nextCursor: null });
  });

  it("GET /restricted/scenes/{id}: byte-identical 404 for a nonexistent id and an uncleared casual viewer; real detail once unlocked", async () => {
    const browseRes = await request(app.getHttpServer())
      .get("/restricted/browse")
      .set("Authorization", `Bearer ${adminToken}`);
    const sceneId: string = browseRes.body.items.find(
      (it: { title: string }) => it.title === "After Hours Redline",
    ).id;

    const casual = await casualToken("scene");
    const uncleared = await request(app.getHttpServer())
      .get(`/restricted/scenes/${sceneId}`)
      .set("Authorization", `Bearer ${casual}`);
    expect(uncleared.status).toBe(404);

    const nonexistent = await request(app.getHttpServer())
      .get("/restricted/scenes/00000000-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(nonexistent.status).toBe(404);
    // Byte-identical apart from `instance` (house pattern — see
    // seeded-conformance.spec.ts's own restricted-vs-nonexistent proof).
    const { instance: _unclearedInstance, ...unclearedRest } = uncleared.body;
    const { instance: _nonexistentInstance, ...nonexistentRest } = nonexistent.body;
    expect(unclearedRest).toEqual(nonexistentRest);

    const unlocked = await request(app.getHttpServer())
      .get(`/restricted/scenes/${sceneId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
    expect(unlocked.body.title).toBe("After Hours Redline");
    expect(unlocked.body.studio).toEqual({ id: expect.any(String), name: "Nightshade Films" });
    expect(unlocked.body.markers.map((m: { title: string }) => m.title)).toEqual(["Opening", "Midpoint", "Finale"]);
    expect(Array.isArray(unlocked.body.performers)).toBe(true);
  });

  it("GET /restricted/performers + /{id} + /{id}/scenes: 404 for casual, real rows once unlocked, portrait images[] present (FX2)", async () => {
    const listRes = await request(app.getHttpServer())
      .get("/restricted/performers")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    expect(listRes.body.items.length).toBeGreaterThan(0);
    expect(listRes.body.items.every((it: { images: unknown }) => Array.isArray(it.images))).toBe(true);
    const performerId: string = listRes.body.items[0].id;

    const casual = await casualToken("performers");
    const casualList = await request(app.getHttpServer())
      .get("/restricted/performers")
      .set("Authorization", `Bearer ${casual}`);
    expect(casualList.status).toBe(404);
    const casualDetail = await request(app.getHttpServer())
      .get(`/restricted/performers/${performerId}`)
      .set("Authorization", `Bearer ${casual}`);
    expect(casualDetail.status).toBe(404);

    const detailRes = await request(app.getHttpServer())
      .get(`/restricted/performers/${performerId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detailRes.status, JSON.stringify(detailRes.body)).toBe(200);
    expect(detailRes.body.sceneCount).toBeGreaterThan(0);
    expect(Array.isArray(detailRes.body.images)).toBe(true);

    const scenesRes = await request(app.getHttpServer())
      .get(`/restricted/performers/${performerId}/scenes`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(scenesRes.status, JSON.stringify(scenesRes.body)).toBe(200);
    expect(scenesRes.body.items.length).toBeGreaterThan(0);
    expect(scenesRes.body.items.every((it: { contentClass: string }) => it.contentClass === "restricted")).toBe(true);
  });

  it("GET /restricted/studios + /{id}: 404 for casual, real rows once unlocked, logo images[] present", async () => {
    const listRes = await request(app.getHttpServer())
      .get("/restricted/studios")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    expect(listRes.body.items.map((s: { name: string }) => s.name).sort()).toEqual(
      ["Aurora Media", "Nightshade Films"].sort(),
    );
    const studioId: string = listRes.body.items[0].id;

    const casual = await casualToken("studios");
    const casualList = await request(app.getHttpServer())
      .get("/restricted/studios")
      .set("Authorization", `Bearer ${casual}`);
    expect(casualList.status).toBe(404);

    const detailRes = await request(app.getHttpServer())
      .get(`/restricted/studios/${studioId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detailRes.status, JSON.stringify(detailRes.body)).toBe(200);
    expect(Array.isArray(detailRes.body.images)).toBe(true);

    // A studio's catalog is reached via browse's studioTagIds filter, not
    // a dedicated sub-route (contract's documented design).
    const catalogRes = await request(app.getHttpServer())
      .get(`/restricted/browse?studioTagIds=${studioId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(catalogRes.status).toBe(200);
    expect(catalogRes.body.items.length).toBeGreaterThan(0);
  });

  it("GET /restricted/search: entitlement (404) for casual; 422 for a missing q; real hits once unlocked, mutually exclusive from GET /search", async () => {
    const casual = await casualToken("search");
    const casualRes = await request(app.getHttpServer())
      .get("/restricted/search")
      .set("Authorization", `Bearer ${casual}`);
    expect(casualRes.status).toBe(404);

    const missingQ = await request(app.getHttpServer())
      .get("/restricted/search")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(missingQ.status).toBe(422);

    const unlockedRes = await request(app.getHttpServer())
      .get("/restricted/search")
      .query({ q: "After" })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlockedRes.status, JSON.stringify(unlockedRes.body)).toBe(200);
    expect(unlockedRes.body.items.map((it: { title: string }) => it.title)).toEqual(["After Hours Redline"]);

    // Zone search never surfaces a general title, general search never
    // surfaces a zone title — the two indexes stay mutually exclusive.
    const zoneForGeneral = await request(app.getHttpServer())
      .get("/restricted/search")
      .query({ q: "Harbor" })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(zoneForGeneral.status).toBe(200);
    expect(zoneForGeneral.body.items).toEqual([]);
  });

  // STATE.md Stash run (S7/K9, Lane E): GET /items/{id}/chapters HTTP twin
  // of packages/db/test/leak.spec.ts's 12g cases — proves the SAME
  // visibility-rides-the-owning-item posture end to end through the real
  // route (requireUuidParam + notFound()), not just the guarded query.
  // Reuses this describe block's already-unlocked admin state (beforeAll
  // above) rather than its own lock/unlock cycle.
  it("GET /items/{id}/chapters: general item's marker visible to every viewer; restricted item's markers byte-identical-404 to an uncleared viewer, real once unlocked", async () => {
    const moviesRes = await request(app.getHttpServer()).get("/movies").set("Authorization", `Bearer ${adminToken}`);
    const harborLightsRow = moviesRes.body.items.find((it: { title: string }) => it.title === "Harbor Lights");
    const harborLightsId: string = harborLightsRow.id;

    const casual = await casualToken("chapters-general");
    const generalUncleared = await request(app.getHttpServer())
      .get(`/items/${harborLightsId}/chapters`)
      .set("Authorization", `Bearer ${casual}`);
    expect(generalUncleared.status, JSON.stringify(generalUncleared.body)).toBe(200);
    expect(generalUncleared.body).toEqual({ items: [{ title: "Cold Open", startMs: 0, source: "stash" }] });

    const zoneBrowseRes = await request(app.getHttpServer())
      .get("/restricted/browse")
      .set("Authorization", `Bearer ${adminToken}`);
    const sceneId: string = zoneBrowseRes.body.items.find(
      (it: { title: string }) => it.title === "After Hours Redline",
    ).id;

    const restrictedCasual = await casualToken("chapters-restricted");
    const uncleared = await request(app.getHttpServer())
      .get(`/items/${sceneId}/chapters`)
      .set("Authorization", `Bearer ${restrictedCasual}`);
    expect(uncleared.status).toBe(404);

    const nonexistent = await request(app.getHttpServer())
      .get("/items/00000000-0000-7000-8000-000000000000/chapters")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(nonexistent.status).toBe(404);
    // Byte-identical apart from `instance` (house pattern — see the
    // GET /restricted/scenes/{id} case above).
    const { instance: _unclearedInstance, ...unclearedRest } = uncleared.body;
    const { instance: _nonexistentInstance, ...nonexistentRest } = nonexistent.body;
    expect(unclearedRest).toEqual(nonexistentRest);

    const unlocked = await request(app.getHttpServer())
      .get(`/items/${sceneId}/chapters`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
    expect(unlocked.body.items.map((c: { title: string }) => c.title)).toEqual(["Opening", "Midpoint", "Finale"]);
    expect(unlocked.body.items[0]).toEqual({ title: "Opening", startMs: 0, source: "stash" });
  });
});
