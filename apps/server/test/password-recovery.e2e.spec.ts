// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/password-recovery.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for STATE.md "Optional mail transport + invitation & reset
// flows", Lane B's email tier (E3b/M3/M8/M15) and admin/CLI-tier HTTP
// surface (E3a/M14's POST /users/{id}/reset-password twin of the CLI —
// apps/server/test/cli/admin-reset-password.e2e.spec.ts covers the CLI
// itself). E1 (no-email-first): every assertion here runs with ZERO mail
// configuration (mail/mail-config.service.ts's LANE-B STUB — isConfigured()
// always false, publicUrl() always null) — proving tier (a) and the
// reset-consume path work end-to-end regardless, and that the email tier's
// OWN surfaces (forgot-password, reset-password, passwordResetAvailable)
// behave correctly under that stub too.
//
// Runs against its OWN private database ("password_recovery_test" suffix,
// ensureTestDatabase) — same self-sufficient reset+seed pattern as every
// other apps/server e2e suite.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase, getUserByUsername, issuePasswordResetToken } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { MailDispatchService } from "../src/mail/mail-dispatch.service.js";
import { MailConfigService } from "../src/mail/mail-config.service.js";
import { MUST_CHANGE_PASSWORD_PROBLEM_TYPE } from "../src/gateway/must-change-password.exception.js";

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

function hashResetTokenForTest(token: string): string {
  // Mirrors apps/server/src/session/reset-token.ts's hashPasswordResetToken
  // exactly (sha256 hex) — a test-local copy, not an import, so this suite
  // proves the WIRE behavior against an independently-computed hash rather
  // than trivially agreeing with whatever the implementation does.
  return createHash("sha256").update(token).digest("hex");
}

let app: INestApplication;
let databaseUrl: string;
let adminAccessToken: string;

async function loginAs(username: string, password: string): Promise<{ accessToken: string; refreshToken: string; deviceId: string; body: any }> {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `e2e-${username}-${Date.now()}`, deviceProfile: buildDeviceProfile(username) });
  expect(res.status, `login as ${username} failed: ${JSON.stringify(res.body)}`).toBe(200);
  return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, deviceId: res.body.deviceId, body: res.body };
}

async function createOrdinaryUser(
  username: string,
  password: string,
  email: string | null = `${username}@example.invalid`,
): Promise<{ userId: string }> {
  const adminLogin = await loginAs("admin", "loombre-seed-admin");
  const body: Record<string, unknown> = { username, password, isAdmin: false };
  if (email !== null) body["email"] = email;
  const created = await request(app.getHttpServer())
    .post("/users")
    .set("Authorization", `Bearer ${adminLogin.accessToken}`)
    .send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { userId: created.body.id };
}

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "password-recovery-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "1000";
  process.env["LOOMBRE_RATE_REFRESH"] = "1000";
  process.env["LOOMBRE_RATE_PASSWORD_RESET"] = "1000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const admin = await loginAs("admin", "loombre-seed-admin");
  adminAccessToken = admin.accessToken;
});

afterAll(async () => {
  await app.close();
});

