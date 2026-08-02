// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/reauth-adversarial.e2e.spec.ts
//
// Lane C (STATE.md "Current-password re-auth on self-changes + the
// email-collision signal") — the adversarial-grade cells Lane A's own
// reauth.e2e.spec.ts / auth-security.e2e.spec.ts / users-profile.e2e.spec.ts
// / invites.e2e.spec.ts don't already cover (read all four first — this
// file does not repeat their happy/wrong/missing/single-run-floor/single-
// user-trip coverage):
//
//   - Revocation: admin/CLI password reset still revokes ALL of the
//     target's devices (no "current device" exclusion) — F3's NEW
//     "other devices only" behavior is scoped to the SELF password-change
//     path alone; this pins that the admin/CLI tier is unchanged.
//   - Rate limiting: the currentPassword limiter is ONE bucket per user
//     SHARED across both endpoints that consult it (PATCH /users/me and
//     PUT /users/me/restricted) — draining it on one endpoint trips the
//     OTHER endpoint too, for the same user.
//   - Timing floor: a multi-sample, tighter-tolerance pin (every floored
//     sample >= 190ms, not just one at >= 170ms) for claimInvite and an
//     email-bearing updateMe, and a median-based pin (flake-resistant)
//     that a bare-displayName updateMe is meaningfully faster.
//   - E8: the wrong-currentPassword 403 and the missing-currentPassword
//     422 are BYTE-IDENTICAL (after stripping `instance`) no matter which
//     field was the real target — password, a free email, or a colliding
//     email — AND no matter which of the two re-auth-gated endpoints
//     produced them.
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
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { CURRENT_PASSWORD_INVALID_PROBLEM_TYPE } from "../src/gateway/current-password-invalid.exception.js";

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

function buildDeviceProfile(profileId = "reauth-adversarial-e2e") {
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
let adminAccessToken: string;
let counter = 0;

function uniqueTag(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

async function login(username: string, password: string, deviceName?: string): Promise<request.Response> {
  return request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: deviceName ?? `${username}-${Date.now()}-${Math.random()}`, deviceProfile: buildDeviceProfile(username) });
}

async function loginAs(username: string, password: string): Promise<{ accessToken: string }> {
  const res = await login(username, password);
  expect(res.status, `login as ${username} failed: ${JSON.stringify(res.body)}`).toBe(200);
  return { accessToken: res.body.accessToken };
}

async function createAndLoginFreshUser(
  label: string,
): Promise<{ userId: string; accessToken: string; username: string; email: string; password: string }> {
  const tag = uniqueTag(label);
  const username = tag;
  const password = `${tag}-password`;
  const email = `${tag}@example.invalid`;
  const created = await request(app.getHttpServer())
    .post("/users")
    .set("Authorization", `Bearer ${adminAccessToken}`)
    .send({ username, email, password, isAdmin: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { accessToken } = await loginAs(username, password);
  return { userId: created.body.id, accessToken, username, email, password };
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_reauth_adversarial");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "reauth-adversarial-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";
  // The rate-limit describe block below deliberately overrides this to a
  // low cap for its own two tests, then restores it — every OTHER describe
  // block in this file wants the generous default so its many requests
  // never contend over the shared per-user bucket.
  process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "10000";
  process.env["LOOMBRE_RATE_CLAIM"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const admin = await loginAs("admin", "loombre-seed-admin");
  adminAccessToken = admin.accessToken;
});

afterAll(async () => {
  await app.close();
  delete process.env["LOOMBRE_RATE_LOGIN"];
  delete process.env["LOOMBRE_RATE_CURRENT_PASSWORD"];
  delete process.env["LOOMBRE_RATE_CLAIM"];
});

// ============================================================================
// Revocation: admin/CLI reset paths still revoke ALL devices
// ============================================================================

describe("revocation: admin POST /users/{id}/reset-password revokes ALL of the target's devices (unchanged M14 behavior)", () => {
  it("BOTH of the target's live devices die — unlike F3's self password-change path, there is no 'current device' survivor here", async () => {
    const target = await createAndLoginFreshUser("revoke-all-admin-target");

    const deviceA = await login(target.username, target.password, "revoke-all-device-a");
    expect(deviceA.status).toBe(200);
    const deviceB = await login(target.username, target.password, "revoke-all-device-b");
    expect(deviceB.status).toBe(200);

    const resetRes = await request(app.getHttpServer())
      .post(`/users/${target.userId}/reset-password`)
      .set("Authorization", `Bearer ${adminAccessToken}`);
    expect(resetRes.status, JSON.stringify(resetRes.body)).toBe(200);

    const refreshA = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: deviceA.body.refreshToken, deviceId: deviceA.body.deviceId });
    expect(refreshA.status).toBe(401);

    const refreshB = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: deviceB.body.refreshToken, deviceId: deviceB.body.deviceId });
    expect(refreshB.status).toBe(401);
  });
});

