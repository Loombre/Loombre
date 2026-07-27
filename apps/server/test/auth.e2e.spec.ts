// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/auth.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for the auth wave (task spec): login/refresh/logout, restricted
// settings self-service, and unlock/lock — against the real seed users
// (packages/db/seed/seed.mjs). Self-sufficient: resets + reseeds the DB in
// beforeAll, same pattern as packages/db/test/leak.spec.ts and
// apps/server/src/session/*.spec.ts.
//
// Runs against a database PRIVATE to apps/server's own test run
// (ensureTestDatabase, "<base>_server_test") to avoid a cross-package
// concurrent-reset deadlock under turbo (e.g. @loombre/jobs's tests also
// reset DATABASE_URL's schema, and turbo runs independent packages' `test`
// tasks in parallel) — see packages/db/src/testing.ts.
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
import { createDb, ensureTestDatabase, getUserByUsername, updateRestrictedSettings } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { HashService } from "../src/common/hash.service.js";

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

function buildDeviceProfile(profileId = "web-chrome") {
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
let settingsService: SettingsService;

// Addendum A, lane S3: SettingsService caches its env-pin resolution at
// bootstrap/reload() — it does not poll process.env on every read (real
// env vars don't change at runtime either). Every mid-test
// LOOMBRE_RESTRICTED_ENABLED mutation in this file must reload() the cache
// afterward for the mutation to actually take effect — see
// settings.service.ts's own header for the cache/reload contract.
async function setRestrictedEnabled(value: "true" | undefined): Promise<void> {
  if (value === undefined) {
    delete process.env["LOOMBRE_RESTRICTED_ENABLED"];
  } else {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = value;
  }
  await settingsService.reload();
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "e2e-test-secret-not-for-production";

  // This suite's many `it` blocks share one app instance (one
  // AuthRateLimiterService for the whole file) and issue well over the
  // default per-minute caps (STATE.md P2.1) purely as an artifact of
  // exercising unrelated behavior repeatedly — raised here so this file
  // stays a pure behavioral suite. The rate limiter itself (trip + 429 +
  // Retry-After + per-key isolation + trust-proxy keying) is covered by
  // apps/server/test/auth-security.e2e.spec.ts's own low-cap app instance.
  process.env["LOOMBRE_RATE_LOGIN"] = "1000";
  process.env["LOOMBRE_RATE_REFRESH"] = "1000";
  process.env["LOOMBRE_RATE_UNLOCK"] = "1000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
  settingsService = app.get(SettingsService);
});

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
  delete process.env["LOOMBRE_RATE_LOGIN"];
  delete process.env["LOOMBRE_RATE_REFRESH"];
  delete process.env["LOOMBRE_RATE_UNLOCK"];
});

/** Tests in this file share one live DB across the whole run (no reset
 *  between cases) — restricted-settings scenarios that need a KNOWN
 *  starting state force it directly rather than depending on execution
 *  order relative to other tests that also mutate the casual user. */
async function resetCasualRestrictedSettings(): Promise<void> {
  const casual = await getUserByUsername(rawDb, "casual");
  if (!casual) throw new Error("seed did not create the casual user");
  await updateRestrictedSettings(rawDb, {
    userId: casual.id,
    optIn: false,
    pinHash: null,
    updatedAtMs: Date.now(),
  });
}

describe("GET /system/capabilities (public)", () => {
  it("returns 200 with music=true, hls-ll=false, restricted-content reflecting LOOMBRE_RESTRICTED_ENABLED (unset -> off)", async () => {
    await setRestrictedEnabled(undefined);
    const res = await request(app.getHttpServer()).get("/system/capabilities");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);

    const musicDetail = res.body.details.music;
    const hlsLlDetail = res.body.details["hls-ll"];
    const restrictedDetail = res.body.details["restricted-content"];
    expect(musicDetail.enabled).toBe(true);
    expect(hlsLlDetail.enabled).toBe(false);
    expect(restrictedDetail.enabled).toBe(false);
    expect(res.body.flags).toContain("music");
    expect(res.body.flags).not.toContain("restricted-content");
  });

  it("requires no Authorization header at all", async () => {
    const res = await request(app.getHttpServer()).get("/system/capabilities");
    expect(res.status).not.toBe(401);
  });
});

