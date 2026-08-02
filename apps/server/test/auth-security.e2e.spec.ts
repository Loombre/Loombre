// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/auth-security.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for this wave's Phase-2 auth-hardening deliverable (STATE.md
// P2.1/P2.2/P2.3/P2.12/P2.16):
//   - strict DeviceProfile validation (422 on malformed profiles)
//   - login device-row reuse (own device / unknown deviceId / foreign
//     deviceId, all three branches)
//   - auth rate limits (429 + Retry-After, per-key isolation)
//   - LOOMBRE_TRUST_PROXY: a forwarded request's rate-limit key is the
//     forwarded IP, not the raw socket address
//   - fail2ban-compatible anomaly log lines for failed login, refresh
//     reuse, PIN failure, and rate-limit trips — with secrets never
//     appearing in the log file
//
// This file's app instance is configured with deliberately LOW rate-limit
// caps (LOOMBRE_RATE_LOGIN=3, LOOMBRE_RATE_REFRESH=3, LOOMBRE_RATE_UNLOCK=2)
// and LOOMBRE_TRUST_PROXY=1 so tripping/refill-adjacent HTTP behavior is
// exercisable without real sleeps or a huge request count — the
// underlying token-bucket refill math itself is unit-tested with a fake
// clock in apps/server/src/session/rate-limiter.spec.ts (no real sleeps
// there either). Ordinary behavioral coverage (login/refresh/restricted
// flows) stays in auth.e2e.spec.ts, which raises these same env vars to
// effectively-unlimited so its own, unrelated request volume never trips
// them.
//
// Runs against its OWN private database ("auth_security_test" suffix,
// ensureTestDatabase) — same self-sufficient reset+seed pattern as
// auth.e2e.spec.ts.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase, getUserByUsername } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { applyTrustProxy } from "../src/main.js";
import { SettingsService } from "../src/settings/settings.service.js";

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
    throw new Error(
      `${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function buildDeviceProfile(profileId = "web-chrome"): Record<string, unknown> {
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
let logDir: string;
let logFile: string;
let settingsService: SettingsService;

// Addendum A, lane S3: SettingsService caches its env-pin resolution at
// bootstrap/reload() — see auth.e2e.spec.ts's identical helper for the
// full rationale.
async function setRestrictedEnabled(value: "true" | undefined): Promise<void> {
  if (value === undefined) {
    delete process.env["LOOMBRE_RESTRICTED_ENABLED"];
  } else {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = value;
  }
  await settingsService.reload();
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "auth_security_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "auth-security-test-secret";

  logDir = mkdtempSync(join(tmpdir(), "loombre-auth-security-log-"));
  logFile = join(logDir, "auth-anomaly.log");
  process.env["LOOMBRE_AUTH_LOG_FILE"] = logFile;

  // Deliberately low caps (this file's whole point) + trust-proxy ON so
  // supertest requests can drive per-key isolation via X-Forwarded-For
  // without a real reverse proxy.
  process.env["LOOMBRE_RATE_LOGIN"] = "3";
  process.env["LOOMBRE_RATE_REFRESH"] = "3";
  process.env["LOOMBRE_RATE_UNLOCK"] = "2";
  // G4 (STATE.md "Current-password re-auth on self-changes"): same low-cap
  // posture as login/refresh/unlock above, for the SAME reason — a
  // deliberately small cap makes tripping/refill-adjacent behavior
  // exercisable without real sleeps or a huge request count.
  process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "2";
  process.env["LOOMBRE_TRUST_PROXY"] = "1";

  app = await NestFactory.create(AppModule, { logger: false });
  applyTrustProxy(app, process.env["LOOMBRE_TRUST_PROXY"]);
  await app.init();

  rawDb = createDb(databaseUrl);
  settingsService = app.get(SettingsService);
});

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
  rmSync(logDir, { recursive: true, force: true });
  for (const key of [
    "LOOMBRE_RATE_LOGIN",
    "LOOMBRE_RATE_REFRESH",
    "LOOMBRE_RATE_UNLOCK",
    "LOOMBRE_RATE_CURRENT_PASSWORD",
    "LOOMBRE_AUTH_LOG_FILE",
    "LOOMBRE_TRUST_PROXY",
    "LOOMBRE_RESTRICTED_ENABLED",
  ]) {
    delete process.env[key];
  }
});

function anomalyLogLines(): string[] {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

async function login(
  overrides: Record<string, unknown>,
  forwardedFor: string,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post("/auth/login")
    .set("X-Forwarded-For", forwardedFor)
    .send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "auth-security-test-device",
      deviceProfile: buildDeviceProfile(),
      ...overrides,
    });
}

describe("Strict DeviceProfile validation (P2.3/P2.12)", () => {
  it("a schema-valid web-chrome-shaped profile is accepted", async () => {
    const res = await login({}, "198.51.100.1");
    expect(res.status).toBe(200);
  });

  it("missing a required nested key (hls.container) -> 422 problem+json", async () => {
    const profile = buildDeviceProfile();
    delete (profile["hls"] as Record<string, unknown>)["container"];
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "198.51.100.2")
      .send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName: "d",
        deviceProfile: profile,
      });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("wrong type (maxWidth as a string) -> 422", async () => {
    const profile = buildDeviceProfile();
    (profile["video"] as Array<Record<string, unknown>>)[0]!["maxWidth"] = "not-a-number";
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "198.51.100.3")
      .send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName: "d",
        deviceProfile: profile,
      });
    expect(res.status).toBe(422);
  });

  it("extra/unknown garbage field -> 422", async () => {
    const profile = buildDeviceProfile();
    profile["notInTheSchema"] = "garbage";
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "198.51.100.4")
      .send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName: "d",
        deviceProfile: profile,
      });
    expect(res.status).toBe(422);
  });
});

describe("Login device-row reuse (P2.16)", () => {
  it("reuses the caller's own device row: same deviceId, old refresh token's chain revoked", async () => {
    const first = await login({ deviceName: "reuse-device" }, "198.51.100.10");
    expect(first.status).toBe(200);
    const { deviceId: firstDeviceId, refreshToken: firstRefreshToken } = first.body;

    const second = await login({ deviceName: "reuse-device", deviceId: firstDeviceId }, "198.51.100.10");
    expect(second.status).toBe(200);
    expect(second.body.deviceId).toBe(firstDeviceId);

    // The OLD refresh token's chain was revoked as part of reuse — it must
    // no longer work.
    const refreshOld = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", "198.51.100.10")
      .send({ refreshToken: firstRefreshToken, deviceId: firstDeviceId });
    expect(refreshOld.status).toBe(401);

    // The NEW refresh token from the second login works.
    const refreshNew = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", "198.51.100.11")
      .send({ refreshToken: second.body.refreshToken, deviceId: firstDeviceId });
    expect(refreshNew.status).toBe(200);
  });

  it("an unknown deviceId is ignored — a new device is created, no leak/error", async () => {
    const bogusDeviceId = "00000000-0000-4000-8000-000000000000";
    const res = await login({ deviceName: "unknown-device-id", deviceId: bogusDeviceId }, "198.51.100.20");
    expect(res.status).toBe(200);
    expect(res.body.deviceId).not.toBe(bogusDeviceId);
  });

  it("a deviceId owned by a DIFFERENT user is ignored — a new device is created, existing device untouched", async () => {
    const userA = await login({ deviceName: "user-a-device" }, "198.51.100.30");
    expect(userA.status).toBe(200);
    const deviceIdA = userA.body.deviceId;

    const userB = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "198.51.100.31")
      .send({
        username: "admin",
        password: "loombre-seed-admin",
        deviceName: "user-b-device",
        deviceProfile: buildDeviceProfile(),
        deviceId: deviceIdA,
      });
    expect(userB.status).toBe(200);
    expect(userB.body.deviceId).not.toBe(deviceIdA);

    // User A's device/refresh token must still work — B's login must not
    // have hijacked or revoked it.
    const refreshA = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", "198.51.100.32")
      .send({ refreshToken: userA.body.refreshToken, deviceId: deviceIdA });
    expect(refreshA.status).toBe(200);
  });
});

describe("Anomaly log (P2.1/P2.12): fail2ban-compatible lines, no secrets", () => {
  it("logs FAILED_LOGIN on wrong password, without leaking the password", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "203.0.113.50")
      .send({
        username: "casual",
        password: "definitely-the-wrong-password",
        deviceName: "anomaly-log-test",
        deviceProfile: buildDeviceProfile(),
      });
    expect(res.status).toBe(401);

    const lines = anomalyLogLines();
    const failedLoginLine = lines.find((l) => l.includes("FAILED_LOGIN") && l.includes("ip=203.0.113.50"));
    expect(failedLoginLine).toBeDefined();
    expect(failedLoginLine).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z loombre-auth FAILED_LOGIN /);
    expect(failedLoginLine).not.toContain("definitely-the-wrong-password");
  });

  it("logs REFRESH_REUSE on a replayed (already-rotated) refresh token", async () => {
    const loginRes = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "203.0.113.60")
      .send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName: "reuse-anomaly-device",
        deviceProfile: buildDeviceProfile(),
      });
    const { refreshToken, deviceId } = loginRes.body;

    await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", "203.0.113.61")
      .send({ refreshToken, deviceId });

    // Replay the ORIGINAL (now-rotated) token — theft signal.
    const reuse = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", "203.0.113.62")
      .send({ refreshToken, deviceId });
    expect(reuse.status).toBe(401);

    const lines = anomalyLogLines();
    expect(lines.some((l) => l.includes("REFRESH_REUSE") && l.includes("ip=203.0.113.62"))).toBe(true);
  });

  // Runs BEFORE the "Auth rate limits" describe block below on purpose:
  // this is the ONLY seed user that can reach gates-1-4-pass (admin has a
  // birth_date, restricted opt-in + PIN, and a restricted library grant —
  // casual has none of those, see packages/db/seed/seed.mjs), so it must
  // use admin's unlock rate-limit budget (cap 2 for this file) BEFORE the
  // dedicated rate-limit-trip test below spends the rest of it.
  it("logs PIN_FAILURE on a wrong PIN, without leaking the PIN", async () => {
    await setRestrictedEnabled("true");
    const admin = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "203.0.113.70")
      .send({
        username: "admin",
        password: "loombre-seed-admin",
        deviceName: "pin-failure-anomaly-device",
        deviceProfile: buildDeviceProfile(),
      });

    const res = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${admin.body.accessToken}`)
      .send({ pin: "9999" }); // wrong — seed PIN is "0000"
    expect(res.status).toBe(401);
    await setRestrictedEnabled(undefined);

    const lines = anomalyLogLines();
    const pinFailureLine = lines.find((l) => l.includes("PIN_FAILURE"));
    expect(pinFailureLine).toBeDefined();
    expect(pinFailureLine).not.toContain("9999");
    expect(pinFailureLine).not.toMatch(/pin=/i);
  });

  it("one event per line across the whole run — the log file is never corrupted by concurrent appends", () => {
    const lines = anomalyLogLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z loombre-auth \S+/);
    }
  });
});

