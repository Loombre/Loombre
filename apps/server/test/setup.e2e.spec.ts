// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/setup.e2e.spec.ts
//
// HTTP-level end-to-end coverage for GET /setup/state + POST
// /setup/first-admin (STATE.md P4.6/P4.10, lane C). Self-sufficient (own
// ensureTestDatabase suffix, own reset — deliberately WITHOUT seed.mjs: the
// whole point of this file is a genuinely empty `users` table, a fresh
// install's real starting condition), same convention as
// libraries.e2e.spec.ts/admin-sessions.e2e.spec.ts.
//
// Covers the task spec directly:
//   1. Empty-DB happy path: state true -> create -> 201 with real tokens
//      that work on an authenticated call -> state false -> second create
//      404.
//   2. Race safety: many concurrent POST /setup/first-admin calls against
//      an empty table yield exactly one 201, everyone else 404 (HTTP-level
//      corroboration of packages/db/test/setup-first-admin.spec.ts's
//      lower-level proof).
//   3. Byte-identical 404: the post-populated 404 body is compared, byte
//      for byte, against a real hit on NotFoundController's `*splat`
//      catch-all (apps/server/src/gateway/not-found.controller.ts) — not
//      just schema-shape-valid, the literal same JSON.
//   4. Client-side validation floor (422s) mirroring FirstAdminRequest's
//      contract minimums (username/email/password required, password
//      minLength 8).
//
// Rate limiting (STATE.md P4.15): covered, but NOT in this file — the
// limiter shipped (setup.controller.ts: SurfaceRateLimitGuard +
// @RateLimit("setup","ip") on both routes) and its 429/Retry-After proof
// lives in the sibling setup-rate-limit.e2e.spec.ts, which boots its OWN
// app with a low LOOMBRE_RATE_SETUP ceiling; this suite's functional/race
// tests need an effectively-unlimited ceiling, so the two cannot share an
// app (see that file's header for the full rationale).

import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

let app: INestApplication;
let databaseUrl: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "setup-e2e-test-secret-not-for-production";
  // Both setup routes carry the per-IP "setup" rate limiter (P4.15 /
  // security-review M1). These functional + race tests all originate from
  // one loopback IP and fire many requests (incl. 10 concurrent in the race
  // test), so an effectively-unlimited ceiling keeps the limiter from
  // interfering with what they DO test — the dedicated "rate limiting"
  // describe at the bottom boots its own app with a low ceiling and proves
  // the 429 fires.
  process.env["LOOMBRE_RATE_SETUP"] = "100000";
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "setup_e2e_test");
  process.env["DATABASE_URL"] = databaseUrl;

  // STATE.md Addendum A (lane S2): the schema must exist BEFORE the first
  // app.init() now — AppModule wires SettingsModule, whose SettingsService
  // reads server_settings from OnApplicationBootstrap (fires exactly once,
  // during this app.init() call). Every OTHER e2e suite already migrates
  // before booting; this file previously only reset in beforeEach (AFTER
  // the one-time app.init() below), which happened to be harmless before
  // any service queried the DB at boot time. resetEmpty() below still runs
  // before every individual test, unaffected.
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

/** Every test in this file wants to start from a genuinely empty `users`
 *  table — reset WITHOUT seeding, unlike every other e2e suite here. */
function resetEmpty(): void {
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
}

