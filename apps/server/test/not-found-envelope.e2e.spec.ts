// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/not-found-envelope.e2e.spec.ts
//
// adi-F3 (QA 2026-08-21 remediation; owner ruling 2026-08-24). The whole
// 404 family now answers ONE body shape:
//
//   {"type":"urn:loombre:problem:not-found","title":"Not Found",
//    "status":404,"detail":"Not found.","instance":"<request path>"}
//
// Before this, five surfaces answered the minimal
// `{"type":"about:blank","title":"Not Found","status":404}` instead —
// unknown routes, wrong-method-as-404, the inert POST /setup/first-admin,
// the invite-claim / password-reset / probe garbage-token 404s — because
// they throw a BARE `NotFoundException()` whose response object is not
// problem-shaped, and `ProblemJsonExceptionFilter`'s fallback emitted a
// literal with no `detail` and no `instance`. Every 404 raised by the
// product's own code (`notFound()`, packages/contract-governed) already
// carried the complete envelope, so the API's error surface disagreed with
// itself depending on WHICH 404 you hit.
//
// THE INVARIANT THIS SUITE EXISTS TO PROTECT (why the fix had to enrich
// BOTH sides identically rather than just the contract-governed one):
//
//   For any given request path, a HIDDEN/unentitled resource and a
//   NONEXISTENT route must answer BYTE-IDENTICAL bodies.
//
// That is the anti-enumeration posture behind "invisible == nonexistent"
// (docs/PLAN.md §6.4, openapi.yaml's getClaimState/createFirstAdmin
// descriptions). It survives enrichment because `instance` reflects only
// the REQUESTER'S OWN path — never anything about what was or wasn't
// there. Each "same path, both ways" test below is that invariant on one
// surface: the real op's 404 vs the catch-all's 404 at the identical URL,
// compared byte for byte INCLUDING `instance`.
//
// The cross-path comparisons the older suites make (conformance.spec.ts,
// invites/setup/password-recovery/remote-probes e2e) necessarily differ in
// `instance` now and assert "identical in every other member" instead;
// this suite pins the stronger same-path form.
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

/** Asserted as LITERALS, never imported from the code under test — the
 *  point is to pin the WIRE shape, and an import would make that vacuous. */
const NOT_FOUND_TYPE = "urn:loombre:problem:not-found";
const NOT_FOUND_DETAIL = "Not found.";

/** A valid UUID that is not in the seed — "syntactically fine, nothing
 *  there", the shape a probing client would actually send. */
const ABSENT_UUID = "018f6f1e-0000-7000-8000-0000000000ff";

let app: INestApplication;
let adminToken: string;

/** Structural stand-in for supertest's Response — only the three members
 *  these helpers read, so the helpers stay usable from any harness. */
