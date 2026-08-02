// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/cli/admin-reset-password.e2e.spec.ts
//
// E3a/M14 (STATE.md "Optional mail transport + invitation & reset flows")
// — end-to-end proof of `loombre admin reset-password <username>`, the H2
// pattern applied to passwords. Same structure as
// admin-reset-pin.e2e.spec.ts: full loop against a REAL app (in-process
// Nest, supertest, live Postgres) and the REAL runCli() dispatcher, with a
// FAKE confirm() (interactive stdin has no place in an automated test) and
// a REAL database connection scoped to this file's own test database.
//
// Full loop proves the WHOLE M14 enforcement chain: reset -> old password
// 401 -> refresh ALSO fails (every refresh token revoked, not just the
// access token expiring) -> temp-password login succeeds with
// mustChangePassword:true -> an arbitrary authenticated endpoint 403s with
// the distinct password-change-required problem type -> PATCH /users/me
// with a new password succeeds -> mustChangePassword clears -> full access
// resumes with the SAME still-live access token.

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
import { runCli } from "../../src/cli/run-cli.js";
import type { AdminDeps } from "../../src/cli/admin-reset-pin.js";
import type { DoctorDeps } from "../../src/cli/doctor.js";
import { MUST_CHANGE_PASSWORD_PROBLEM_TYPE } from "../../src/gateway/must-change-password.exception.js";

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

const UNUSED_DOCTOR_DEPS: DoctorDeps = {
  isExecutableFile: () => true,
  spawnVersion: () => ({ ok: true, stdout: "" }),
  checkWritable: () => ({ exists: true, writable: true, checkedPath: "/data" }),
};

let app: INestApplication;
let databaseUrl: string;

function fakeAdminDeps(confirmAnswer: boolean): AdminDeps {
  return {
    connect: async () => {
      const db = createDb(databaseUrl);
      return { db, end: () => db.destroy() };
    },
    confirm: async () => confirmAnswer,
    nowMs: () => Date.now(),
  };
}

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "admin-reset-password-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "1000";
  process.env["LOOMBRE_RATE_REFRESH"] = "1000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
}, 30_000);

afterAll(async () => {
  await app.close();
});

