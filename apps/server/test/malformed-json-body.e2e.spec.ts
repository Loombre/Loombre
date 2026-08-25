// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/malformed-json-body.e2e.spec.ts
//
// adi-F4 (QA 2026-08-21 remediation, P2). A request body that is not valid
// JSON never reaches a controller: express body-parser throws a SyntaxError,
// and @nestjs/core's RoutesResolver.mapExternalException rewrites it into
// `new BadRequestException(err.message)` — so the RAW V8 parse error became
// the exception message. `ProblemJsonExceptionFilter`'s
// "not already problem-shaped" fallback then promoted that message verbatim
// into `title` and emitted `{type:"about:blank", title:<raw>, status:400}`
// with no `detail` and no `instance`.
//
// Two things were wrong with that, and this suite pins both:
//   1. ENVELOPE — every other client-input rejection in this product answers
//      a complete RFC 9457 body (`urn:loombre:*` type + detail + instance;
//      see api-body-validation.e2e.spec.ts's 422s). The 400 did not.
//   2. ECHO — for V8's "Unexpected token" message form the parse error
//      embeds a verbatim FRAGMENT OF THE SUBMITTED BODY, so a mistyped
//      login body handed the password back in an error title (client
//      consoles, intermediary logs). That is the exact posture the same
//      filter already takes deliberately for `MalformedCursorError`
//      ("Malformed cursor.", payload never echoed) and for its generic 500.
//
// adi-F3 (owner ruling 2026-08-24) finished the job on the SIBLING family
// this suite used to pin as deliberately-unchanged: the bare-404s (unknown
// route, wrong method, garbage invite token) no longer answer the minimal
// `{type:"about:blank", title:"Not Found", status:404}` — they carry the
// same complete envelope, `urn:loombre:problem:not-found` + a fixed generic
// detail + instance. The final `describe` below is now the cross-check that
// the 400 and 404 conversions agree with each other (same no-echo rule, same
// completeness); the family's own regression net is
// apps/server/test/not-found-envelope.e2e.spec.ts.
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
import {
  expectSameNotFoundBodyApartFromInstance,
  expectSharedNotFoundProblem,
} from "./support/not-found-envelope.js";

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

/** Sends `raw` as the request entity VERBATIM (supertest would otherwise
 *  re-serialize an object, which can never be malformed). */
function postRaw(url: string, raw: string, token?: string) {
  const req = request(app.getHttpServer()).post(url).set("Content-Type", "application/json");
  return (token === undefined ? req : req.set("Authorization", `Bearer ${token}`)).send(raw);
}

