// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/users-profile.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for M1 (users.email optional) and M2 (users.display_name, the
// H1 bug class: the contract's User.displayName was declared and the web
// profile form/AddUserSheet always SUBMITTED it, but no column existed to
// persist it — the value was silently discarded while the UI reported
// "Saved"). This is the round-trip proof: PATCH /users/me displayName ->
// GET /users/me returns it, for real, over HTTP.
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
import { createDb, ensureTestDatabase, readEventsForViewer, type ViewerContext } from "@loombre/db";
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
let adminToken: string;
let rawDb: ReturnType<typeof createDb>;

const ADMIN_PASSWORD = "loombre-seed-admin";

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `users-profile-e2e-${username}-${Date.now()}-${Math.random()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_users_profile");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "users-profile-e2e-test-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";
  // G4 (STATE.md "Current-password re-auth on self-changes"): this file's
  // many `it` blocks share one app instance/limiter and make several
  // password/email PATCH /users/me calls against the SAME admin user —
  // raised here for the same "pure behavioral suite" reason
  // LOOMBRE_RATE_LOGIN is (auth.e2e.spec.ts's identical rationale).
  process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
  adminToken = await loginAs("admin", ADMIN_PASSWORD);
});

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
  delete process.env["LOOMBRE_RATE_LOGIN"];
  delete process.env["LOOMBRE_RATE_CURRENT_PASSWORD"];
});

describe("M2 (H1 bug class): PATCH /users/me displayName -> GET /users/me round trip", () => {
  it("saves for real — the value the UI reports 'Saved' for is actually there on the next read", async () => {
    const before = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${adminToken}`);
    expect(before.status).toBe(200);
    expect(before.body.displayName).toBeNull();

    const patch = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ displayName: "The Admin" });
    expect(patch.status).toBe(200);
    expect(patch.body.displayName).toBe("The Admin");

    const after = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${adminToken}`);
    expect(after.status).toBe(200);
    expect(after.body.displayName).toBe("The Admin");

    // Explicit null clears it again (UpdateMeRequest's declared shape).
    const cleared = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ displayName: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.displayName).toBeNull();
  });
});

// G3 (STATE.md "Current-password re-auth on self-changes"): an email
// member — INCLUDING an explicit `null` to clear — now requires
// currentPassword (G2's dependentRequired). The dedicated re-auth matrix
// (missing/wrong currentPassword, 403/422/429) lives in
// reauth.e2e.spec.ts; this suite still proves the pre-existing M1
// null-to-clear round trip is unchanged once a valid currentPassword is
// supplied.
describe("M1: PATCH /users/me email null-to-clear", () => {
  it("clears email with an explicit null (birthDate precedent) and can set it back", async () => {
    const cleared = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: null, currentPassword: ADMIN_PASSWORD });
    expect(cleared.status).toBe(200);
    expect(cleared.body.email).toBeNull();

    const restored = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "admin@loombre.local", currentPassword: ADMIN_PASSWORD });
    expect(restored.status).toBe(200);
    expect(restored.body.email).toBe("admin@loombre.local");
  });
});

describe("M1: POST /users (admin) — email is optional now", () => {
  it("creates an email-less user (201), and it round-trips as null on GET", async () => {
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username: `email-less-${Date.now()}`, password: "a-fine-password", displayName: "No Email" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.email).toBeNull();
    expect(created.body.displayName).toBe("No Email");

    const fetched = await request(app.getHttpServer())
      .get(`/users/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.email).toBeNull();
  });

  it("login by username works for an email-less user (no email to log in with)", async () => {
    const username = `login-by-username-${Date.now()}`;
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username, password: "a-fine-password" });
    expect(created.status).toBe(201);

    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: "a-fine-password", deviceName: "login-by-username-device", deviceProfile: buildDeviceProfile() });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
  });
});

describe("M1/M2: PATCH /users/{id} (admin) — displayName and email null-clear", () => {
  it("admin can set another user's displayName and clear their email", async () => {
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username: `admin-managed-${Date.now()}`, email: "managed@example.invalid", password: "x" });
    expect(created.status).toBe(201);

    const updated = await request(app.getHttpServer())
      .patch(`/users/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ displayName: "Managed By Admin", email: null });
    expect(updated.status).toBe(200);
    expect(updated.body.displayName).toBe("Managed By Admin");
    expect(updated.body.email).toBeNull();
  });
});

describe("F5 (opus adversarial review, fix wave): PATCH /users/me {password} revokes the caller's OTHER sessions", () => {
  it("a second device's refresh token is revoked; the CALLING device's own refresh token survives; session.revoked-by-password-change is emitted (G5)", async () => {
    const username = `f5-self-password-${Date.now()}`;
    const oldPassword = "correct-horse-battery-old-f5";
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username, email: `${username}@example.invalid`, password: oldPassword });
    expect(created.status).toBe(201);

    const deviceA = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: oldPassword, deviceName: "f5-device-a", deviceProfile: buildDeviceProfile("device-a") });
    expect(deviceA.status).toBe(200);
    const deviceB = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: oldPassword, deviceName: "f5-device-b", deviceProfile: buildDeviceProfile("device-b") });
    expect(deviceB.status).toBe(200);

    // Change the password FROM device A's own (live) access token.
    // G3: password member present -> currentPassword required (the
    // CURRENT/old password, proving the caller before letting them set a
    // new one).
    const newPassword = "correct-horse-battery-new-f5";
    const patch = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${deviceA.body.accessToken}`)
      .send({ password: newPassword, currentPassword: oldPassword });
    expect(patch.status).toBe(200);

    // Device B's refresh token is dead — its session is over.
    const refreshB = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: deviceB.body.refreshToken, deviceId: deviceB.body.deviceId });
    expect(refreshB.status).toBe(401);

    // Device A's own refresh token is UNTOUCHED — the calling session
    // survives its own password change.
    const refreshA = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: deviceA.body.refreshToken, deviceId: deviceA.body.deviceId });
    expect(refreshA.status, JSON.stringify(refreshA.body)).toBe(200);

    // The new password works; the old one no longer does.
    const oldLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: oldPassword, deviceName: "f5-old-check", deviceProfile: buildDeviceProfile("old-check") });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: newPassword, deviceName: "f5-new-check", deviceProfile: buildDeviceProfile("new-check") });
    expect(newLogin.status).toBe(200);

    // G5: session.revoked-by-password-change emitted, payload {userId,
    // username, revokedCount: 1} (only device B — device A's own token
    // was preserved). No content/library association gates this type
    // (events.ts's GATED_TYPES), so it passes through readEventsForViewer
    // unfiltered regardless of the ViewerContext used to read it.
    const ctx: ViewerContext = { userId: created.body.id, allowedLibraryIds: [], restrictedCleared: false, surface: "restricted" };
    const events = await readEventsForViewer(rawDb, ctx, {});
    const revocationEvent = events.find(
      (e) => e.type === "session.revoked-by-password-change" && (e.payload as { userId?: string }).userId === created.body.id,
    );
    expect(revocationEvent).toBeDefined();
    expect(revocationEvent!.actor_user_id).toBe(created.body.id);
    expect(revocationEvent!.payload).toEqual({
      userId: created.body.id,
      username,
      revokedCount: 1,
    });
  });
});
