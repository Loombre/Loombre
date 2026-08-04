// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/plugins/admin-stash-connection.e2e.spec.ts
//
// HTTP-level exit proof for GET/PUT /admin/libraries/{id}/stash-connection
// (packages/contract/openapi.yaml, STATE.md K15, Lane E) — apps/server/src/
// plugins/admin-stash.{controller,service}.ts around packages/db/src/query/
// stash-connections.ts's genreTagNames tri-state. Mirrors
// admin-stash-sync-report.e2e.spec.ts's lighter-weight convention (own
// ensureTestDatabase suffix, real NestFactory-booted AppModule, supertest,
// direct DB row seeding for the library rather than spawning any child
// process).
//
// Covers: 403 for a non-admin token, 404 for an unknown library on both
// GET and PUT, the `configured: false` shape (genreTagNames null) before
// any save, a round-trip saving sqlitePath + an explicit genreTagNames
// array, leaving genreTagNames untouched across a save that omits the key,
// and explicitly resetting it back to null (the default heuristic) via a
// literal `null` in the body.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");
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
let casualToken: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "admin-stash-connection-test-secret-not-for-production";

  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_stash_connection_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-stash-connection-admin",
    deviceProfile: buildDeviceProfile("admin-stash-connection-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "admin-stash-connection-casual",
    deviceProfile: buildDeviceProfile("admin-stash-connection-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app.close();
});

async function makeRestrictedLibrary(name: string): Promise<string> {
  const db = createDb(databaseUrl);
  try {
    const now = Date.now();
    const row = await db
      .insertInto("libraries")
      .values({ name, media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row.id;
  } finally {
    await db.destroy();
  }
}

describe("GET/PUT /admin/libraries/{id}/stash-connection", () => {
  it("403s for a non-admin token on both GET and PUT", async () => {
    const libraryId = await makeRestrictedLibrary("stash-conn-403-lib");
    const getRes = await request(app.getHttpServer())
      .get(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${casualToken}`);
    expect(getRes.status).toBe(403);

    const putRes = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${casualToken}`)
      .send({ sqlitePath: "/data/stash.sqlite" });
    expect(putRes.status).toBe(403);
  });

  it("404s for an unknown library id on both GET and PUT", async () => {
    const unknownId = "11111111-1111-4111-8111-111111111111";
    const getRes = await request(app.getHttpServer())
      .get(`/admin/libraries/${unknownId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getRes.status).toBe(404);

    const putRes = await request(app.getHttpServer())
      .put(`/admin/libraries/${unknownId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash.sqlite" });
    expect(putRes.status).toBe(404);
  });

  it("GET before any save: configured false, genreTagNames null", async () => {
    const libraryId = await makeRestrictedLibrary("stash-conn-unconfigured-lib");
    const res = await request(app.getHttpServer())
      .get(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      libraryId,
      configured: false,
      sqlitePath: null,
      enabled: false,
      genreTagNames: null,
      status: "never_connected",
    });
  });

  it("round-trip: PUT with an explicit genreTagNames array, GET reflects it; omitting the key on a later PUT leaves it untouched; an explicit null resets it to the heuristic", async () => {
    const libraryId = await makeRestrictedLibrary("stash-conn-roundtrip-lib");

    const firstPut = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash.sqlite", genreTagNames: ["Action", "Comedy"] });
    expect(firstPut.status, JSON.stringify(firstPut.body)).toBe(200);
    expect(firstPut.body).toMatchObject({
      libraryId,
      configured: true,
      sqlitePath: "/data/stash.sqlite",
      genreTagNames: ["Action", "Comedy"],
    });

    const getAfterFirstPut = await request(app.getHttpServer())
      .get(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getAfterFirstPut.status).toBe(200);
    expect(getAfterFirstPut.body.genreTagNames).toEqual(["Action", "Comedy"]);

    // Omitting genreTagNames entirely on a second PUT (e.g. the admin only
    // changed sqlitePath) must leave the saved list untouched.
    const secondPut = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash-moved.sqlite" });
    expect(secondPut.status, JSON.stringify(secondPut.body)).toBe(200);
    expect(secondPut.body.sqlitePath).toBe("/data/stash-moved.sqlite");
    expect(secondPut.body.genreTagNames).toEqual(["Action", "Comedy"]);

    // An explicit `null` resets it back to the default heuristic.
    const thirdPut = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash-moved.sqlite", genreTagNames: null });
    expect(thirdPut.status, JSON.stringify(thirdPut.body)).toBe(200);
    expect(thirdPut.body.genreTagNames).toBeNull();

    const getAfterReset = await request(app.getHttpServer())
      .get(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getAfterReset.status).toBe(200);
    expect(getAfterReset.body.genreTagNames).toBeNull();
  });

  it("422s when genreTagNames is neither an array of strings nor null", async () => {
    const libraryId = await makeRestrictedLibrary("stash-conn-422-lib");
    const res = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash.sqlite", genreTagNames: [1, 2, 3] });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
  });

  it("blobsPath round-trip: null before any save; PUT sets it; omit leaves untouched; null clears it (filesystem blob-store support)", async () => {
    const libraryId = await makeRestrictedLibrary("stash-conn-blobs-lib");

    const before = await request(app.getHttpServer())
      .get(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(before.body.blobsPath).toBeNull();

    const set = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash.sqlite", blobsPath: "/data/stash/blobs" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.blobsPath).toBe("/data/stash/blobs");

    // Omitting blobsPath on a later PUT leaves it untouched.
    const omit = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash.sqlite", enabled: false });
    expect(omit.body.blobsPath).toBe("/data/stash/blobs");

    // Explicit null clears it back to DB-only art.
    const clear = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash.sqlite", blobsPath: null });
    expect(clear.body.blobsPath).toBeNull();
  });

  it("422s when blobsPath is neither a string nor null", async () => {
    const libraryId = await makeRestrictedLibrary("stash-conn-blobs-422-lib");
    const res = await request(app.getHttpServer())
      .put(`/admin/libraries/${libraryId}/stash-connection`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sqlitePath: "/data/stash.sqlite", blobsPath: 42 });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
  });
});