interface HttpProbe {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** The complete not-found envelope every 404 in this product must carry. */
function expectNotFoundProblem(res: HttpProbe, instance: string) {
  expect(res.status, res.text).toBe(404);
  expect(res.headers["content-type"]).toContain("application/problem+json");
  const body = JSON.parse(res.text) as Record<string, unknown>;
  expect(body["type"]).toBe(NOT_FOUND_TYPE);
  expect(body["title"]).toBe("Not Found");
  expect(body["status"]).toBe(404);
  expect(body["detail"]).toBe(NOT_FOUND_DETAIL);
  expect(body["instance"]).toBe(instance);
  return body;
}

/** The anti-probing invariant in its strongest form: same path, one
 *  response from the real operation and one from the catch-all, not one
 *  byte between them. */
function expectByteIdentical(a: HttpProbe, b: HttpProbe) {
  expect(a.status).toBe(b.status);
  expect(a.headers["content-type"]).toBe(b.headers["content-type"]);
  expect(a.text).toBe(b.text);
}

/** Two DIFFERENT paths: everything but `instance` must still match (the
 *  form the older cross-path suites can assert). */
function expectIdenticalApartFromInstance(a: HttpProbe, b: HttpProbe) {
  expect(a.status).toBe(b.status);
  expect(a.headers["content-type"]).toBe(b.headers["content-type"]);
  const strip = (res: HttpProbe) => {
    const body = JSON.parse(res.text) as Record<string, unknown>;
    delete body["instance"];
    return body;
  };
  expect(strip(a)).toEqual(strip(b));
  expect(Object.keys(JSON.parse(a.text) as object)).toEqual(Object.keys(JSON.parse(b.text) as object));
}

/** The catch-all sits BEHIND AuthGuard (only literal documented routes are
 *  public), so observing a REAL unknown-route/wrong-method 404 needs a
 *  valid Bearer token — same reasoning setup.e2e.spec.ts already documents. */
function catchAll(method: "get" | "post" | "put" | "delete" | "patch", url: string) {
  return request(app.getHttpServer())[method](url).set("Authorization", `Bearer ${adminToken}`);
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_not_found_envelope");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "not-found-envelope-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";
  process.env["LOOMBRE_RATE_CLAIM"] = "10000";
  process.env["LOOMBRE_RATE_PASSWORD_RESET"] = "10000";
  process.env["LOOMBRE_RATE_PROBE"] = "10000";
  process.env["LOOMBRE_RATE_SETUP"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const login = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "not-found-envelope-admin",
    deviceProfile: buildDeviceProfile("not-found-envelope-admin"),
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  adminToken = login.body.accessToken;
}, 180_000);

afterAll(async () => {
  await app?.close();
  delete process.env["LOOMBRE_RATE_LOGIN"];
  delete process.env["LOOMBRE_RATE_CLAIM"];
  delete process.env["LOOMBRE_RATE_PASSWORD_RESET"];
  delete process.env["LOOMBRE_RATE_PROBE"];
  delete process.env["LOOMBRE_RATE_SETUP"];
});

describe("adi-F3: the whole 404 family carries the complete not-found problem", () => {
  it("an unknown route answers urn:loombre:problem:not-found with detail + instance", async () => {
    const res = await catchAll("get", "/definitely/not/a/route");
    expectNotFoundProblem(res, "/definitely/not/a/route");
  }, 20_000);

  it("a wrong METHOD on a real path answers the same envelope, instance = that path", async () => {
    const res = await catchAll("delete", "/movies");
    expectNotFoundProblem(res, "/movies");
  }, 20_000);

  it("the unknown-route body echoes nothing but the caller's own path", async () => {
    const res = await catchAll("get", "/nope?token=super-secret-access-jwt&q=probe");
    const body = expectNotFoundProblem(res, "/nope?q=probe");
    // sanitize-instance.ts strips a query-string credential before it can
    // ride back in the body (P2.18) — enriching this family must not
    // reintroduce that leak.
    expect(JSON.stringify(body)).not.toContain("super-secret-access-jwt");
    // Nothing about the SERVER's routing table either: no route list, no
    // "Cannot GET" framework text, no method echo.
    expect(res.text).not.toContain("Cannot GET");
    expect(Object.keys(body).sort()).toEqual(["detail", "instance", "status", "title", "type"]);
  }, 20_000);

  it("every member is fixed except instance: two unknown routes differ in nothing else", async () => {
    const a = await catchAll("get", "/definitely/not/a/route-a");
    const b = await catchAll("post", "/definitely/not/a/route-b");
    expectIdenticalApartFromInstance(a, b);
  }, 20_000);
});

describe("adi-F3: hidden vs nonexistent stays byte-identical AT THE SAME PATH", () => {
  it("invite claim (garbage token) vs the catch-all on that same path", async () => {
    const claim = await request(app.getHttpServer()).get("/invites/claim/garbage-token-xyz");
    const wrongMethod = await catchAll("put", "/invites/claim/garbage-token-xyz");

    // The raw token is a PATH segment: `instance` collapses to the route
    // TEMPLATE (sanitize-instance.ts's TOKEN_PATH_TEMPLATES), so the token
    // itself never rides back — and every token, valid or not, produces
    // the identical body.
    expectNotFoundProblem(claim, "/invites/claim/{token}");
    expectByteIdentical(claim, wrongMethod);
    expect(claim.text).not.toContain("garbage-token-xyz");
  }, 20_000);

  it("two DIFFERENT garbage claim tokens are byte-identical to each other", async () => {
    const a = await request(app.getHttpServer()).get("/invites/claim/first-garbage-token");
    const b = await request(app.getHttpServer()).get("/invites/claim/second-garbage-token-much-longer");
    expectByteIdentical(a, b);
  }, 20_000);

  it("the inert POST /setup/first-admin vs the catch-all on that same path", async () => {
    const inert = await request(app.getHttpServer()).post("/setup/first-admin").send({
      username: "not-found-envelope-second-admin",
      email: "not-found-envelope-second-admin@loombre.local",
      password: "irrelevant-because-inert",
    });
    const wrongMethod = await catchAll("get", "/setup/first-admin");

    expectNotFoundProblem(inert, "/setup/first-admin");
    expectByteIdentical(inert, wrongMethod);
  }, 20_000);

  it("POST /auth/reset-password (never-issued token) vs the catch-all on that same path", async () => {
    const reset = await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token: "garbage-token-that-was-never-issued", password: "irrelevant-not-found-envelope" });
    const wrongMethod = await catchAll("get", "/auth/reset-password");

    expectNotFoundProblem(reset, "/auth/reset-password");
    expectByteIdentical(reset, wrongMethod);
  }, 20_000);