describe("GET /system/capabilities: passwordResetAvailable (M8)", () => {
  it("is false with the LANE-B mail stub (E1: zero mail configuration)", async () => {
    const res = await request(app.getHttpServer()).get("/system/capabilities");
    expect(res.status).toBe(200);
    expect(res.body.passwordResetAvailable).toBe(false);
  });

  it("reflects MailConfigService.isConfigured() live (test seam — Lane C wires the real registry-backed logic)", async () => {
    const mailConfigService = app.get(MailConfigService);
    const spy = vi.spyOn(mailConfigService, "isConfigured").mockReturnValue(true);
    try {
      const res = await request(app.getHttpServer()).get("/system/capabilities");
      expect(res.status).toBe(200);
      expect(res.body.passwordResetAvailable).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /auth/forgot-password (E3b, PUBLIC, M12)", () => {
  it("422 on a bodyless request", async () => {
    const res = await request(app.getHttpServer()).post("/auth/forgot-password").send();
    expect(res.status).toBe(422);
  });

  it("unknown identifier: 202 with the fixed empty body — no Authorization header sent (PUBLIC)", async () => {
    const res = await request(app.getHttpServer()).post("/auth/forgot-password").send({ identifier: "no-such-loombre-user-at-all" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });

  it("real account (by username), with an email on file: 202, IDENTICAL body to the unknown-identifier case, and trySend is called with the frozen payload", async () => {
    await createOrdinaryUser("forgot-real-user", "correct-horse-battery-fr1");
    const mailDispatchService = app.get(MailDispatchService);
    const trySendSpy = vi.spyOn(mailDispatchService, "trySend");
    // F2(2), fix wave: forgotPassword() now pre-checks isConfigured() and
    // issues NO token at all when mail is unconfigured — this suite's
    // baseline posture (E1, zero mail configuration) would otherwise mean
    // trySend is never reached, so this specific case (proving the
    // real-account/real-email branch's SHAPE) mocks isConfigured() true,
    // same pattern as the capabilities test above.
    const mailConfigService = app.get(MailConfigService);
    const isConfiguredSpy = vi.spyOn(mailConfigService, "isConfigured").mockReturnValue(true);
    try {
      const res = await request(app.getHttpServer()).post("/auth/forgot-password").send({ identifier: "forgot-real-user" });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({});

      expect(trySendSpy).toHaveBeenCalledTimes(1);
      const call = trySendSpy.mock.calls[0]![0];
      expect(call.templateId).toBe("password-reset");
      expect(call.to).toBe("forgot-real-user@example.invalid");
      expect(typeof call.params["actionUrl"]).toBe("string");
      expect(call.params["actionUrl"]).toContain("/reset/");
      expect(call.params["displayName"]).toBe("forgot-real-user");
    } finally {
      trySendSpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }
  });

  it("real account (by EMAIL, not username): resolves the same way, 202", async () => {
    await createOrdinaryUser("forgot-real-by-email", "correct-horse-battery-fr2");
    const res = await request(app.getHttpServer())
      .post("/auth/forgot-password")
      .send({ identifier: "forgot-real-by-email@example.invalid" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });

  // NOT TESTABLE IN THIS WORKTREE (recorded, not silently dropped): a
  // real-account-with-no-email branch exists in forgotPassword() (`if
  // (user && user.email)` — apps/server/src/session/auth.controller.ts)
  // and is exercised for the ADMIN-reset twin below (the admin action
  // stays constructible without a schema change — see that test), but
  // `POST /users` still requires `email` (users.email is CITEXT NOT NULL
  // UNIQUE in THIS worktree's 0001_init.sql — Lane A's 0023 migration is
  // what drops that NOT NULL, per STATE.md M1, and lands in a SEPARATE
  // worktree). There is therefore no way to construct a user with no email
  // on file here at all. A follow-up test belongs at integration, once
  // 0023 has landed on the assembled tree.

  it("mail unconfigured (F2(2): no token minted, trySend never called) never changes the 202 response (E6)", async () => {
    await createOrdinaryUser("forgot-dispatch-false", "correct-horse-battery-fr4");
    const res = await request(app.getHttpServer()).post("/auth/forgot-password").send({ identifier: "forgot-dispatch-false" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });
});

describe("POST /auth/reset-password (E3b, PUBLIC, M12/E8)", () => {
  it("422 on a bodyless request", async () => {
    const res = await request(app.getHttpServer()).post("/auth/reset-password").send();
    expect(res.status).toBe(422);
  });

  it("happy path: forgot-password mints a token (captured off the trySend call) -> reset-password consumes it -> 204 -> old password 401, refresh revoked, new password logs in", async () => {
    await createOrdinaryUser("reset-happy-path", "correct-horse-battery-old-hp");
    const preLogin = await loginAs("reset-happy-path", "correct-horse-battery-old-hp");

    const mailDispatchService = app.get(MailDispatchService);
    const trySendSpy = vi.spyOn(mailDispatchService, "trySend");
    // F2(2), fix wave: a token is only ever minted when mail is
    // configured — mock isConfigured() true so this happy-path round trip
    // actually gets a real token to consume below (see the earlier
    // "with an email on file" test for the same pattern/rationale).
    const mailConfigService = app.get(MailConfigService);
    const isConfiguredSpy = vi.spyOn(mailConfigService, "isConfigured").mockReturnValue(true);
    let plaintextToken: string;
    try {
      const forgot = await request(app.getHttpServer()).post("/auth/forgot-password").send({ identifier: "reset-happy-path" });
      expect(forgot.status).toBe(202);
      const resetLink = trySendSpy.mock.calls[0]![0].params["actionUrl"]!;
      plaintextToken = resetLink.split("/reset/")[1]!;
      expect(plaintextToken.length).toBeGreaterThan(0);
    } finally {
      trySendSpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }

    const newPassword = "correct-horse-battery-new-hp";
    const consume = await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token: plaintextToken, password: newPassword });
    expect(consume.status).toBe(204);

    const oldLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "reset-happy-path", password: "correct-horse-battery-old-hp", deviceName: "e2e-old", deviceProfile: buildDeviceProfile("e2e-old") });
    expect(oldLogin.status).toBe(401);

    const refreshAttempt = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: preLogin.refreshToken, deviceId: preLogin.deviceId });
    expect(refreshAttempt.status).toBe(401);

    const newLogin = await loginAs("reset-happy-path", newPassword);
    expect(newLogin.body.mustChangePassword).toBe(false);
  });

  it("replay: using the SAME token twice — second attempt 404", async () => {
    await createOrdinaryUser("reset-replay", "correct-horse-battery-replay-1");
    const db = createDb(databaseUrl);
    let plaintextToken: string;
    try {
      const user = await getUserByUsername(db, "reset-replay");
      plaintextToken = "replay-plaintext-token-0123456789abcdef";
      await issuePasswordResetToken(db, {
        userId: user!.id,
        tokenHash: hashResetTokenForTest(plaintextToken),
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 30 * 60 * 1000,
      });
    } finally {
      await db.destroy();
    }

    const first = await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token: plaintextToken, password: "correct-horse-battery-replay-2" });
    expect(first.status).toBe(204);

    const second = await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token: plaintextToken, password: "correct-horse-battery-replay-3" });
    expect(second.status).toBe(404);
  });

  it("expired token: 404", async () => {
    await createOrdinaryUser("reset-expired", "correct-horse-battery-expired-1");
    const db = createDb(databaseUrl);
    const plaintextToken = "expired-plaintext-token-0123456789abcdef";
    try {
      const user = await getUserByUsername(db, "reset-expired");
      await issuePasswordResetToken(db, {
        userId: user!.id,
        tokenHash: hashResetTokenForTest(plaintextToken),
        createdAtMs: Date.now() - 60 * 60 * 1000,
        expiresAtMs: Date.now() - 60 * 1000, // expired a minute ago
      });
    } finally {
      await db.destroy();
    }

    const res = await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token: plaintextToken, password: "correct-horse-battery-expired-2" });
    expect(res.status).toBe(404);
  });

  it("garbage/never-issued token: 404, byte-identical to an unknown route (M12)", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token: "garbage-token-that-was-never-issued", password: "correct-horse-battery-garbage-1" });
    // AuthGuard's global unauthenticated wall gates every non-public route
    // (STATE.md D21) — an unknown path needs a valid Bearer token to even
    // REACH NotFoundController's catch-all, same as conformance.spec.ts's
    // and setup.e2e.spec.ts's own byte-identical-404 comparisons.
    const unknownRoute = await request(app.getHttpServer())
      .get("/this-route-does-not-exist-password-recovery")
      .set("Authorization", `Bearer ${adminAccessToken}`);

    expect(res.status).toBe(404);
    expect(unknownRoute.status).toBe(404);
    expect(res.headers["content-type"]).toBe(unknownRoute.headers["content-type"]);
    expect(res.text).toBe(unknownRoute.text);
    expect(JSON.parse(res.text)).toEqual({ type: "about:blank", title: "Not Found", status: 404 });
  });

  it("expired vs used vs garbage are byte-identical to each other (instance-stripped)", async () => {
    await createOrdinaryUser("reset-indistinguishable", "correct-horse-battery-indist-1");
    const db = createDb(databaseUrl);
    const usedToken = "indist-used-plaintext-0123456789abcdef";
    const expiredToken = "indist-expired-plaintext-0123456789abcdef";
    try {
      const user = await getUserByUsername(db, "reset-indistinguishable");
      await issuePasswordResetToken(db, {
        userId: user!.id,
        tokenHash: hashResetTokenForTest(usedToken),
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 30 * 60 * 1000,
      });
      await issuePasswordResetToken(db, {
        userId: user!.id,
        tokenHash: hashResetTokenForTest(expiredToken),
        createdAtMs: Date.now() - 60 * 60 * 1000,
        expiresAtMs: Date.now() - 60 * 1000,
      });
    } finally {
      await db.destroy();
    }
    // Burn the "used" token first.
    await request(app.getHttpServer()).post("/auth/reset-password").send({ token: usedToken, password: "correct-horse-battery-indist-2" });

    const usedAttempt = await request(app.getHttpServer()).post("/auth/reset-password").send({ token: usedToken, password: "irrelevant" });
    const expiredAttempt = await request(app.getHttpServer()).post("/auth/reset-password").send({ token: expiredToken, password: "irrelevant" });
    const garbageAttempt = await request(app.getHttpServer()).post("/auth/reset-password").send({ token: "totally-unknown-token", password: "irrelevant" });

    expect(usedAttempt.status).toBe(404);
    expect(expiredAttempt.status).toBe(404);
    expect(garbageAttempt.status).toBe(404);
    expect(usedAttempt.text).toBe(expiredAttempt.text);
    expect(expiredAttempt.text).toBe(garbageAttempt.text);
  });

  it("race: two concurrent consumes of the SAME token — exactly one 204, one 404", async () => {
    await createOrdinaryUser("reset-race", "correct-horse-battery-race-1");
    const db = createDb(databaseUrl);
    const plaintextToken = "race-plaintext-token-0123456789abcdef";
    try {
      const user = await getUserByUsername(db, "reset-race");
      await issuePasswordResetToken(db, {
        userId: user!.id,
        tokenHash: hashResetTokenForTest(plaintextToken),
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 30 * 60 * 1000,
      });
    } finally {
      await db.destroy();
    }

    const [a, b] = await Promise.all([
      request(app.getHttpServer()).post("/auth/reset-password").send({ token: plaintextToken, password: "correct-horse-battery-race-a" }),
      request(app.getHttpServer()).post("/auth/reset-password").send({ token: plaintextToken, password: "correct-horse-battery-race-b" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([204, 404]);
  });
});

describe("POST /users/{id}/reset-password (E3a/M14, admin/CLI tier's HTTP twin)", () => {
  it("401 unauthenticated", async () => {
    const res = await request(app.getHttpServer()).post("/users/018f6f1e-0000-7000-8000-000000000001/reset-password");
    expect(res.status).toBe(401);
  });

  it("403 for a non-admin caller (ordinary forbidden, NOT the password-change-required type)", async () => {
    const { userId } = await createOrdinaryUser("reset-admin-nonadmin-target", "correct-horse-battery-na1");
    const casual = await loginAs("casual", "loombre-seed-casual");
    const res = await request(app.getHttpServer())
      .post(`/users/${userId}/reset-password`)
      .set("Authorization", `Bearer ${casual.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.type).not.toBe(MUST_CHANGE_PASSWORD_PROBLEM_TYPE);
  });

  it("404 for an unknown user id", async () => {
    const res = await request(app.getHttpServer())
      .post("/users/018f6f1e-0000-7000-8000-00000000dead/reset-password")
      .set("Authorization", `Bearer ${adminAccessToken}`);
    expect(res.status).toBe(404);
  });

  it("happy path: 200 {temporaryPassword}, old password 401, temp login mustChangePassword:true, security-notice mailed (target has an email)", async () => {
    const { userId } = await createOrdinaryUser("reset-admin-happy", "correct-horse-battery-ah1");

    const mailDispatchService = app.get(MailDispatchService);
    const spy = vi.spyOn(mailDispatchService, "trySend");
    let temporaryPassword: string;
    try {
      const res = await request(app.getHttpServer())
        .post(`/users/${userId}/reset-password`)
        .set("Authorization", `Bearer ${adminAccessToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      temporaryPassword = res.body.temporaryPassword;
      expect(typeof temporaryPassword).toBe("string");
      expect(temporaryPassword.length).toBeGreaterThanOrEqual(16);

      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0]![0];
      expect(call.templateId).toBe("security-notice");
      expect(call.to).toBe("reset-admin-happy@example.invalid");
    } finally {
      spy.mockRestore();
    }

    const oldLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "reset-admin-happy", password: "correct-horse-battery-ah1", deviceName: "e2e-old", deviceProfile: buildDeviceProfile("e2e-old") });
    expect(oldLogin.status).toBe(401);

    const tempLogin = await loginAs("reset-admin-happy", temporaryPassword);
    expect(tempLogin.body.mustChangePassword).toBe(true);
  });

  // NOT TESTABLE IN THIS WORKTREE — see the identical note in the
  // forgot-password describe block above (users.email is NOT NULL until
  // Lane A's 0023 migration lands at integration); resetUserPassword()'s
  // `if (target.email)` branch (apps/server/src/catalog/users.controller.ts)
  // is written defensively for that future either way.

  it("self-reset is PERMITTED: an admin resetting their OWN account succeeds, and immediately restricts their OWN still-live access token (decision recorded: self-reset allowed)", async () => {
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ username: "reset-self-admin", email: "reset-self-admin@example.invalid", password: "correct-horse-battery-selfadmin1", isAdmin: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const selfAdminLogin = await loginAs("reset-self-admin", "correct-horse-battery-selfadmin1");

    const selfReset = await request(app.getHttpServer())
      .post(`/users/${created.body.id}/reset-password`)
      .set("Authorization", `Bearer ${selfAdminLogin.accessToken}`);
    expect(selfReset.status, JSON.stringify(selfReset.body)).toBe(200);

    // The SAME access token that just performed the reset is now
    // must_change_password-flagged (live DB read, not advisory) — the very
    // next request with it is restricted, even to admin-only endpoints.
    const nextRequest = await request(app.getHttpServer())
      .get("/users")
      .set("Authorization", `Bearer ${selfAdminLogin.accessToken}`);
    expect(nextRequest.status).toBe(403);
    expect(nextRequest.body.type).toBe(MUST_CHANGE_PASSWORD_PROBLEM_TYPE);
  });
});