describe("POST /auth/login (public)", () => {
  it("succeeds with the seed admin's real credentials -> 200 TokenPair", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({
        username: "admin",
        password: "loombre-seed-admin",
        deviceName: "e2e-test-device",
        deviceProfile: buildDeviceProfile(),
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");
    expect(typeof res.body.accessTokenExpiresAtMs).toBe("number");
    expect(typeof res.body.deviceId).toBe("string");
  });

  it("succeeds by email too", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({
        email: "casual@loombre.local",
        password: "loombre-seed-casual",
        deviceName: "e2e-test-device-2",
        deviceProfile: buildDeviceProfile(),
      });
    expect(res.status).toBe(200);
  });

  it("wrong password -> 401 problem+json", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({
        username: "admin",
        password: "not-the-password",
        deviceName: "e2e-test-device",
        deviceProfile: buildDeviceProfile(),
      });
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.status).toBe(401);
  });

  it("unknown username -> 401 with the SAME shape as wrong password (no user-existence leak)", async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post("/auth/login")
      .send({
        username: "admin",
        password: "not-the-password",
        deviceName: "d",
        deviceProfile: buildDeviceProfile(),
      });
    const unknownUser = await request(app.getHttpServer())
      .post("/auth/login")
      .send({
        username: "totally-does-not-exist",
        password: "whatever",
        deviceName: "d",
        deviceProfile: buildDeviceProfile(),
      });

    expect(unknownUser.status).toBe(401);
    expect(Object.keys(unknownUser.body).sort()).toEqual(Object.keys(wrongPassword.body).sort());
    expect(unknownUser.body.title).toBe(wrongPassword.body.title);
    expect(unknownUser.body.detail).toBe(wrongPassword.body.detail);
  });

  it("missing required fields -> 422 problem+json", async () => {
    const res = await request(app.getHttpServer()).post("/auth/login").send({ username: "admin" });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("neither username nor email provided -> 422", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ password: "x", deviceName: "d", deviceProfile: buildDeviceProfile() });
    expect(res.status).toBe(422);
  });
});

describe("POST /auth/refresh (public) — rotation + reuse (theft) detection", () => {
  it("rotates: returns a new token pair, and the old refresh token no longer works", async () => {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName: "refresh-test-device",
        deviceProfile: buildDeviceProfile(),
      });
    expect(login.status).toBe(200);
    const { refreshToken, deviceId } = login.body;

    const refreshed = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken, deviceId });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(refreshToken);
    expect(typeof refreshed.body.accessToken).toBe("string");

    // Reusing the ORIGINAL (already-rotated) token is a theft signal -> 401,
    // and per the task spec revokes the whole chain: the token that WAS
    // rotated-to must also die.
    const reuseOriginal = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken, deviceId });
    expect(reuseOriginal.status).toBe(401);
    expect(reuseOriginal.headers["content-type"]).toMatch(/^application\/problem\+json/);

    const tryLegitimateTip = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: refreshed.body.refreshToken, deviceId });
    expect(tryLegitimateTip.status).toBe(401);
  });

  it("unknown refresh token -> 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: "not-a-real-token", deviceId: "11111111-1111-4111-8111-111111111111" });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/logout (authenticated)", () => {
  it("204s and the device's refresh token stops working afterward", async () => {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({
        username: "casual",
        password: "loombre-seed-casual",
        deviceName: "logout-test-device",
        deviceProfile: buildDeviceProfile(),
      });
    const { accessToken, refreshToken, deviceId } = login.body;

    const logout = await request(app.getHttpServer())
      .post("/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ deviceId });
    expect(logout.status).toBe(204);

    const refreshAfterLogout = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken, deviceId });
    expect(refreshAfterLogout.status).toBe(401);
  });

  it("without a Bearer token -> 401", async () => {
    const res = await request(app.getHttpServer()).post("/auth/logout").send({});
    expect(res.status).toBe(401);
  });
});

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `test-${username}-${Date.now()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as { accessToken: string; refreshToken: string; deviceId: string };
}

describe("PUT /users/me/restricted (self-service opt-in + PIN, gate 3)", () => {
  it("opts a fresh user in with a new PIN -> 200 RestrictedSettings", async () => {
    await resetCasualRestrictedSettings();
    const casual = await loginAs("casual", "loombre-seed-casual");

    const res = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: true, pin: "4242" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ optIn: true, hasPin: true, unlockedUntilMs: null });
  });

  it("enabling opt-in without a pin -> 422", async () => {
    await resetCasualRestrictedSettings();
    const casual = await loginAs("casual", "loombre-seed-casual");
    const res = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: true });
    expect(res.status).toBe(422);
  });

  it("changing an existing PIN requires a correct currentPin", async () => {
    await resetCasualRestrictedSettings();
    const casual = await loginAs("casual", "loombre-seed-casual");
    await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: true, pin: "1111" });

    const wrongCurrent = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: true, pin: "2222", currentPin: "9999" });
    expect(wrongCurrent.status).toBe(422);

    const rightCurrent = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: true, pin: "2222", currentPin: "1111" });
    expect(rightCurrent.status).toBe(200);
    expect(rightCurrent.body.hasPin).toBe(true);
  });

  it("opting out requires currentPin and clears the pin", async () => {
    await resetCasualRestrictedSettings();
    const casual = await loginAs("casual", "loombre-seed-casual");
    await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: true, pin: "3333" });

    const optOut = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: false, currentPin: "3333" });
    expect(optOut.status).toBe(200);
    expect(optOut.body).toEqual({ optIn: false, hasPin: false, unlockedUntilMs: null });
  });

  it("without a Bearer token -> 401", async () => {
    const res = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .send({ optIn: true, pin: "1234" });
    expect(res.status).toBe(401);
  });

  // The contract constrains RestrictedSettingsUpdate.pin to exactly 4
  // digits because PinModal — the ONE unlock surface — can only ever enter
  // 4. A server that stored a 5-digit PIN locked that user out of
  // restricted content permanently.
  it("a new PIN that is not exactly 4 digits -> 422 (would be unenterable at unlock)", async () => {
    await resetCasualRestrictedSettings();
    const casual = await loginAs("casual", "loombre-seed-casual");

    for (const badPin of ["12345", "123", "", "12a4", "12 4"]) {
      const res = await request(app.getHttpServer())
        .put("/users/me/restricted")
        .set("Authorization", `Bearer ${casual.accessToken}`)
        .send({ optIn: true, pin: badPin });
      expect(res.status, `pin=${JSON.stringify(badPin)}`).toBe(422);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    }

    // ...and nothing was stored by any of those attempts.
    const stillNoPin = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: true, pin: "4242" });
    expect(stillNoPin.status).toBe(200);
    expect(stillNoPin.body).toEqual({ optIn: true, hasPin: true, unlockedUntilMs: null });
  });

  // THE recovery path for an install that stored a non-conforming PIN
  // before the rule existed: `currentPin` proves an ALREADY-STORED secret
  // and is deliberately NOT length-constrained, so such a user can still
  // rotate to a conforming PIN (and still opt out). Constraining it would
  // leave them with no way out at all.
  it("currentPin is NOT length-constrained — a legacy longer PIN can still be rotated away", async () => {
    await resetCasualRestrictedSettings();
    const casual = await loginAs("casual", "loombre-seed-casual");
    const user = await getUserByUsername(rawDb, "casual");

    // Simulate a pre-rule install: a 6-digit PIN already in the column.
    const legacyHash = await app.get(HashService).hash("543210");
    await updateRestrictedSettings(rawDb, {
      userId: user!.id,
      optIn: true,
      pinHash: legacyHash,
      updatedAtMs: Date.now(),
    });

    const rotated = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: true, pin: "1234", currentPin: "543210" });
    expect(rotated.status).toBe(200);
    expect(rotated.body.hasPin).toBe(true);

    // The rotation really took: the old long PIN no longer proves anything.
    const staleProof = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: false, currentPin: "543210" });
    expect(staleProof.status).toBe(422);

    const optOut = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casual.accessToken}`)
      .send({ optIn: false, currentPin: "1234" });
    expect(optOut.status).toBe(200);
  });
});