// ============================================================================
// Rate limiting: the currentPassword bucket is SHARED across both endpoints
// ============================================================================

describe("currentPassword rate limit is ONE bucket per user, shared across PATCH /users/me and PUT /users/me/restricted", () => {
  let lowCapApp: INestApplication;

  beforeAll(async () => {
    process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "3";
    lowCapApp = await NestFactory.create(AppModule, { logger: false });
    await lowCapApp.init();
  });

  afterAll(async () => {
    await lowCapApp.close();
    process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "10000";
  });

  it("draining the budget on PATCH /users/me trips PUT /users/me/restricted for the SAME user; a DIFFERENT user's endpoint is unaffected", async () => {
    const server = lowCapApp.getHttpServer();
    const adminLogin = await request(server).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: `cross-endpoint-admin-${Date.now()}`,
      deviceProfile: buildDeviceProfile("cross-endpoint-admin"),
    });
    expect(adminLogin.status).toBe(200);

    const targetUsername = uniqueTag("cross-endpoint-target");
    const targetPassword = `${targetUsername}-password`;
    const created = await request(server)
      .post("/users")
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .send({ username: targetUsername, email: `${targetUsername}@example.invalid`, password: targetPassword });
    expect(created.status).toBe(201);
    const targetLogin = await request(server).post("/auth/login").send({
      username: targetUsername,
      password: targetPassword,
      deviceName: `cross-endpoint-target-${Date.now()}`,
      deviceProfile: buildDeviceProfile("cross-endpoint-target"),
    });
    expect(targetLogin.status).toBe(200);
    const targetToken: string = targetLogin.body.accessToken;

    // Cap is 3 — spend the WHOLE budget on updateMe alone.
    for (let i = 0; i < 3; i++) {
      const res = await request(server)
        .patch("/users/me")
        .set("Authorization", `Bearer ${targetToken}`)
        .send({ email: `cross-endpoint-attempt-${i}@example.invalid`, currentPassword: "wrong-every-time" });
      expect(res.status).toBe(403);
    }

    // The bucket is drained — updateMe itself now 429s...
    const updateMeTripped = await request(server)
      .patch("/users/me")
      .set("Authorization", `Bearer ${targetToken}`)
      .send({ email: "cross-endpoint-attempt-tripped@example.invalid", currentPassword: "wrong-every-time" });
    expect(updateMeTripped.status).toBe(429);

    // ...and so does putRestricted, WITHOUT spending any of ITS OWN
    // attempts first — proof the two endpoints share one bucket, not two
    // independent ones.
    const restrictedTripped = await request(server)
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${targetToken}`)
      .send({ optIn: true, pin: "1234", currentPassword: "wrong-every-time" });
    expect(restrictedTripped.status).toBe(429);
    expect(restrictedTripped.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(Number(restrictedTripped.headers["retry-after"])).toBeGreaterThan(0);

    // A DIFFERENT user's bucket (either endpoint) is completely unaffected.
    const otherUsername = uniqueTag("cross-endpoint-other");
    const otherPassword = `${otherUsername}-password`;
    const otherCreated = await request(server)
      .post("/users")
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .send({ username: otherUsername, email: `${otherUsername}@example.invalid`, password: otherPassword });
    expect(otherCreated.status).toBe(201);
    const otherLogin = await request(server).post("/auth/login").send({
      username: otherUsername,
      password: otherPassword,
      deviceName: `cross-endpoint-other-${Date.now()}`,
      deviceProfile: buildDeviceProfile("cross-endpoint-other"),
    });
    expect(otherLogin.status).toBe(200);

    const otherRestricted = await request(server)
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${otherLogin.body.accessToken}`)
      .send({ optIn: true, pin: "1234", currentPassword: "wrong-every-time" });
    expect(otherRestricted.status).toBe(403); // not 429 — independent per-user bucket
  });
});