async function createOrdinaryUser(username: string, password: string): Promise<{ userId: string; accessToken: string }> {
  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "e2e-admin",
    deviceProfile: buildDeviceProfile("e2e-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);

  const created = await request(app.getHttpServer())
    .post("/users")
    .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
    .send({ username, email: `${username}@example.invalid`, password, isAdmin: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const login = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `e2e-${username}`, deviceProfile: buildDeviceProfile(username) });
  expect(login.status, JSON.stringify(login.body)).toBe(200);

  return { userId: created.body.id, accessToken: login.body.accessToken };
}

async function latestPasswordResetEvent(
  userId: string,
): Promise<{ payload: Record<string, unknown>; actor_user_id: string | null } | undefined> {
  const db = createDb(databaseUrl);
  try {
    const rows = await db
      .selectFrom("events")
      .select(["payload", "actor_user_id", "ts_ms"])
      .where("type", "=", "user.password-reset")
      .orderBy("ts_ms", "desc")
      .execute();
    const match = rows.find((row) => (row.payload as Record<string, unknown> | null)?.["userId"] === userId);
    return match as { payload: Record<string, unknown>; actor_user_id: string | null } | undefined;
  } finally {
    await db.destroy();
  }
}

describe("loombre admin reset-password <username> (E3a/M14)", () => {
  it("full loop: reset -> old password 401 -> refresh also fails -> temp login mustChangePassword:true -> arbitrary endpoint 403 -> PATCH new password -> flag clears -> full access", async () => {
    const username = "h14-reset-full-loop";
    const oldPassword = "correct-horse-battery-old-1";
    const { userId } = await createOrdinaryUser(username, oldPassword);

    const preLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: oldPassword, deviceName: "e2e-pre", deviceProfile: buildDeviceProfile("e2e-pre") });
    expect(preLogin.status).toBe(200);
    const preRefreshToken: string = preLogin.body.refreshToken;
    const preDeviceId: string = preLogin.body.deviceId;

    const cliResult = await runCli({
      argv: ["admin", "reset-password", username],
      env: {},
      nodePlatform: "linux",
      doctorDeps: UNUSED_DOCTOR_DEPS,
      adminDeps: fakeAdminDeps(true),
    });
    expect(cliResult.exitCode, JSON.stringify(cliResult)).toBe(0);
    expect(cliResult.stderr).toEqual([]);
    expect(cliResult.stdout.join("\n")).toContain(`Temporary password for "${username}"`);
    expect(cliResult.stdout.join("\n")).toContain("shown once");
    // Second stdout line is the temporary password itself.
    const temporaryPassword = cliResult.stdout[1]!;
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(16);

    // Old password rejected.
    const oldLoginAttempt = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: oldPassword, deviceName: "e2e-old", deviceProfile: buildDeviceProfile("e2e-old") });
    expect(oldLoginAttempt.status).toBe(401);

    // Every refresh token issued before the reset is revoked too — prove
    // it, not just assume it (M14: "revoke ALL the user's refresh tokens").
    const refreshAttempt = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: preRefreshToken, deviceId: preDeviceId });
    expect(refreshAttempt.status).toBe(401);

    // Temp password login succeeds, mustChangePassword: true.
    const tempLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: temporaryPassword, deviceName: "e2e-temp", deviceProfile: buildDeviceProfile("e2e-temp") });
    expect(tempLogin.status, JSON.stringify(tempLogin.body)).toBe(200);
    expect(tempLogin.body.mustChangePassword).toBe(true);
    const tempAccessToken: string = tempLogin.body.accessToken;

    // An arbitrary, otherwise-fine authenticated endpoint is 403'd with the
    // DISTINCT password-change-required problem type — not the ordinary
    // forbidden() type.
    const blocked = await request(app.getHttpServer())
      .get("/devices")
      .set("Authorization", `Bearer ${tempAccessToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.type).toBe(MUST_CHANGE_PASSWORD_PROBLEM_TYPE);

    // GET/PATCH /users/me and logout stay reachable while flagged.
    const meWhileFlagged = await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${tempAccessToken}`);
    expect(meWhileFlagged.status).toBe(200);
    expect(meWhileFlagged.body.mustChangePassword).toBe(true);

    // G3 (STATE.md "Current-password re-auth on self-changes"): a body
    // member requires currentPassword — proven here by the temporary
    // password ITSELF (the one thing this user, mid-must-change-password,
    // is guaranteed to know — they just used it to log in). Confirms G3's
    // documented must-change interplay: "only updateMe is reachable while
    // flagged; the user just typed the temp password at login."
    const newPassword = "correct-horse-battery-new-2";
    const patch = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${tempAccessToken}`)
      .send({ password: newPassword, currentPassword: temporaryPassword });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.mustChangePassword).toBe(false);

    // Flag cleared -> the VERY SAME access token now has full access,
    // no re-login/refresh required (proves the guard's live-read, not a
    // stale JWT claim).
    const fullAccess = await request(app.getHttpServer())
      .get("/devices")
      .set("Authorization", `Bearer ${tempAccessToken}`);
    expect(fullAccess.status).toBe(200);

    // A fresh login with the new password also reports mustChangePassword: false.
    const freshLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password: newPassword, deviceName: "e2e-fresh", deviceProfile: buildDeviceProfile("e2e-fresh") });
    expect(freshLogin.status).toBe(200);
    expect(freshLogin.body.mustChangePassword).toBe(false);

    // Audit event: right payload, never any password/hash material.
    const event = await latestPasswordResetEvent(userId);
    expect(event).toBeDefined();
    expect(event!.payload).toEqual({ userId, username, actor: "cli" });
    expect(event!.actor_user_id).toBeNull();
    const serialized = JSON.stringify(event!.payload);
    expect(serialized).not.toContain(temporaryPassword);
    expect(serialized).not.toContain(newPassword);
  });

  it("declined confirmation: nothing changes, no event, exit 1", async () => {
    const username = "h14-reset-declined";
    const password = "correct-horse-battery-2";
    const { userId } = await createOrdinaryUser(username, password);

    const cliResult = await runCli({
      argv: ["admin", "reset-password", username],
      env: {},
      nodePlatform: "linux",
      doctorDeps: UNUSED_DOCTOR_DEPS,
      adminDeps: fakeAdminDeps(false),
    });
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stdout).toEqual([]);
    expect(cliResult.stderr).toEqual(["aborted, nothing changed"]);

    // Old password still works.
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password, deviceName: "e2e-still", deviceProfile: buildDeviceProfile("e2e-still") });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.mustChangePassword).toBe(false);

    const event = await latestPasswordResetEvent(userId);
    expect(event).toBeUndefined();
  });

  it("unknown user: clean one-line error, exit 1, no stack", async () => {
    const cliResult = await runCli({
      argv: ["admin", "reset-password", "no-such-loombre-user-at-all"],
      env: {},
      nodePlatform: "linux",
      doctorDeps: UNUSED_DOCTOR_DEPS,
      adminDeps: fakeAdminDeps(true),
    });
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stdout).toEqual([]);
    expect(cliResult.stderr).toEqual([`loombre: no such user "no-such-loombre-user-at-all"`]);
    expect(cliResult.stderr.join("\n")).not.toContain("at ");
    expect(cliResult.stderr.join("\n")).not.toContain("Error:");
  });
});