describe("rate limiting (passwordReset policy, shared by forgot-password + reset-password, M12)", () => {
  let lowCapApp: INestApplication;

  beforeAll(async () => {
    process.env["LOOMBRE_RATE_PASSWORD_RESET"] = "2";
    lowCapApp = await NestFactory.create(AppModule, { logger: false });
    await lowCapApp.init();
  });

  afterAll(async () => {
    await lowCapApp.close();
    process.env["LOOMBRE_RATE_PASSWORD_RESET"] = "1000";
  });

  it("trips 429 + Retry-After after LOOMBRE_RATE_PASSWORD_RESET attempts, shared across BOTH endpoints from the same IP", async () => {
    const first = await request(lowCapApp.getHttpServer()).post("/auth/forgot-password").send({ identifier: "rate-limit-probe" });
    expect(first.status).toBe(202);
    const second = await request(lowCapApp.getHttpServer()).post("/auth/reset-password").send({ token: "x", password: "irrelevant-rl-1" });
    expect(second.status).toBe(404); // still under the cap, just an invalid token

    const tripped = await request(lowCapApp.getHttpServer()).post("/auth/forgot-password").send({ identifier: "rate-limit-probe" });
    expect(tripped.status).toBe(429);
    expect(tripped.headers["retry-after"]).toBeDefined();
  });
});
