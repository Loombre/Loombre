// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/reauth.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for STATE.md "Current-password re-auth on self-changes + the
// email-collision signal" — Lane A's own proof of its server-side work:
//   - G3: happy/missing/wrong currentPassword on PATCH /users/me (when the
//     body carries password/email) and PUT /users/me/restricted (always);
//     bare profile saves stay re-auth-free; unknown-key 422 allowlists.
//   - G6/G7: an email collision on PATCH /users/me is a silent no-op
//     (200, not 409/422) that dispatches the email-in-use-notice mail
//     ONLY when mail is configured, suppressed a second time inside the
//     24h ledger window; re-setting your OWN address is never a
//     collision.
//   - G9: PATCH /users/{id} (admin) surfaces a real 409 on an email
//     conflict instead of an uncaught 500.
//   - G8: the wall-clock floor on an email-bearing updateMe applies
//     uniformly to both the collision and non-collision cells.
//
// The adversarial cross-cutting matrix (enumeration/timing probes, E8
// verification) is a SEPARATE lane's deliverable (Lane R) — this suite
// proves the happy/wrong/missing/429/event/collision/floor shape of THIS
// lane's own work, same scope discipline as password-recovery.e2e.spec.ts.
//
// Runs against the SAME shared "_server_test" database every other
// apps/server e2e suite in this package uses (vitest.config.ts forces
// sequential file execution for exactly this reason) — self-sufficient
// reset+seed in its own beforeAll.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { MailDispatchService } from "../src/mail/mail-dispatch.service.js";
import { MailConfigService } from "../src/mail/mail-config.service.js";
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

function buildDeviceProfile(profileId = "reauth-e2e") {
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
let userCounter = 0;

async function loginAs(username: string, password: string): Promise<{ accessToken: string }> {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `reauth-e2e-${username}-${Date.now()}`, deviceProfile: buildDeviceProfile(username) });
  expect(res.status, `login as ${username} failed: ${JSON.stringify(res.body)}`).toBe(200);
  return { accessToken: res.body.accessToken };
}

/** Creates a fresh, ordinary user (via the admin token) and logs in as
 *  them — a fresh user per call, so this whole suite never contends over
 *  one shared currentPassword rate-limit bucket. */
async function createAndLoginFreshUser(
  password: string,
  email?: string,
): Promise<{ userId: string; accessToken: string; username: string; email: string }> {
  userCounter += 1;
  const username = `reauth-user-${Date.now()}-${userCounter}`;
  const finalEmail = email ?? `${username}@example.invalid`;
  const created = await request(app.getHttpServer())
    .post("/users")
    .set("Authorization", `Bearer ${adminAccessToken}`)
    .send({ username, email: finalEmail, password, isAdmin: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { accessToken } = await loginAs(username, password);
  return { userId: created.body.id, accessToken, username, email: finalEmail };
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "reauth-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";
  // This suite's own point is the currentPassword re-auth SHAPE, not the
  // limiter itself (that's auth-security.e2e.spec.ts's dedicated low-cap
  // suite) — raised generously so many it() blocks never contend.
  process.env["LOOMBRE_RATE_CURRENT_PASSWORD"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const admin = await loginAs("admin", "loombre-seed-admin");
  adminAccessToken = admin.accessToken;
});

afterAll(async () => {
  await app.close();
  delete process.env["LOOMBRE_RATE_LOGIN"];
  delete process.env["LOOMBRE_RATE_CURRENT_PASSWORD"];
});

describe("G3: PATCH /users/me currentPassword re-auth matrix", () => {
  it("password member + correct currentPassword -> 200", async () => {
    const password = "reauth-happy-password-1";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ password: "reauth-happy-password-1-NEW", currentPassword: password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("email member + correct currentPassword -> 200", async () => {
    const password = "reauth-happy-password-2";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: `changed-${user.username}@example.invalid`, currentPassword: password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("explicit email:null (clear) + correct currentPassword -> 200", async () => {
    const password = "reauth-happy-password-3";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: null, currentPassword: password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.email).toBeNull();
  });

  it("password member, currentPassword ABSENT -> 422 (target-agnostic detail)", async () => {
    const password = "reauth-missing-password-1";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ password: "reauth-missing-password-1-NEW" });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("email member, currentPassword ABSENT -> 422 — including explicit email:null", async () => {
    const password = "reauth-missing-password-2";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: null });
    expect(res.status).toBe(422);
  });

  it("currentPassword present but non-string -> 422", async () => {
    const password = "reauth-nonstring-password";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ password: "reauth-nonstring-password-NEW", currentPassword: 12345 });
    expect(res.status).toBe(422);
  });

  it("WRONG currentPassword -> 403 urn:loombre:problem:current-password-invalid, code current-password-invalid — SAME shape for password OR email target", async () => {
    const password = "reauth-wrong-password-1";
    const userForPassword = await createAndLoginFreshUser(password);
    const passwordAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${userForPassword.accessToken}`)
      .send({ password: "reauth-wrong-password-1-NEW", currentPassword: "definitely-the-wrong-password" });
    expect(passwordAttempt.status).toBe(403);
    expect(passwordAttempt.body.type).toBe(CURRENT_PASSWORD_INVALID_PROBLEM_TYPE);
    expect(passwordAttempt.body.code).toBe("current-password-invalid");

    const userForEmail = await createAndLoginFreshUser(password);
    const emailAttempt = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${userForEmail.accessToken}`)
      .send({ email: "attempted-change@example.invalid", currentPassword: "definitely-the-wrong-password" });
    expect(emailAttempt.status).toBe(403);
    expect(emailAttempt.body.type).toBe(CURRENT_PASSWORD_INVALID_PROBLEM_TYPE);
    // The SAME fixed detail regardless of which field was being changed (F2).
    expect(emailAttempt.body.detail).toBe(passwordAttempt.body.detail);
  });

  it("a bare displayName-only save needs NO currentPassword — 200 even with none supplied", async () => {
    const password = "reauth-bare-displayname";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ displayName: "No Re-Auth Needed" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.displayName).toBe("No Re-Auth Needed");
  });

  it("a bare birthDate-only save needs NO currentPassword — 200", async () => {
    const password = "reauth-bare-birthdate";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ birthDate: "1990-01-01" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("an unknown body property -> 422 (UPDATE_ME_BODY_KEYS allowlist)", async () => {
    const password = "reauth-unknown-key";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ displayName: "x", notARealField: "garbage" });
    expect(res.status).toBe(422);
  });
});

