// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/security-hardening.e2e.spec.ts
//
// End-to-end coverage for the Wave-4 review's F1/F2/F3 findings:
//
//   F1 (MED) — a malformed-UUID :id path param used to reach the DB layer
//   unchanged, where Postgres's implicit `uuid` cast throws a raw driver
//   error that escaped ProblemJsonExceptionFilter (it was
//   @Catch(HttpException)-only) and surfaced as a bare, non-RFC-9457
//   `{"statusCode":500}` with DB error log spam. Fixed two ways: (a) the
//   filter is now a catch-all (unit-tested directly in
//   gateway/problem-json.filter.spec.ts — this file proves it's never
//   actually REACHED for a malformed id, because (b) gateway/
//   require-uuid-param.ts now short-circuits every :id-path-param route to
//   the SAME 404 problem+json a nonexistent-but-well-formed id produces
//   (STATE.md's invisible == nonexistent posture — byte-identical modulo
//   `instance`), before any DB touch. This file exercises EVERY route
//   listed in the fix assignment (movies/series/seasons/episodes/artists/
//   albums/tracks/people/images/playback sessions+file/progress/libraries/
//   devices/users/admin), not just a sample — cheap to do since neither
//   side of any comparison here needs a real row to exist.
//
//   F2 (MED) — no security headers, and P2.18's `?token=` media-fetch
//   fallback rides in query strings with no Referrer-Policy. Server-side
//   fix lives in src/main.ts's applySecurityHeaders (unit-tested in
//   main.spec.ts against a fake app); this file proves the three headers
//   land on REAL responses, including error responses (Express middleware
//   runs regardless of which filter/handler produced the response).
//
//   F3 (LOW) — Express's default `X-Powered-By: Express` header disclosed
//   server tech for free; src/main.ts's disableXPoweredBy fixes it. This
//   file asserts the header is absent.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed) — same
// convention as auth-security.e2e.spec.ts/libraries.e2e.spec.ts. Neither
// side of any F1 byte-identical comparison below needs a seeded row: a
// malformed id and a syntactically-valid-but-nonexistent id are BOTH
// "not found" regardless of what else exists in the database, so this
// file doesn't need the full seed.mjs fixture set — it still runs it
// (cheap, ~seconds) for parity with every other e2e file's DB shape and
// so admin/casual login + a real library/scan-target id are available in
// case that ever changes.

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
import { applySecurityHeaders, disableXPoweredBy } from "../src/main.js";

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
let adminToken: string;
let casualToken: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "security-hardening-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "security_hardening_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  applySecurityHeaders(app);
  disableXPoweredBy(app);
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "security-hardening-admin",
    deviceProfile: buildDeviceProfile("security-hardening-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "security-hardening-casual",
    deviceProfile: buildDeviceProfile("security-hardening-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app.close();
});