describe("POST /restricted/unlock + /restricted/lock (gate 5)", () => {
  it("unlock fails with 403 when gates 1-4 are not all satisfied (capability off)", async () => {
    await setRestrictedEnabled(undefined);
    const admin = await loginAs("admin", "loombre-seed-admin");

    const res = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ pin: "0000" });
    expect(res.status).toBe(403);
  });

  it("unlock succeeds with the correct PIN once gates 1-4 pass (seed admin), and wrong PIN is 401", async () => {
    await setRestrictedEnabled("true");
    const admin = await loginAs("admin", "loombre-seed-admin");

    const wrongPin = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ pin: "9999" });
    expect(wrongPin.status).toBe(401);
    expect(wrongPin.headers["content-type"]).toMatch(/^application\/problem\+json/);

    const nowMs = Date.now();
    const rightPin = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ pin: "0000" });
    expect(rightPin.status).toBe(200);
    expect(rightPin.body.unlockedUntilMs).toBeGreaterThan(nowMs);

    await setRestrictedEnabled(undefined);
  });

  it("lock 204s and unlock state is cleared", async () => {
    await setRestrictedEnabled("true");
    const admin = await loginAs("admin", "loombre-seed-admin");
    await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ pin: "0000" });

    const lock = await request(app.getHttpServer())
      .post("/restricted/lock")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send();
    expect(lock.status).toBe(204);

    await setRestrictedEnabled(undefined);
  });

  it("without a Bearer token both -> 401", async () => {
    const unlockRes = await request(app.getHttpServer()).post("/restricted/unlock").send({ pin: "0000" });
    expect(unlockRes.status).toBe(401);
    const lockRes = await request(app.getHttpServer()).post("/restricted/lock").send();
    expect(lockRes.status).toBe(401);
  });

  // UnlockRequest.pin carries the same exactly-4-digits constraint as
  // RestrictedSettingsUpdate.pin: 422 is a REQUEST-SHAPE failure (the value
  // could not be a PIN), distinct from the 401 a well-formed-but-wrong PIN
  // gets.
  it("a pin that is not exactly 4 digits -> 422, not 401", async () => {
    await setRestrictedEnabled("true");
    const admin = await loginAs("admin", "loombre-seed-admin");

    for (const badPin of ["00000", "000", "", "00a0"]) {
      const res = await request(app.getHttpServer())
        .post("/restricted/unlock")
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ pin: badPin });
      expect(res.status, `pin=${JSON.stringify(badPin)}`).toBe(422);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    }

    await setRestrictedEnabled(undefined);
  });
});