describe("Auth rate limits (P2.1/P2.12) + LOOMBRE_TRUST_PROXY forwarded-IP keying (P2.2)", () => {
  it("login: trips 429 + Retry-After after LOOMBRE_RATE_LOGIN attempts from one forwarded IP; a DIFFERENT forwarded IP is unaffected", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 3; i++) {
      const res = await login({ deviceName: `rate-limit-login-${i}` }, ip);
      expect(res.status).toBe(200);
    }
    const tripped = await login({ deviceName: "rate-limit-login-trip" }, ip);
    expect(tripped.status).toBe(429);
    expect(tripped.headers["content-type"]).toMatch(/^application\/problem\+json/);
    const retryAfter = Number(tripped.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);

    // A DIFFERENT forwarded IP is a different bucket entirely — this only
    // holds because LOOMBRE_TRUST_PROXY is on for this app instance, so
    // Express resolves req.ip from X-Forwarded-For rather than the shared
    // loopback socket address every supertest request actually comes from.
    const otherIp = await login({ deviceName: "rate-limit-login-other-ip" }, "203.0.113.11");
    expect(otherIp.status).toBe(200);

    const anomalyLines = anomalyLogLines();
    expect(anomalyLines.some((l) => l.includes("RATE_LIMITED") && l.includes(`ip=${ip}`))).toBe(true);
  });

  it("refresh: trips 429 + Retry-After after LOOMBRE_RATE_REFRESH attempts from one forwarded IP; a DIFFERENT forwarded IP is unaffected", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < 3; i++) {
      const res = await request(app.getHttpServer())
        .post("/auth/refresh")
        .set("X-Forwarded-For", ip)
        .send({ refreshToken: "not-a-real-token", deviceId: "11111111-1111-4111-8111-111111111111" });
      expect(res.status).toBe(401);
    }
    const tripped = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", ip)
      .send({ refreshToken: "not-a-real-token", deviceId: "11111111-1111-4111-8111-111111111111" });
    expect(tripped.status).toBe(429);
    expect(Number(tripped.headers["retry-after"])).toBeGreaterThan(0);

    const otherIp = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", "203.0.113.21")
      .send({ refreshToken: "not-a-real-token", deviceId: "11111111-1111-4111-8111-111111111111" });
    expect(otherIp.status).toBe(401);
  });

  it("unlock: trips 429 + Retry-After per-USER after LOOMBRE_RATE_UNLOCK attempts; a DIFFERENT user is unaffected even from the same IP", async () => {
    await setRestrictedEnabled(undefined);
    const admin = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "203.0.113.40")
      .send({
        username: "admin",
        password: "loombre-seed-admin",
        deviceName: "unlock-rate-limit-admin",
        deviceProfile: buildDeviceProfile(),
      });
    expect(admin.status).toBe(200);

    // Cap is 2 for this file, but admin already spent one token in the
    // "logs PIN_FAILURE" test above (same per-user bucket persists for the
    // whole file/app instance) — so only ONE more attempt is allowed here
    // before the next one trips.
    const first = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${admin.body.accessToken}`)
      .send({ pin: "0000" });
    expect(first.status).toBe(403); // gates 1-4 not satisfied (capability off)

    const second = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${admin.body.accessToken}`)
      .send({ pin: "0000" });
    expect(second.status).toBe(429);
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);

    // A DIFFERENT user (casual), same underlying IP even, has its own budget.
    const casual = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", "203.0.113.40")
      .send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName: "unlock-rate-limit-casual",
        deviceProfile: buildDeviceProfile(),
      });
    const casualUnlock = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${casual.body.accessToken}`)
      .send({ pin: "0000" });
    expect(casualUnlock.status).toBe(403); // not 429 — independent per-user bucket
  });
});

// G3/G4 (STATE.md "Current-password re-auth on self-changes"): the
// CURRENT_PASSWORD_FAILURE anomaly log line and the currentPassword
// rate-limit trip — this file's own low-cap posture (LOOMBRE_RATE_
// CURRENT_PASSWORD=2 above) is exactly what makes tripping exercisable
// without a huge request count, same reason login/refresh/unlock are
// capped low here. Each test creates its OWN fresh user (via an admin
// token) so this describe block never contends with casual/admin's
// buckets from the describes above.
describe("currentPassword re-auth (G3/G4): anomaly log + rate limit", () => {
  async function loginAdmin(ip: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", ip)
      .send({
        username: "admin",
        password: "loombre-seed-admin",
        deviceName: `cp-admin-${ip}`,
        deviceProfile: buildDeviceProfile(),
      });
  }

  async function createAndLoginFreshUser(
    adminAccessToken: string,
    username: string,
    password: string,
    ip: string,
  ): Promise<request.Response> {
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ username, email: `${username}@example.invalid`, password });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    return request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ username, password, deviceName: `${username}-device`, deviceProfile: buildDeviceProfile() });
  }

  it("logs CURRENT_PASSWORD_FAILURE on a wrong currentPassword (PATCH /users/me), without leaking it", async () => {
    const admin = await loginAdmin("203.0.113.90");
    expect(admin.status).toBe(200);

    const target = await createAndLoginFreshUser(
      admin.body.accessToken,
      "cp-failure-target",
      "cp-failure-target-password",
      "203.0.113.91",
    );
    expect(target.status).toBe(200);

    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${target.body.accessToken}`)
      .send({ displayName: "New Name", email: "still-cp-failure-target@example.invalid", currentPassword: "definitely-the-wrong-password" });
    expect(res.status).toBe(403);

    const lines = anomalyLogLines();
    const cpFailureLine = lines.find((l) => l.includes("CURRENT_PASSWORD_FAILURE"));
    expect(cpFailureLine).toBeDefined();
    expect(cpFailureLine).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z loombre-auth CURRENT_PASSWORD_FAILURE /);
    expect(cpFailureLine).not.toContain("definitely-the-wrong-password");
  });

  it("trips 429 + Retry-After after LOOMBRE_RATE_CURRENT_PASSWORD attempts; a DIFFERENT user is unaffected", async () => {
    const admin = await loginAdmin("203.0.113.92");
    expect(admin.status).toBe(200);

    const userA = await createAndLoginFreshUser(
      admin.body.accessToken,
      "cp-trip-user-a",
      "cp-trip-user-a-password",
      "203.0.113.93",
    );
    expect(userA.status).toBe(200);

    // Cap is 2 for this file — two wrong attempts spend the whole budget.
    for (let i = 0; i < 2; i++) {
      const res = await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", `Bearer ${userA.body.accessToken}`)
        .send({ email: `cp-trip-attempt-${i}@example.invalid`, currentPassword: "wrong-every-time" });
      expect(res.status).toBe(403);
    }

    const tripped = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${userA.body.accessToken}`)
      .send({ email: "cp-trip-attempt-tripped@example.invalid", currentPassword: "wrong-every-time" });
    expect(tripped.status).toBe(429);
    expect(tripped.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(Number(tripped.headers["retry-after"])).toBeGreaterThan(0);

    // A DIFFERENT user has an independent bucket — even with a wrong
    // currentPassword, it 403s (not 429).
    const userB = await createAndLoginFreshUser(
      admin.body.accessToken,
      "cp-trip-user-b",
      "cp-trip-user-b-password",
      "203.0.113.93", // same IP as userA — per-USER keying, not per-IP
    );
    expect(userB.status).toBe(200);
    const userBAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${userB.body.accessToken}`)
      .send({ email: "cp-trip-user-b-attempt@example.invalid", currentPassword: "wrong-every-time" });
    expect(userBAttempt.status).toBe(403);

    const anomalyLines = anomalyLogLines();
    expect(anomalyLines.some((l) => l.includes("RATE_LIMITED") && l.includes("op=current-password"))).toBe(true);
  });
});

// Sanity check that the reset+reseed actually ran (guards against a
// silently-empty DB making every test above vacuously fail-open).
describe("fixture sanity", () => {
  it("seed users exist", async () => {
    const admin = await getUserByUsername(rawDb, "admin");
    const casual = await getUserByUsername(rawDb, "casual");
    expect(admin).toBeDefined();
    expect(casual).toBeDefined();
  });
});