function patchRaw(url: string, raw: string, token: string) {
  return request(app.getHttpServer())
    .patch(url)
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${token}`)
    .send(raw);
}

const MALFORMED_BODY_TYPE = "urn:loombre:problem:malformed-request";
const MALFORMED_BODY_DETAIL = "The request body is not valid JSON.";

/** The wire shape every malformed-body rejection must have. */
function expectMalformedBodyProblem(
  res: { status: number; headers: Record<string, string>; text: string },
  instance: string,
) {
  expect(res.status, res.text).toBe(400);
  expect(res.headers["content-type"]).toContain("application/problem+json");
  const body = JSON.parse(res.text) as Record<string, unknown>;
  expect(body["type"]).toBe(MALFORMED_BODY_TYPE);
  expect(body["title"]).toBe("Bad Request");
  expect(body["status"]).toBe(400);
  expect(body["detail"]).toBe(MALFORMED_BODY_DETAIL);
  expect(body["instance"]).toBe(instance);
  return body;
}

/** No internal parser text ever reaches the client — the same rule the
 *  generic-500 branch is already unit-tested against. */
function expectNoParserLeak(res: { text: string }) {
  expect(res.text).not.toContain("Unexpected token");
  // V8's echoing form is `"<fragment of the body>" is not valid JSON`; the
  // leading quote is what distinguishes it from this product's own fixed
  // detail, which legitimately ends "...is not valid JSON.".
  expect(res.text).not.toContain('" is not valid JSON');
  expect(res.text).not.toContain("in JSON at position");
  expect(res.text).not.toContain("Unterminated string");
  expect(res.text).not.toContain("Expected double-quoted property name");
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_malformed_json_body");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "malformed-json-body-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const login = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "malformed-json-body-admin",
    deviceProfile: buildDeviceProfile("malformed-json-body-admin"),
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  adminToken = login.body.accessToken;
}, 180_000);

afterAll(async () => {
  await app?.close();
  delete process.env["LOOMBRE_RATE_LOGIN"];
});

describe("adi-F4: a malformed JSON body answers a complete RFC 9457 problem", () => {
  it("POST /auth/login (unauthenticated, the cited repro) -> full problem envelope", async () => {
    const res = await postRaw("/auth/login", '{"username": broken');
    expectMalformedBodyProblem(res, "/auth/login");
    expectNoParserLeak(res);
  }, 20_000);

  it("the body is never echoed back — V8's 'Unexpected token' form quotes the submitted entity", async () => {
    const res = await postRaw("/auth/login", '{"password": hunter2-not-a-real-secret}');
    expectMalformedBodyProblem(res, "/auth/login");
    expectNoParserLeak(res);
    expect(res.text).not.toContain("hunter2");
    expect(res.text).not.toContain("password");
  }, 20_000);

  it("the position-style parse message is not surfaced either (trailing comma)", async () => {
    const res = await postRaw("/auth/login", '{"username": "admin",}');
    expectMalformedBodyProblem(res, "/auth/login");
    expectNoParserLeak(res);
    expect(res.text).not.toContain("position");
  }, 20_000);

  it("a truncated body (unterminated string) gets the same fixed envelope", async () => {
    const res = await postRaw("/auth/login", '{"username": "admi');
    expectMalformedBodyProblem(res, "/auth/login");
    expectNoParserLeak(res);
  }, 20_000);

  it("a non-object entity (strict-mode violation) gets the same fixed envelope", async () => {
    const res = await postRaw("/auth/login", '"just-a-string"');
    expectMalformedBodyProblem(res, "/auth/login");
    expectNoParserLeak(res);
  }, 20_000);

  it("an AUTHENTICATED route answers the same envelope, with its own instance", async () => {
    const res = await patchRaw("/users/me", '{"displayName": oops', adminToken);
    expectMalformedBodyProblem(res, "/users/me");
    expectNoParserLeak(res);
  }, 20_000);

  it("instance is sanitized, never echoing a ?token= query credential", async () => {
    const res = await postRaw("/auth/login?token=super-secret-access-jwt", '{"username": broken');
    expect(res.status, res.text).toBe(400);
    expect(res.text).not.toContain("super-secret-access-jwt");
    expectNoParserLeak(res);
  }, 20_000);

  // The OTHER exception @nestjs/core's mapExternalException rewrites into a
  // bare BadRequestException: a URIError from a path param with invalid
  // percent-encoding. Same defect shape (its message quotes the offending
  // segment back), same fix — but the body is not what failed, so it gets
  // the generic detail rather than the JSON one.
  it("a path param with invalid percent-encoding also answers a complete problem, no echo", async () => {
    const res = await request(app.getHttpServer())
      .get("/movies/%FF")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, res.text).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body["type"]).toBe(MALFORMED_BODY_TYPE);
    expect(body["title"]).toBe("Bad Request");
    expect(body["detail"]).toBe("The request could not be parsed.");
    // `instance` is the request path by design (RFC 9457, and what every
    // other problem body here carries); what must not appear is the
    // framework's internal message ABOUT it.
    expect(res.text).not.toContain("Failed to decode param");
    expect(body["instance"]).toBe("/movies/%FF");
  }, 20_000);

  it("a WELL-FORMED body is unaffected — it still reaches the normal validation path", async () => {
    const res = await postRaw("/auth/login", '{"username": "admin"}');
    expect(res.status).not.toBe(400);
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(String(body["type"] ?? "")).toMatch(/^urn:loombre:/);
  }, 20_000);
});

// adi-F3's territory — the sibling conversion. See the file header; the
// exhaustive per-surface proof is not-found-envelope.e2e.spec.ts.
describe("adi-F3: the bare-404 family answers the same complete envelope this 400 does", () => {
  it("an unknown route answers the complete not-found problem", async () => {
    const res = await request(app.getHttpServer())
      .get("/definitely/not/a/route")
      .set("Authorization", `Bearer ${adminToken}`);
    expectSharedNotFoundProblem(res, "/definitely/not/a/route");
  }, 20_000);

  it("a garbage invite token is byte-identical to the catch-all's 404 on that same path", async () => {
    // The catch-all probe is AUTHENTICATED for the same reason
    // conformance.spec.ts's byte-identity assertions are: unauthenticated it
    // would be answered by the auth guard's 401, not the catch-all's 404.
    const sameRouteWrongMethod = await request(app.getHttpServer())
      .put("/invites/claim/garbage-token-xyz")
      .set("Authorization", `Bearer ${adminToken}`);
    const unknownRoute = await request(app.getHttpServer())
      .get("/definitely/not/a/route-2")
      .set("Authorization", `Bearer ${adminToken}`);
    const claim = await request(app.getHttpServer()).get("/invites/claim/garbage-token-xyz");

    expectSharedNotFoundProblem(claim, "/invites/claim/{token}");
    expect(claim.text).toBe(sameRouteWrongMethod.text);
    expectSameNotFoundBodyApartFromInstance(claim, unknownRoute);
  }, 20_000);

  it("both conversions obey the same no-echo rule: neither body says WHAT failed", async () => {
    const notFound = await request(app.getHttpServer())
      .get("/definitely/not/a/route")
      .set("Authorization", `Bearer ${adminToken}`);
    const badRequest = await postRaw("/auth/login", '{"username": broken');
    for (const res of [notFound, badRequest]) {
      const body = JSON.parse(res.text) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["detail", "instance", "status", "title", "type"]);
      expect(String(body["type"])).toMatch(/^urn:loombre:/);
    }
  }, 20_000);
});