function callerFor(token: string) {
  const server = () => app.getHttpServer();
  return {
    get: (url: string) => request(server()).get(url).set("Authorization", `Bearer ${token}`),
    put: (url: string, body?: object) => request(server()).put(url).set("Authorization", `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => request(server()).patch(url).set("Authorization", `Bearer ${token}`).send(body ?? {}),
    delete: (url: string) => request(server()).delete(url).set("Authorization", `Bearer ${token}`),
    post: (url: string, body?: object) => request(server()).post(url).set("Authorization", `Bearer ${token}`).send(body ?? {}),
  };
}
function admin() {
  return callerFor(adminToken);
}
function casual() {
  return callerFor(casualToken);
}

const MALFORMED_ID = "not-a-real-uuid";
const NONEXISTENT_ID = "018f6f1e-0000-7000-8000-00000000dead";

/** Runs `makeRequest` once with a malformed id and once with a
 *  syntactically-valid-but-nonexistent one, asserting BOTH are 404
 *  problem+json and byte-identical apart from `instance` (STATE.md
 *  invisible == nonexistent posture, extended by F1 to also cover
 *  "malformed" as a third indistinguishable case). */
async function expectByteIdentical404(makeRequest: (id: string) => request.Test): Promise<void> {
  const malformed = await makeRequest(MALFORMED_ID);
  const nonexistent = await makeRequest(NONEXISTENT_ID);

  expect(malformed.status, JSON.stringify(malformed.body)).toBe(404);
  expect(nonexistent.status, JSON.stringify(nonexistent.body)).toBe(404);
  expect(malformed.headers["content-type"]).toMatch(/^application\/problem\+json/);
  expect(nonexistent.headers["content-type"]).toMatch(/^application\/problem\+json/);

  const { instance: _i1, ...malformedRest } = malformed.body;
  const { instance: _i2, ...nonexistentRest } = nonexistent.body;
  expect(malformedRest).toEqual(nonexistentRest);
}

describe("F1: malformed :id path params are byte-identical 404s, not bare 500s", () => {
  it("GET /movies/{id}", () => expectByteIdentical404((id) => casual().get(`/movies/${id}`)));
  it("GET /series/{id}", () => expectByteIdentical404((id) => casual().get(`/series/${id}`)));
  it("GET /series/{id}/seasons", () => expectByteIdentical404((id) => casual().get(`/series/${id}/seasons`)));
  it("GET /seasons/{id}/episodes", () => expectByteIdentical404((id) => casual().get(`/seasons/${id}/episodes`)));
  it("GET /episodes/{id}", () => expectByteIdentical404((id) => casual().get(`/episodes/${id}`)));

  it("GET /artists/{id}", () => expectByteIdentical404((id) => casual().get(`/artists/${id}`)));
  it("GET /artists/{id}/albums", () => expectByteIdentical404((id) => casual().get(`/artists/${id}/albums`)));
  it("GET /albums/{id}", () => expectByteIdentical404((id) => casual().get(`/albums/${id}`)));
  it("GET /albums/{id}/tracks", () => expectByteIdentical404((id) => casual().get(`/albums/${id}/tracks`)));
  it("GET /tracks/{id}", () => expectByteIdentical404((id) => casual().get(`/tracks/${id}`)));

  it("GET /people/{id}", () => expectByteIdentical404((id) => casual().get(`/people/${id}`)));

  it("GET /images/movie/{id}/poster", () => expectByteIdentical404((id) => casual().get(`/images/movie/${id}/poster`)));

  it("GET /playback/sessions/{id}", () => expectByteIdentical404((id) => casual().get(`/playback/sessions/${id}`)));
  it("DELETE /playback/sessions/{id}", () => expectByteIdentical404((id) => casual().delete(`/playback/sessions/${id}`)));
  it("GET /playback/sessions/{id}/file", () => expectByteIdentical404((id) => casual().get(`/playback/sessions/${id}/file`)));

  it("GET /progress/{itemId}", () => expectByteIdentical404((id) => casual().get(`/progress/${id}`)));
  it("PUT /progress/{itemId}", () =>
    expectByteIdentical404((id) => casual().put(`/progress/${id}`, { positionMs: 1000, state: "in-progress" })));

  it("GET /libraries/{id}", () => expectByteIdentical404((id) => casual().get(`/libraries/${id}`)));
  it("PATCH /libraries/{id}", () => expectByteIdentical404((id) => admin().patch(`/libraries/${id}`, { name: "x" })));
  it("DELETE /libraries/{id}", () => expectByteIdentical404((id) => admin().delete(`/libraries/${id}`)));
  it("POST /libraries/{id}/scan", () => expectByteIdentical404((id) => admin().post(`/libraries/${id}/scan`, {})));
  it("GET /libraries/{id}/permissions", () => expectByteIdentical404((id) => admin().get(`/libraries/${id}/permissions`)));
  it("PUT /libraries/{id}/permissions", () =>
    expectByteIdentical404((id) => admin().put(`/libraries/${id}/permissions`, { permissions: [] })));

  it("GET /devices/{id}", () => expectByteIdentical404((id) => casual().get(`/devices/${id}`)));
  it("DELETE /devices/{id}", () => expectByteIdentical404((id) => casual().delete(`/devices/${id}`)));

  it("GET /users/{id}", () => expectByteIdentical404((id) => admin().get(`/users/${id}`)));
  it("PATCH /users/{id}", () => expectByteIdentical404((id) => admin().patch(`/users/${id}`, { email: "x@example.com" })));
  it("DELETE /users/{id}", () => expectByteIdentical404((id) => admin().delete(`/users/${id}`)));

  it("GET /admin/jobs/{id}", () => expectByteIdentical404((id) => admin().get(`/admin/jobs/${id}`)));

  it("a malformed id never produces a bare non-problem+json 500 (the original bug)", async () => {
    const res = await casual().get(`/movies/${MALFORMED_ID}`);
    expect(res.status).not.toBe(500);
    expect(res.body).not.toEqual({ statusCode: 500 });
    expect(res.body.type).toBeDefined();
    expect(res.body.title).toBeDefined();
  });
});

describe("F2: security headers on every response", () => {
  it("a normal 200 response carries nosniff / no-referrer / DENY", async () => {
    const res = await casual().get("/movies?limit=1");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("an error response (404) ALSO carries the three headers — middleware runs regardless of filter", async () => {
    const res = await casual().get(`/movies/${NONEXISTENT_ID}`);
    expect(res.status).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("an unauthenticated 401 response also carries the three headers", async () => {
    const res = await request(app.getHttpServer()).get("/movies");
    expect(res.status).toBe(401);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("F3: X-Powered-By is disabled", () => {
  it("is absent on a normal response", async () => {
    const res = await casual().get("/movies?limit=1");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("is absent on an error response", async () => {
    const res = await casual().get(`/movies/${MALFORMED_ID}`);
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
