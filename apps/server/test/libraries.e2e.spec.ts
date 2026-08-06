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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
// V1-004 (audit fafa47f, Fix Wave 4 lane FW4-B): openapi.yaml declares 204
// for DELETE /libraries/{id} ("Deleted"); the handler had no @HttpCode and
// fell through to Nest's default 200. Only a 404-against-a-nonexistent-id
// case existed before this (security-hardening.e2e.spec.ts /
// conformance.spec.ts's PLACEHOLDER_UUID walk) — neither exercises the
// real success path, so nothing caught the drift.
describe("DELETE /libraries/{id} (V1-004 regression)", () => {
  it("deletes a real library and answers 204 with no body; the library is gone afterward", async () => {
    const create = await request(app.getHttpServer())
      .post("/libraries")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Delete Me", mediaKind: "movie", paths: ["/data/delete-me"] });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const libraryId: string = create.body.id;

    const del = await request(app.getHttpServer())
      .delete(`/libraries/${libraryId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    expect(del.text).toBe("");

    const getAfter = await request(app.getHttpServer())
      .get(`/libraries/${libraryId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getAfter.status).toBe(404);
  });
});

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

  // POST /auth/login is rate-limited per identity (auth-rate-limiter.
  // service.ts) and the cases above already spend most of that budget on
  // one fresh casual login each. The R1 review-lane cases at the bottom of
  // this block all need the SAME thing — "a viewer with no restricted
  // entitlement" — so they share ONE memoized token rather than each
  // minting another login the limiter would (correctly) refuse.
  let sharedCasual: string | undefined;
  async function r1CasualToken(): Promise<string> {
    sharedCasual ??= await casualToken("r1-shared");
    return sharedCasual;
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

  // ==========================================================================
  // R1 review lane (adversarial zone walk) — HTTP twins of packages/db/
  // test/leak.spec.ts's 12h sweep, plus the surfaces that have no query-layer
  // equivalent at all (the image-serving controller, the admin Stash ops).
  // Rides this block's already-unlocked admin (see the describe's beforeAll)
  // — no extra lock/unlock cycle, so the 5/min unlock budget is untouched.
  // ==========================================================================

  it("R1 FINDING (HTTP twin): GET /restricted/performers/{id}/scenes must not resolve a person GET /restricted/performers/{id} denies — a general-class person with only a 'guest' credit on a zone scene answers 404 and an EMPTY page, never a real filmography", async () => {
    const db = createDb(databaseUrl);
    let marginalId: string;
    try {
      marginalId = (
        await db.selectFrom("people").select("id").where("name", "=", "Marginal General Actor").executeTakeFirstOrThrow()
      ).id;
    } finally {
      await db.destroy();
    }

    const detail = await request(app.getHttpServer())
      .get(`/restricted/performers/${marginalId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detail.status).toBe(404);

    const scenes = await request(app.getHttpServer())
      .get(`/restricted/performers/${marginalId}/scenes`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(scenes.status, JSON.stringify(scenes.body)).toBe(200);
    expect(scenes.body).toEqual({ items: [], nextCursor: null });

    // Positive control: a REAL zone performer's filmography is still a
    // real page — the fix narrowed the filter, it did not break it.
    const listRes = await request(app.getHttpServer())
      .get("/restricted/performers")
      .set("Authorization", `Bearer ${adminToken}`);
    const realPerformerId: string = listRes.body.items[0].id;
    const realScenes = await request(app.getHttpServer())
      .get(`/restricted/performers/${realPerformerId}/scenes`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(realScenes.status).toBe(200);
    expect(realScenes.body.items.length).toBeGreaterThan(0);
  });

  it("R1 FINDING (HTTP twin): a forged or malformed pagination cursor answers 422 problem+json on EVERY zone list op — never the 500 a driver-level uuid cast error produced", async () => {
    const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const probes: Array<[string, string]> = [
      ["/restricted/browse", forge({ sort: "added", order: "desc", sortKey: 0, id: "not-a-uuid" })],
      ["/restricted/browse", "%%%not-base64%%%"],
      ["/restricted/items", "%%%not-base64%%%"],
      ["/restricted/performers", forge({ name: "", id: "not-a-uuid" })],
      ["/restricted/studios", forge({ name: "", id: "not-a-uuid" })],
      ["/restricted/performers", "%%%not-base64%%%"],
    ];

    for (const [route, cursor] of probes) {
      const res = await request(app.getHttpServer())
        .get(route)
        .query({ cursor })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, `${route} cursor=${cursor} -> ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.body.type).toBe("urn:loombre:problem:validation");
      // The offending payload is never echoed back.
      expect(JSON.stringify(res.body)).not.toContain("not-a-uuid");
    }

    // /restricted/search takes q AND a cursor — the cursor check must not
    // shadow the entitlement/validation ordering the op documents.
    const searchRes = await request(app.getHttpServer())
      .get("/restricted/search")
      .query({ q: "After", cursor: forge({ rank: 1, id: "not-a-uuid" }) })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(searchRes.status, JSON.stringify(searchRes.body)).toBe(422);

    // A viewer with NO entitlement still gets the zone's 404 for the same
    // forged cursor — the 422 must never become an entitlement oracle.
    const casual = await r1CasualToken();
    const casualRes = await request(app.getHttpServer())
      .get("/restricted/browse")
      .query({ cursor: "%%%not-base64%%%" })
      .set("Authorization", `Bearer ${casual}`);
    expect(casualRes.status).toBe(404);
  });

  it("R1: the image-serving controller actually gates the zone's NEW image consumers — a restricted performer's portrait and a studio's logo are byte-identical 404s for an uncleared viewer and REAL bytes for a cleared one (previously unprovable: no fixture in this repo pointed at a file that exists, so every viewer got 404 and the denials proved nothing)", async () => {
    const listRes = await request(app.getHttpServer())
      .get("/restricted/performers")
      .set("Authorization", `Bearer ${adminToken}`);
    const performerId: string = listRes.body.items.find(
      (p: { name: string }) => p.name === "Restricted Performer One",
    ).id;
    const studiosRes = await request(app.getHttpServer())
      .get("/restricted/studios")
      .set("Authorization", `Bearer ${adminToken}`);
    const studioId: string = studiosRes.body.items[0].id;

    // A real 1x1 PNG on disk: without it the controller's `stat()` throws
    // and EVERY caller gets the same 404 regardless of clearance.
    const tmpDir = await mkdtemp(path.join(tmpdir(), "loombre-r1-image-"));
    const filePath = path.join(tmpDir, "fixture.png");
    await writeFile(
      filePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    const db = createDb(databaseUrl);
    try {
      await db
        .updateTable("images")
        .set({ file_path: filePath })
        .where("entity_type", "=", "person")
        .where("entity_id", "=", performerId)
        .execute();
      // Studio logos (S9/K2: a studio is a kind='studio' tag, its logo is
      // ingested at entity_type='tag') had NO fixture anywhere in the repo.
      await db
        .insertInto("images")
        .values({
          entity_type: "tag",
          entity_id: studioId,
          kind: "thumb",
          source: "local",
          width: 400,
          height: 400,
          blurhash: null,
          file_path: filePath,
          created_at_ms: Date.now(),
        })
        .execute();
    } finally {
      await db.destroy();
    }

    try {
      // Cleared: real bytes. This is the assertion that makes the denials
      // below mean something.
      for (const url of [`/images/person/${performerId}/thumb`, `/images/tag/${studioId}/thumb`]) {
        const ok = await request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${adminToken}`);
        expect(ok.status, `${url} -> ${JSON.stringify(ok.body)}`).toBe(200);
        expect(ok.headers["content-type"]).toBe("image/png");
        expect(Number(ok.headers["content-length"])).toBeGreaterThan(0);
      }

      // Uncleared: byte-identical 404s, indistinguishable from an entity
      // id that does not exist at all.
      const casual = await r1CasualToken();
      const nonexistent = await request(app.getHttpServer())
        .get("/images/person/00000000-0000-7000-8000-000000000000/thumb")
        .set("Authorization", `Bearer ${casual}`);
      expect(nonexistent.status).toBe(404);
      const { instance: _nonexistentInstance, ...nonexistentRest } = nonexistent.body;

      for (const url of [`/images/person/${performerId}/thumb`, `/images/tag/${studioId}/thumb`]) {
        const denied = await request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${casual}`);
        expect(denied.status, `${url} leaked to an uncleared viewer`).toBe(404);
        const { instance: _deniedInstance, ...deniedRest } = denied.body;
        expect(deniedRest).toEqual(nonexistentRest);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("R1: every admin Stash op answers 403 to a non-admin — before any library lookup, so it is never a library-existence oracle, and no sqlitePath/Stash prefix ever appears in the body", async () => {
    const db = createDb(databaseUrl);
    let restrictedLibraryId: string;
    try {
      restrictedLibraryId = (
        await db.selectFrom("libraries").select("id").where("content_class", "=", "restricted").executeTakeFirstOrThrow()
      ).id;
      // A configured connection with a real-looking Stash path: the
      // 403 must hold with data present, not merely because there is
      // nothing to return.
      const now = Date.now();
      await db
        .insertInto("library_stash_connections")
        .values({
          library_id: restrictedLibraryId,
          sqlite_path: "/home/owner/.stash/stash-go.sqlite",
          enabled: true,
          status: "never_connected",
          created_at_ms: now,
          updated_at_ms: now,
        })
        .onConflict((oc) => oc.column("library_id").doNothing())
        .execute();
    } finally {
      await db.destroy();
    }

    const casual = await r1CasualToken();
    const unknownLibraryId = "11111111-1111-4111-8111-111111111111";
    const probes: Array<{ method: "get" | "post"; url: string; body?: unknown }> = [
      { method: "get", url: `/admin/libraries/${restrictedLibraryId}/stash-connection` },
      { method: "get", url: `/admin/libraries/${restrictedLibraryId}/stash-path-mappings` },
      {
        method: "post",
        url: `/admin/libraries/${restrictedLibraryId}/stash-path-mappings/preview`,
        body: { mappings: [{ stashPrefix: "/home/owner/media", loombrePrefix: "/data/restricted" }] },
      },
      { method: "post", url: `/admin/libraries/${restrictedLibraryId}/stash-sync`, body: { mode: "incremental" } },
      { method: "get", url: `/admin/libraries/${restrictedLibraryId}/stash-sync-report` },
      // Same op, a library id that does not exist: a non-admin must get
      // the IDENTICAL 403, never the 404 that would confirm the id above
      // names a real library.
      { method: "get", url: `/admin/libraries/${unknownLibraryId}/stash-connection` },
    ];

    for (const probe of probes) {
      const res =
        probe.method === "get"
          ? await request(app.getHttpServer()).get(probe.url).set("Authorization", `Bearer ${casual}`)
          : await request(app.getHttpServer())
              .post(probe.url)
              .send(probe.body ?? {})
              .set("Authorization", `Bearer ${casual}`);
      expect(res.status, `${probe.method.toUpperCase()} ${probe.url} -> ${JSON.stringify(res.body)}`).toBe(403);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("stash-go.sqlite");
      expect(serialized).not.toContain("/home/owner");
      expect(serialized).not.toContain("sqlitePath");
    }

    // The two 403s (real library vs nonexistent library) are byte-identical
    // apart from `instance` — no existence oracle.
    const real = await request(app.getHttpServer())
      .get(`/admin/libraries/${restrictedLibraryId}/stash-connection`)
      .set("Authorization", `Bearer ${casual}`);
    const unknown = await request(app.getHttpServer())
      .get(`/admin/libraries/${unknownLibraryId}/stash-connection`)
      .set("Authorization", `Bearer ${casual}`);
    const { instance: _realInstance, ...realRest } = real.body;
    const { instance: _unknownInstance, ...unknownRest } = unknown.body;
    expect(realRest).toEqual(unknownRest);

    // Admin, same op: the path IS returned — proving the redaction above
    // is authorization, not an endpoint that never returns anything.
    const asAdmin = await request(app.getHttpServer())
      .get(`/admin/libraries/${restrictedLibraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(200);
    expect(asAdmin.body.sqlitePath).toBe("/home/owner/.stash/stash-go.sqlite");
  });

  it("R1: the /watch deep link's own API path is closed for an uncleared viewer — POST /playback/plan and POST /playback/sessions for a zone item answer the SAME 'Item or media file not found' 404 the general item-detail read does, so a shared zone URL degrades to 'no such item' rather than 'you may not play this'", async () => {
    const browseRes = await request(app.getHttpServer())
      .get("/restricted/browse")
      .set("Authorization", `Bearer ${adminToken}`);
    const sceneId: string = browseRes.body.items.find(
      (it: { title: string; durationMs: number | null }) => it.durationMs !== null,
    ).id;

    const casual = await r1CasualToken();
    const planBody = {
      itemId: sceneId,
      device: buildDeviceProfile("libraries-e2e-casual-watch"),
      network: { maxBitrateBps: 50_000_000, isLocal: true },
      mode: "stream" as const,
    };

    const plan = await request(app.getHttpServer())
      .post("/playback/plan")
      .send(planBody)
      .set("Authorization", `Bearer ${casual}`);
    expect(plan.status, JSON.stringify(plan.body)).toBe(404);

    const session = await request(app.getHttpServer())
      .post("/playback/sessions")
      .send(planBody)
      .set("Authorization", `Bearer ${casual}`);
    expect(session.status, JSON.stringify(session.body)).toBe(404);

    // Byte-identical to the same call for an itemId that does not exist —
    // "not cleared" and "not a thing" are the same answer.
    const nonexistent = await request(app.getHttpServer())
      .post("/playback/plan")
      .send({ ...planBody, itemId: "00000000-0000-7000-8000-000000000000" })
      .set("Authorization", `Bearer ${casual}`);
    expect(nonexistent.status).toBe(404);
    const { instance: _planInstance, ...planRest } = plan.body;
    const { instance: _nonexistentInstance, ...nonexistentRest } = nonexistent.body;
    expect(planRest).toEqual(nonexistentRest);

    // Positive control: the SAME plan request from the unlocked admin
    // resolves — the 404s above are clearance, not a broken request body.
    const cleared = await request(app.getHttpServer())
      .post("/playback/plan")
      .send({ ...planBody, device: buildDeviceProfile("libraries-e2e-admin-watch") })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(typeof cleared.body.decision).toBe("string");
  });

  it("R1: the general (non-zone) surfaces never surface Stash-mapped zone entities to an uncleared viewer over real HTTP — no studio names, no zone performers, no zone titles through /search, /people or /tags", async () => {
    const casual = await r1CasualToken();

    for (const q of ["Velvet Static", "Nightshade Films", "Restricted Performer One", "Restricted Genre A"]) {
      const res = await request(app.getHttpServer())
        .get("/search")
        .query({ q })
        .set("Authorization", `Bearer ${casual}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.items, `general search leaked on q=${q}`).toEqual([]);
    }

    const people = await request(app.getHttpServer()).get("/people?limit=200").set("Authorization", `Bearer ${casual}`);
    expect(people.status).toBe(200);
    const peopleSerialized = JSON.stringify(people.body);
    expect(peopleSerialized).not.toContain("Restricted Performer");
    expect(peopleSerialized).not.toContain("Marginal General Actor");

    const tags = await request(app.getHttpServer()).get("/tags?limit=200").set("Authorization", `Bearer ${casual}`);
    expect(tags.status).toBe(200);
    const tagsSerialized = JSON.stringify(tags.body);
    expect(tagsSerialized).not.toContain("Nightshade Films");
    expect(tagsSerialized).not.toContain("Aurora Media");
    expect(tagsSerialized).not.toContain("Restricted Genre");
    // 'Rare' is a GENERAL-class tag applied ONLY to a zone item — the
    // "used on >=1 visible item" clause has to hide it too.
    expect(tagsSerialized).not.toContain("Rare");

    // Control: the same three surfaces DO return general content for this
    // viewer, so the exclusions above are not "the endpoints are empty".
    const generalSearch = await request(app.getHttpServer())
      .get("/search")
      .query({ q: "Harbor" })
      .set("Authorization", `Bearer ${casual}`);
    expect(generalSearch.body.items.length).toBeGreaterThan(0);
    expect(people.body.items.length).toBeGreaterThan(0);
    expect(tags.body.items.length).toBeGreaterThan(0);
  });
});