  it("GET /probe/{token} (never-issued token) vs the catch-all on that same path", async () => {
    const probe = await request(app.getHttpServer()).get("/probe/garbage-token-never-issued");
    const wrongMethod = await catchAll("post", "/probe/garbage-token-never-issued");

    expectNotFoundProblem(probe, "/probe/{token}");
    expectByteIdentical(probe, wrongMethod);
    expect(probe.text).not.toContain("garbage-token-never-issued");
  }, 20_000);

  // The restricted zone is the case the invariant was WRITTEN for: with
  // gate 1 (`restricted.enabled`) off — the seed's default — the zone does
  // not exist for ANY viewer, and every /restricted/* read 404s. Those
  // 404s already carried the full envelope; the catch-all's did not, so
  // the two disagreed. They must not.
  it("an unentitled viewer's /restricted/count vs the catch-all on that same path", async () => {
    const count = await request(app.getHttpServer()).get("/restricted/count").set("Authorization", `Bearer ${adminToken}`);
    const wrongMethod = await catchAll("put", "/restricted/count");

    expectNotFoundProblem(count, "/restricted/count");
    expectByteIdentical(count, wrongMethod);
  }, 20_000);

  it("an unentitled viewer's /restricted/scenes/{id} vs the catch-all on that same path", async () => {
    const scene = await request(app.getHttpServer())
      .get(`/restricted/scenes/${ABSENT_UUID}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const wrongMethod = await catchAll("put", `/restricted/scenes/${ABSENT_UUID}`);

    expectNotFoundProblem(scene, `/restricted/scenes/${ABSENT_UUID}`);
    expectByteIdentical(scene, wrongMethod);
  }, 20_000);

  it("a malformed id, an absent id and an unknown route all agree apart from instance", async () => {
    const malformed = await request(app.getHttpServer())
      .get("/restricted/scenes/not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    const absent = await request(app.getHttpServer())
      .get(`/restricted/scenes/${ABSENT_UUID}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const unknownRoute = await catchAll("get", "/this-route-does-not-exist-not-found-envelope");

    expectIdenticalApartFromInstance(malformed, absent);
    expectIdenticalApartFromInstance(absent, unknownRoute);
  }, 20_000);
});

describe("adi-F3: the enrichment is scoped to 404 — other framework statuses are untouched", () => {
  it("an unauthenticated unknown route still hits the 401 wall, not the 404 envelope", async () => {
    const res = await request(app.getHttpServer()).get("/definitely/not/a/route");
    expect(res.status).toBe(401);
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body["status"]).toBe(401);
    expect(String(body["type"])).toMatch(/^urn:loombre:/);
  }, 20_000);

  it("a contract-governed 404 keeps its OWN per-entity detail (this is not a flattening)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/movies/${ABSENT_UUID}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body["type"]).toBe(NOT_FOUND_TYPE);
    expect(body["detail"]).toBe("Movie not found.");
    expect(body["instance"]).toBe(`/movies/${ABSENT_UUID}`);
  }, 20_000);
});