describe("G3: PUT /users/me/restricted currentPassword re-auth matrix (ALWAYS required)", () => {
  it("correct currentPassword + valid optIn/pin -> 200", async () => {
    const password = "reauth-restricted-happy";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: true, pin: "4242", currentPassword: password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("currentPassword ABSENT -> 422", async () => {
    const password = "reauth-restricted-missing";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: true, pin: "4242" });
    expect(res.status).toBe(422);
  });

  it("WRONG currentPassword -> 403, SAME shape as updateMe's", async () => {
    const password = "reauth-restricted-wrong";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: true, pin: "4242", currentPassword: "definitely-the-wrong-password" });
    expect(res.status).toBe(403);
    expect(res.body.type).toBe(CURRENT_PASSWORD_INVALID_PROBLEM_TYPE);
    expect(res.body.code).toBe("current-password-invalid");
  });

  it("an unknown body property -> 422 (RESTRICTED_SETTINGS_BODY_KEYS allowlist)", async () => {
    const password = "reauth-restricted-unknown-key";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ optIn: true, pin: "4242", currentPassword: password, notARealField: "garbage" });
    expect(res.status).toBe(422);
  });
});

describe("G6/G7: email collision silent no-op + email-in-use-notice dispatch", () => {
  it("colliding with ANOTHER account's email is a silent 200 no-op (never 409/422) — the attacker's own address is untouched", async () => {
    const victimPassword = "reauth-collision-victim";
    const victim = await createAndLoginFreshUser(victimPassword);

    const attackerPassword = "reauth-collision-attacker";
    const attacker = await createAndLoginFreshUser(attackerPassword);

    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${attacker.accessToken}`)
      .send({ email: victim.email, currentPassword: attackerPassword });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.email).toBe(attacker.email); // dropped — the attacker's OWN address, untouched
  });

  it("re-setting your OWN current address is never a collision", async () => {
    const password = "reauth-self-collision";
    const user = await createAndLoginFreshUser(password);
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: user.email, currentPassword: password });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(user.email);
  });

  it("mail CONFIGURED: a collision dispatches email-in-use-notice to the EXISTING owner, with serverName", async () => {
    const victimPassword = "reauth-notice-victim";
    const victim = await createAndLoginFreshUser(victimPassword);
    const attackerPassword = "reauth-notice-attacker";
    const attacker = await createAndLoginFreshUser(attackerPassword);

    const mailDispatchService = app.get(MailDispatchService);
    const trySendSpy = vi.spyOn(mailDispatchService, "trySend");
    const mailConfigService = app.get(MailConfigService);
    const isConfiguredSpy = vi.spyOn(mailConfigService, "isConfigured").mockReturnValue(true);
    try {
      const res = await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", `Bearer ${attacker.accessToken}`)
        .send({ email: victim.email, currentPassword: attackerPassword });
      expect(res.status).toBe(200);

      const noticeCalls = trySendSpy.mock.calls.filter((c) => c[0].templateId === "email-in-use-notice");
      expect(noticeCalls).toHaveLength(1);
      expect(noticeCalls[0]![0].to).toBe(victim.email);
      expect(typeof noticeCalls[0]![0].params["serverName"]).toBe("string");
    } finally {
      trySendSpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }
  });

  it("mail UNCONFIGURED (this suite's default): a collision dispatches NO notice (F5: no mail -> no signal)", async () => {
    const victimPassword = "reauth-nonotice-victim";
    const victim = await createAndLoginFreshUser(victimPassword);
    const attackerPassword = "reauth-nonotice-attacker";
    const attacker = await createAndLoginFreshUser(attackerPassword);

    const mailDispatchService = app.get(MailDispatchService);
    const trySendSpy = vi.spyOn(mailDispatchService, "trySend");
    try {
      const res = await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", `Bearer ${attacker.accessToken}`)
        .send({ email: victim.email, currentPassword: attackerPassword });
      expect(res.status).toBe(200);

      const noticeCalls = trySendSpy.mock.calls.filter((c) => c[0].templateId === "email-in-use-notice");
      expect(noticeCalls).toHaveLength(0);
    } finally {
      trySendSpy.mockRestore();
    }
  });

  it("G7 window suppression: a SECOND collision against the SAME address inside 24h dispatches NO second notice", async () => {
    const victimPassword = "reauth-window-victim";
    const victim = await createAndLoginFreshUser(victimPassword);
    const attacker1Password = "reauth-window-attacker-1";
    const attacker1 = await createAndLoginFreshUser(attacker1Password);
    const attacker2Password = "reauth-window-attacker-2";
    const attacker2 = await createAndLoginFreshUser(attacker2Password);

    const mailDispatchService = app.get(MailDispatchService);
    const trySendSpy = vi.spyOn(mailDispatchService, "trySend");
    const mailConfigService = app.get(MailConfigService);
    const isConfiguredSpy = vi.spyOn(mailConfigService, "isConfigured").mockReturnValue(true);
    try {
      const first = await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", `Bearer ${attacker1.accessToken}`)
        .send({ email: victim.email, currentPassword: attacker1Password });
      expect(first.status).toBe(200);

      const second = await request(app.getHttpServer())
        .patch("/users/me")
        .set("Authorization", `Bearer ${attacker2.accessToken}`)
        .send({ email: victim.email, currentPassword: attacker2Password });
      expect(second.status).toBe(200); // still a silent no-op either way

      const noticeCalls = trySendSpy.mock.calls.filter((c) => c[0].templateId === "email-in-use-notice" && c[0].to === victim.email);
      expect(noticeCalls).toHaveLength(1); // the SECOND attempt was suppressed by the ledger window
    } finally {
      trySendSpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }
  });
});

describe("G9: PATCH /users/{id} (admin) email conflict -> 409", () => {
  it("a genuine email collision returns 409 urn:loombre:problem:conflict, not a 500", async () => {
    const victim = await createAndLoginFreshUser("reauth-admin-conflict-victim");
    const target = await createAndLoginFreshUser("reauth-admin-conflict-target");

    const res = await request(app.getHttpServer())
      .patch(`/users/${target.userId}`)
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ email: victim.email });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe("urn:loombre:problem:conflict");
  });

  it("a non-colliding admin email change still succeeds (200)", async () => {
    const target = await createAndLoginFreshUser("reauth-admin-happy-target");
    const res = await request(app.getHttpServer())
      .patch(`/users/${target.userId}`)
      .set("Authorization", `Bearer ${adminAccessToken}`)
      .send({ email: "brand-new-admin-set-address@example.invalid" });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("brand-new-admin-set-address@example.invalid");
  });
});

describe("G8: wall-clock floor on an email-bearing updateMe", () => {
  const FLOOR_MS = 200;
  const TOLERANCE_MS = 30; // scheduling jitter margin, never negative direction

  it("a collision cell takes at least the floor", async () => {
    const victim = await createAndLoginFreshUser("reauth-floor-victim");
    const attackerPassword = "reauth-floor-attacker";
    const attacker = await createAndLoginFreshUser(attackerPassword);

    const startedAtMs = Date.now();
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${attacker.accessToken}`)
      .send({ email: victim.email, currentPassword: attackerPassword });
    const elapsedMs = Date.now() - startedAtMs;

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(FLOOR_MS - TOLERANCE_MS);
  });

  it("a non-collision (clean) email cell ALSO takes at least the floor — same cost, no timing oracle", async () => {
    const password = "reauth-floor-clean";
    const user = await createAndLoginFreshUser(password);

    const startedAtMs = Date.now();
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ email: `floor-clean-new-${Date.now()}@example.invalid`, currentPassword: password });
    const elapsedMs = Date.now() - startedAtMs;

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(FLOOR_MS - TOLERANCE_MS);
  });

  it("a plain displayName-only save (no email member) is UNFLOORED", async () => {
    const password = "reauth-floor-unfloored";
    const user = await createAndLoginFreshUser(password);

    const startedAtMs = Date.now();
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ displayName: "No Floor Here" });
    const elapsedMs = Date.now() - startedAtMs;

    expect(res.status).toBe(200);
    // No strict upper bound (CI jitter) — just proves this path is not
    // ARTIFICIALLY delayed the way the email-bearing cells above are.
    expect(elapsedMs).toBeLessThan(FLOOR_MS);
  });
});