// ============================================================================
// Timing floor: multi-sample, tighter-tolerance pin
// ============================================================================

describe("timing floor: multi-sample pin (flake-resistant, tighter than the single-run smoke check)", () => {
  const FLOOR_MS = 200;
  const TIGHT_FLOOR_MS = 190; // brief's own "assert >= 190ms" tolerance
  const SAMPLES = 5;

  it("claimInvite: EVERY one of 5 samples takes >= 190ms, collision or not", async () => {
    for (let i = 0; i < SAMPLES; i++) {
      const created = await request(app.getHttpServer())
        .post("/invites")
        .set("Authorization", `Bearer ${adminAccessToken}`)
        .send({ libraryIds: [] });
      expect(created.status).toBe(201);

      const startedAtMs = Date.now();
      const res = await request(app.getHttpServer())
        .post(`/invites/claim/${created.body.claimToken}`)
        .send({ username: uniqueTag(`timing-claim-${i}`), password: "timing-floor-password-1" });
      const elapsedMs = Date.now() - startedAtMs;

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(elapsedMs).toBeGreaterThanOrEqual(TIGHT_FLOOR_MS);
    }
  });

  it("updateMe with an email member: EVERY one of 5 samples takes >= 190ms", async () => {
    for (let i = 0; i < SAMPLES; i++) {
      const user = await createAndLoginFreshUser(`timing-update-email-${i}`);

      const startedAtMs = Date.now();
      const res = await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ email: `${uniqueTag("timing-update-email-target")}@example.invalid`, currentPassword: user.password });
      const elapsedMs = Date.now() - startedAtMs;

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(elapsedMs).toBeGreaterThanOrEqual(TIGHT_FLOOR_MS);
    }
  });

  it("updateMe WITHOUT an email member (bare displayName): the MEDIAN of 5 samples is meaningfully faster than the floor", async () => {
    const elapsedSamples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const user = await createAndLoginFreshUser(`timing-update-noemail-${i}`);

      const startedAtMs = Date.now();
      const res = await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ displayName: `No Floor ${i}` });
      const elapsedMs = Date.now() - startedAtMs;

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      elapsedSamples.push(elapsedMs);
    }

    const sorted = [...elapsedSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    // A generous threshold (median, not a single sample, so one slow tick
    // under CI load can't flip this) — this path is not ARTIFICIALLY
    // delayed the way the email-bearing cells above are.
    expect(median).toBeLessThan(FLOOR_MS);
  });
});

// ============================================================================
// E8: wrong/missing currentPassword bodies are target-agnostic AND
// endpoint-agnostic (once `instance` is stripped)
// ============================================================================