describe("GET /setup/state (public)", () => {
  beforeEach(resetEmpty);

  it("needsSetup: true on a freshly reset, unseeded database", async () => {
    const res = await request(app.getHttpServer()).get("/setup/state");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({ needsSetup: true });
  });

  it("needsSetup: false once a user exists", async () => {
    const created = await request(app.getHttpServer()).post("/setup/first-admin").send({
      username: "wizard-admin",
      email: "wizard-admin@loombre.local",
      password: "correct-horse-battery-staple",
    });
    expect(created.status).toBe(201);

    const res = await request(app.getHttpServer()).get("/setup/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSetup: false });
  });

  it("is reachable with NO Authorization header (public route, not a 401 wall)", async () => {
    const res = await request(app.getHttpServer()).get("/setup/state").unset("Authorization");
    expect(res.status).toBe(200);
  });
});

describe("POST /setup/first-admin (public until the first user, then permanently inert)", () => {
  beforeEach(resetEmpty);

  it("empty-DB happy path end to end: create -> 201 real tokens -> authenticated call works -> state flips -> second create 404", async () => {
    const stateBefore = await request(app.getHttpServer()).get("/setup/state");
    expect(stateBefore.body).toEqual({ needsSetup: true });

    const created = await request(app.getHttpServer()).post("/setup/first-admin").send({
      username: "wizard-admin",
      email: "wizard-admin@loombre.local",
      password: "correct-horse-battery-staple",
      displayName: "Wizard Admin",
    });

    expect(created.status).toBe(201);
    expect(created.headers["content-type"]).toMatch(/^application\/json/);
    expect(created.body.user).toMatchObject({
      username: "wizard-admin",
      email: "wizard-admin@loombre.local",
      isAdmin: true,
    });
    expect(typeof created.body.user.id).toBe("string");
    expect(created.body.tokens).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      accessTokenExpiresAtMs: expect.any(Number),
      deviceId: expect.any(String),
    });

    // The minted access token is REAL — it authenticates an ordinary
    // request exactly like a login-issued one would (task spec: "returns
    // 201 {user, tokens} (real TokenPair via the existing token service +
    // device-row creation like login does)").
    const me = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${created.body.tokens.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("wizard-admin");
    expect(me.body.isAdmin).toBe(true);

    const stateAfter = await request(app.getHttpServer()).get("/setup/state");
    expect(stateAfter.body).toEqual({ needsSetup: false });

    const secondCreate = await request(app.getHttpServer()).post("/setup/first-admin").send({
      username: "second-admin",
      email: "second-admin@loombre.local",
      password: "another-long-enough-password",
    });
    expect(secondCreate.status).toBe(404);
  });

  it("is reachable with NO Authorization header on an empty instance (public, not a 401 wall)", async () => {
    const res = await request(app.getHttpServer())
      .post("/setup/first-admin")
      .unset("Authorization")
      .send({ username: "wizard-admin", email: "wizard-admin@loombre.local", password: "correct-horse-battery" });
    expect(res.status).toBe(201);
  });

  describe("validation floor mirrors FirstAdminRequest (422, no row written)", () => {
    it("missing username -> 422", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ email: "a@loombre.local", password: "correct-horse-battery" });
      expect(res.status).toBe(422);
      const state = await request(app.getHttpServer()).get("/setup/state");
      expect(state.body).toEqual({ needsSetup: true });
    });

    it("missing email -> 422", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ username: "wizard-admin", password: "correct-horse-battery" });
      expect(res.status).toBe(422);
    });

    it("missing password -> 422", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ username: "wizard-admin", email: "a@loombre.local" });
      expect(res.status).toBe(422);
    });

    it("password shorter than 8 chars -> 422 (FirstAdminRequest.password minLength: 8)", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ username: "wizard-admin", email: "a@loombre.local", password: "short1" });
      expect(res.status).toBe(422);
    });
  });

  // d3-b4: FirstAdminRequest.email is `{ type: string, format: email }`
  // (packages/contract/openapi.yaml) but createFirstAdmin only ever ran
  // isNonEmptyString on it — no trim, no isValidEmailFormat — while the
  // OTHER three user-email write paths (createUser, updateMe, updateUser)
  // have all trimmed-then-validated since R-F4/api-validation-F4. This is
  // the FIRST admin account, i.e. the mailbox every password-reset goes to,
  // so a typo'd or whitespace-padded address here is the worst of the four
  // to get wrong. Same block those three run, minus the null branch (email
  // is required here, not nullable).
  describe("email format (FirstAdminRequest.email format: email — d3-b4)", () => {
    const VALID_BODY = { username: "wizard-admin", password: "correct-horse-battery-staple" };

    async function stillNeedsSetup(): Promise<boolean> {
      const state = await request(app.getHttpServer()).get("/setup/state");
      expect(state.status).toBe(200);
      return state.body.needsSetup === true;
    }

    it("422s on a value that is not an email shape at all, and creates NO admin", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ ...VALID_BODY, email: "not-an-email" });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.body.type).toBe("urn:loombre:problem:validation");
      // The same detail createUser/updateMe/updateUser all use — the four
      // user-email write paths must not drift into four wordings.
      expect(res.body.detail).toBe("email must be a valid email address.");
      expect(res.body.instance).toBe("/setup/first-admin");
      expect(await stillNeedsSetup()).toBe(true);
    });

    it("422s on a whitespace-only email (non-empty string, but not an address)", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ ...VALID_BODY, email: "   " });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await stillNeedsSetup()).toBe(true);
    });

    it("422s on an address carrying a CRLF header-injection payload", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ ...VALID_BODY, email: "admin@loombre.local\r\nBcc: evil@example.test" });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await stillNeedsSetup()).toBe(true);
    });

    it("trims a whitespace-padded address instead of storing the padding (R-F4 parity)", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ ...VALID_BODY, email: "  wizard-admin@loombre.local  " });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.user.email).toBe("wizard-admin@loombre.local");
    });

    it("still 422s on a non-string email (guard, unchanged)", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ ...VALID_BODY, email: 42 });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.detail).toBe("email is required.");
      expect(await stillNeedsSetup()).toBe(true);
    });

    it("still accepts an ordinary address (guard, unchanged)", async () => {
      const res = await request(app.getHttpServer())
        .post("/setup/first-admin")
        .send({ ...VALID_BODY, email: "wizard-admin@loombre.local" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.user.email).toBe("wizard-admin@loombre.local");
    });
  });

  describe("byte-identical 404 once the instance is configured (P1 restricted-404 pattern)", () => {
    it("matches NotFoundController's *splat catch-all body EXACTLY, byte for byte", async () => {
      const firstAdmin = await request(app.getHttpServer()).post("/setup/first-admin").send({
        username: "wizard-admin",
        email: "wizard-admin@loombre.local",
        password: "correct-horse-battery-staple",
      });
      expect(firstAdmin.status).toBe(201);
      const adminToken: string = firstAdmin.body.tokens.accessToken;

      const secondCreate = await request(app.getHttpServer()).post("/setup/first-admin").send({
        username: "someone-else",
        email: "someone-else@loombre.local",
        password: "another-long-enough-password",
      });
      // The catch-all itself sits BEHIND AuthGuard (it is not in
      // PUBLIC_ROUTES — only the literal, documented routes are) — an
      // unauthenticated hit never reaches NotFoundController's handler at
      // all, it gets AuthGuard's 401 wall first. A valid Bearer token is
      // required to observe the REAL catch-all body this test compares
      // against; POST /setup/first-admin's own 404 above needs no such
      // token because it is registered public.
      const unknownRoute = await request(app.getHttpServer())
        .get("/this-route-does-not-exist-at-all")
        .set("Authorization", `Bearer ${adminToken}`);
      // adi-F3: the catch-all's 404 ON THIS SAME PATH is the comparison
      // that carries the anti-enumeration meaning — the inert POST and an
      // unrouted method at the identical URL, byte for byte, `instance`
      // included. The cross-path probe above can only be identical apart
      // from `instance` (which is the caller's own path, by design).
      const sameRouteWrongMethod = await request(app.getHttpServer())
        .get("/setup/first-admin")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(unknownRoute.status).toBe(404);
      expectSharedNotFoundProblem(secondCreate, "/setup/first-admin");
      expect(secondCreate.headers["content-type"]).toBe(sameRouteWrongMethod.headers["content-type"]);
      // Literal byte-for-byte body equality — not just schema-valid shape.
      expect(secondCreate.text).toBe(sameRouteWrongMethod.text);
      expectSameNotFoundBodyApartFromInstance(secondCreate, unknownRoute);
    });

    it("a bodyless POST after the instance is configured is STILL 404, never 422 (existence check wins first)", async () => {
      const firstAdmin = await request(app.getHttpServer()).post("/setup/first-admin").send({
        username: "wizard-admin",
        email: "wizard-admin@loombre.local",
        password: "correct-horse-battery-staple",
      });
      expect(firstAdmin.status).toBe(201);

      const res = await request(app.getHttpServer()).post("/setup/first-admin").send();
      expect(res.status).toBe(404);
    });
  });

  describe("race safety: concurrent calls against an empty table", () => {
    it("two concurrent POSTs: exactly one 201, exactly one 404", async () => {
      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post("/setup/first-admin")
          .send({ username: "race-a", email: "race-a@loombre.local", password: "correct-horse-battery-a" }),
        request(app.getHttpServer())
          .post("/setup/first-admin")
          .send({ username: "race-b", email: "race-b@loombre.local", password: "correct-horse-battery-b" }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 404]);

      const state = await request(app.getHttpServer()).get("/setup/state");
      expect(state.body).toEqual({ needsSetup: false });
    });

    it("ten concurrent POSTs: exactly one 201, the rest 404", async () => {
      const requests = Array.from({ length: 10 }, (_, i) =>
        request(app.getHttpServer())
          .post("/setup/first-admin")
          .send({
            username: `race-many-${i}`,
            email: `race-many-${i}@loombre.local`,
            password: `correct-horse-battery-${i}`,
          }),
      );
      const results = await Promise.all(requests);
      const created = results.filter((r) => r.status === 201);
      const notFound = results.filter((r) => r.status === 404);

      expect(created).toHaveLength(1);
      expect(notFound).toHaveLength(9);
    });
  });
});

describe("setup mode is unaffected by the auth-only gate-1 disclosure (api-restricted-leak-F1)", () => {
  beforeEach(resetEmpty);

  // The owner ruling (2026-08-24) moved GET /system/capabilities's
  // `restricted-content` entry behind auth. The one pre-auth-looking web
  // consumer is the wizard's RestrictedStep
  // (apps/web/src/app/setup/_components/RestrictedStep.tsx), which reads the
  // flag to decide between its "capability-off" copy and the opt-in form —
  // but it mounts AFTER AdminStep applied the first-admin TokenPair to the
  // auth store, so its read is authenticated and unchanged. This pins both
  // halves of that claim against the real empty-instance flow.
  it("before the first admin exists the anonymous report omits it; the wizard's own token still sees it", async () => {
    const anonymous = await request(app.getHttpServer()).get("/system/capabilities");
    expect(anonymous.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(anonymous.body.details, "restricted-content")).toBe(false);

    const created = await request(app.getHttpServer()).post("/setup/first-admin").send({
      username: "wizard-admin",
      email: "wizard-admin@loombre.local",
      password: "correct-horse-battery-staple",
    });
    expect(created.status).toBe(201);

    const asWizard = await request(app.getHttpServer())
      .get("/system/capabilities")
      .set("Authorization", `Bearer ${created.body.tokens.accessToken}`);
    expect(asWizard.status).toBe(200);
    expect(typeof asWizard.body.details["restricted-content"].enabled).toBe("boolean");
  });
});