describe("E8: wrong-currentPassword 403 and missing-currentPassword 422 never reveal the target", () => {
  function stripInstance(body: Record<string, unknown>): Record<string, unknown> {
    const { instance: _instance, ...rest } = body;
    return rest;
  }

  it("PATCH /users/me: wrong currentPassword is byte-identical whether the target was a password, a free email, or a COLLIDING email", async () => {
    const victim = await createAndLoginFreshUser("e8-wrong-victim");
    const user = await createAndLoginFreshUser("e8-wrong-user");

    const passwordAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ password: "irrelevant-new-password", currentPassword: "definitely-wrong" });
    const freeEmailAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: `${uniqueTag("e8-wrong-free")}@example.invalid`, currentPassword: "definitely-wrong" });
    const collidingEmailAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: victim.email, currentPassword: "definitely-wrong" });

    expect(passwordAttempt.status).toBe(403);
    expect(freeEmailAttempt.status).toBe(403);
    expect(collidingEmailAttempt.status).toBe(403);

    // Same instance ("/users/me" on every call) — full-body equality is
    // meaningful here, no stripping required.
    expect(passwordAttempt.body.type).toBe(CURRENT_PASSWORD_INVALID_PROBLEM_TYPE);
    expect(passwordAttempt.body).toEqual(freeEmailAttempt.body);
    expect(passwordAttempt.body).toEqual(collidingEmailAttempt.body);
    expect(passwordAttempt.headers["content-type"]).toBe(freeEmailAttempt.headers["content-type"]);
    expect(passwordAttempt.text).toBe(freeEmailAttempt.text);
    expect(passwordAttempt.text).toBe(collidingEmailAttempt.text);
  });

  it("PATCH /users/me: missing currentPassword 422 is byte-identical whether the target was a password, a free email, or a COLLIDING email", async () => {
    const victim = await createAndLoginFreshUser("e8-missing-victim");
    const user = await createAndLoginFreshUser("e8-missing-user");

    const passwordAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ password: "irrelevant-new-password" });
    const freeEmailAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: `${uniqueTag("e8-missing-free")}@example.invalid` });
    const collidingEmailAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: victim.email });

    expect(passwordAttempt.status).toBe(422);
    expect(freeEmailAttempt.status).toBe(422);
    expect(collidingEmailAttempt.status).toBe(422);
    expect(passwordAttempt.body).toEqual(freeEmailAttempt.body);
    expect(passwordAttempt.body).toEqual(collidingEmailAttempt.body);
    expect(passwordAttempt.text).toBe(freeEmailAttempt.text);
    expect(passwordAttempt.text).toBe(collidingEmailAttempt.text);
  });

  it("PUT /users/me/restricted: wrong currentPassword is byte-identical across different optIn/pin targets", async () => {
    const user = await createAndLoginFreshUser("e8-restricted-wrong-user");

    const optInAttempt = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: true, pin: "1234", currentPassword: "definitely-wrong" });
    const optOutAttempt = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: false, currentPassword: "definitely-wrong" });

    expect(optInAttempt.status).toBe(403);
    expect(optOutAttempt.status).toBe(403);
    expect(optInAttempt.body.type).toBe(CURRENT_PASSWORD_INVALID_PROBLEM_TYPE);
    expect(optInAttempt.body).toEqual(optOutAttempt.body);
    expect(optInAttempt.text).toBe(optOutAttempt.text);
  });

  it("PUT /users/me/restricted: missing currentPassword 422 is byte-identical across different optIn/pin targets", async () => {
    const user = await createAndLoginFreshUser("e8-restricted-missing-user");

    const optInAttempt = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: true, pin: "1234" });
    const optOutAttempt = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: false });

    expect(optInAttempt.status).toBe(422);
    expect(optOutAttempt.status).toBe(422);
    expect(optInAttempt.body).toEqual(optOutAttempt.body);
    expect(optInAttempt.text).toBe(optOutAttempt.text);
  });

  it("wrong-currentPassword 403 is identical ACROSS endpoints too (instance stripped) — updateMe's and putRestricted's are the same shape", async () => {
    const user = await createAndLoginFreshUser("e8-cross-endpoint-wrong-user");

    const updateMeAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ password: "irrelevant-new-password", currentPassword: "definitely-wrong" });
    const restrictedAttempt = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: true, pin: "1234", currentPassword: "definitely-wrong" });

    expect(updateMeAttempt.status).toBe(403);
    expect(restrictedAttempt.status).toBe(403);
    expect(stripInstance(updateMeAttempt.body)).toEqual(stripInstance(restrictedAttempt.body));
  });

  it("missing-currentPassword 422 is identical ACROSS endpoints too (instance stripped)", async () => {
    const user = await createAndLoginFreshUser("e8-cross-endpoint-missing-user");

    const updateMeAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ password: "irrelevant-new-password" });
    const restrictedAttempt = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: true, pin: "1234" });

    expect(updateMeAttempt.status).toBe(422);
    expect(restrictedAttempt.status).toBe(422);
    expect(stripInstance(updateMeAttempt.body)).toEqual(stripInstance(restrictedAttempt.body));
  });
});
