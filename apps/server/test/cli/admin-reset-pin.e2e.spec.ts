// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/cli/admin-reset-pin.e2e.spec.ts
//
// H2 (owner brief) — end-to-end proof of `loombre admin reset-pin
// <username>`, the server-local recovery path for a forgotten
// restricted-content PIN (no HTTP surface exists for this — see
// restricted.controller.ts / users-me.controller.ts's headers).
//
// Full loop against a REAL app (in-process Nest, supertest, live Postgres)
// and the REAL runCli() dispatcher (proving the actual CLI wiring, not just
// runAdminResetPin in isolation): create a fresh user -> grant it a
// restricted library + opt it in with a PIN (gates 1-4 all real) -> unlock
// succeeds (gate 5) -> run the reset through runCli with a FAKE confirm()
// (interactive stdin has no place in an automated test) and a REAL
// database connection scoped to this file's own test database -> the old
// PIN is rejected -> a fresh opt-in with a NEW PIN succeeds -> the
// `user.restricted-pin-reset` event row is visible with the right payload.
// Plus: a declined confirmation (nothing changes, no event) and an unknown
// user (clean error).
//
// Self-sufficient, same convention as every other apps/server e2e suite:
// own ensureTestDatabase("server_test") suffix, own reset+reseed.

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
import { SettingsService } from "../../src/settings/settings.service.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { AdminDeps } from "../../src/cli/admin-reset-pin.js";
import type { DoctorDeps } from "../../src/cli/doctor.js";

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

// Never touches the real filesystem/PATH/process table — the CLI branches
// this suite exercises (`admin reset-pin`) never call doctorDeps at all;
// this stub only exists to satisfy RunCliOptions's shape.
const UNUSED_DOCTOR_DEPS: DoctorDeps = {
  isExecutableFile: () => true,
  spawnVersion: () => ({ ok: true, stdout: "" }),
  checkWritable: () => ({ exists: true, writable: true, checkedPath: "/data" }),
};

let app: INestApplication;
let databaseUrl: string;
let settingsService: SettingsService;

/** Builds a fake AdminDeps for this test file: `connect()` opens a REAL,
 *  independent connection (its own pool — `end()` destroys ONLY this
 *  connection, never the app's shared handle) scoped to this file's own
 *  test database; `confirm()` is scripted per test (no interactive stdin
 *  in an automated suite — node:readline/promises has no test-harness
 *  precedent anywhere in this repo, this is the injection seam instead). */
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

async function setRestrictedEnabled(): Promise<void> {
  process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
  await settingsService.reload();
}

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "admin-reset-pin-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "1000";
  process.env["LOOMBRE_RATE_REFRESH"] = "1000";
  process.env["LOOMBRE_RATE_UNLOCK"] = "1000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  settingsService = app.get(SettingsService);
  await setRestrictedEnabled();
}, 30_000);

afterAll(async () => {
  await app.close();
});

async function loginAs(username: string, password: string): Promise<{ accessToken: string; userId: string }> {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `e2e-${username}`, deviceProfile: buildDeviceProfile(username) });
  expect(res.status, `login as ${username} failed: ${JSON.stringify(res.body)}`).toBe(200);
  return { accessToken: res.body.accessToken as string, userId: res.body.user?.id as string };
}

/**
 * Creates a brand-new, restricted-content-eligible user via the real HTTP
 * surface: an admin-created account, an adult birth date (self-service
 * PATCH /users/me), and an explicit grant on the seeded "Restricted"
 * library (admin-only PUT /libraries/:id/permissions) — gates 1 (server
 * capability, set in beforeAll), 2 (age), and 4 (library grant) all real.
 * Gate 3 (opt-in + PIN) is left to each test, since that's what varies.
 */
async function createRestrictedEligibleUser(username: string, password: string): Promise<{ userId: string; accessToken: string }> {
  const adminLogin = await loginAs("admin", "loombre-seed-admin");

  const created = await request(app.getHttpServer())
    .post("/users")
    .set("Authorization", `Bearer ${adminLogin.accessToken}`)
    .send({ username, email: `${username}@example.invalid`, password, isAdmin: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const userId: string = created.body.id;

  const login = await loginAs(username, password);

  const birthDate = await request(app.getHttpServer())
    .patch("/users/me")
    .set("Authorization", `Bearer ${login.accessToken}`)
    .send({ birthDate: "1990-01-01" });
  expect(birthDate.status, JSON.stringify(birthDate.body)).toBe(200);

  const db = createDb(databaseUrl);
  try {
    const restrictedLibrary = await db
      .selectFrom("libraries")
      .select("id")
      .where("name", "=", "Restricted")
      .executeTakeFirstOrThrow();

    const grant = await request(app.getHttpServer())
      .put(`/libraries/${restrictedLibrary.id}/permissions`)
      .set("Authorization", `Bearer ${adminLogin.accessToken}`)
      .send({ permissions: [{ userId, granted: true }] });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
  } finally {
    await db.destroy();
  }

  return { userId, accessToken: login.accessToken };
}

async function latestPinResetEvent(userId: string): Promise<{ payload: Record<string, unknown>; actor_user_id: string | null } | undefined> {
  const db = createDb(databaseUrl);
  try {
    // Filtered client-side (not a `payload ->> 'userId'` SQL predicate) —
    // apps/server may not import the raw kysely `sql` tag directly
    // (dependency-cruiser's "no-raw-db-driver-outside-packages-db"); the
    // small, test-only row count here makes this the simplest compliant
    // option, same posture admin-plugin-delivery-pseudonymization-grants.
    // e2e.spec.ts's header documents for the identical constraint.
    const rows = await db
      .selectFrom("events")
      .select(["payload", "actor_user_id", "ts_ms"])
      .where("type", "=", "user.restricted-pin-reset")
      .orderBy("ts_ms", "desc")
      .execute();
    const match = rows.find((row) => (row.payload as Record<string, unknown> | null)?.["userId"] === userId);
    return match as { payload: Record<string, unknown>; actor_user_id: string | null } | undefined;
  } finally {
    await db.destroy();
  }
}

describe("loombre admin reset-pin <username> (H2)", () => {
  it("full loop: opt in -> unlock -> CLI reset -> old PIN rejected -> fresh opt-in -> event emitted", async () => {
    const username = "h2-reset-full-loop";
    const password = "correct-horse-battery-1";
    const { userId, accessToken } = await createRestrictedEligibleUser(username, password);

    // Gate 3: opt in with PIN 1234 through the real PUT /users/me/restricted
    // path (P4.22 contract — first-time opt-in requires a new PIN).
    // G3: every call requires currentPassword (F1: account-critical).
    const optIn = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ optIn: true, pin: "1234", currentPassword: password });
    expect(optIn.status, JSON.stringify(optIn.body)).toBe(200);
    expect(optIn.body).toEqual({ optIn: true, hasPin: true, unlockedUntilMs: null });

    // Gate 5: unlock succeeds — every gate (1 capability, 2 age, 3 opt-in+PIN,
    // 4 library grant) is genuinely satisfied before the reset.
    const unlockBefore = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ pin: "1234" });
    expect(unlockBefore.status, JSON.stringify(unlockBefore.body)).toBe(200);

    // The CLI reset itself, through the REAL dispatcher, with a scripted
    // confirmation (interactive stdin has no place in an automated test).
    const cliResult = await runCli({
      argv: ["admin", "reset-pin", username],
      env: {},
      nodePlatform: "linux",
      doctorDeps: UNUSED_DOCTOR_DEPS,
      adminDeps: fakeAdminDeps(true),
    });
    expect(cliResult.exitCode, JSON.stringify(cliResult)).toBe(0);
    expect(cliResult.stderr).toEqual([]);
    expect(cliResult.stdout.join("\n")).toContain(`Cleared the restricted-content PIN and opt-in for "${username}"`);
    expect(cliResult.stdout.join("\n")).toContain("brand-new 4-digit PIN");

    // The old PIN is now rejected — but not with the "wrong PIN" 401
    // (restricted.controller.ts's pinOk branch): the reset also cleared
    // restricted_opt_in, so gate 3 fails and the PRECONDITION check (gates
    // 1-4) rejects first, honestly reflecting that this account is no
    // longer opted in at all (restricted.controller.ts's own gates1through4
    // branch — 403, never a body claiming the PIN itself was wrong).
    const unlockAfterReset = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ pin: "1234" });
    expect(unlockAfterReset.status, JSON.stringify(unlockAfterReset.body)).toBe(403);

    // Fresh opt-in: the first-time-opt-in branch governs again (hash is
    // null), so a brand-new PIN is required and accepted.
    const freshOptIn = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ optIn: true, pin: "5678", currentPassword: password });
    expect(freshOptIn.status, JSON.stringify(freshOptIn.body)).toBe(200);
    expect(freshOptIn.body).toEqual({ optIn: true, hasPin: true, unlockedUntilMs: null });

    // The library grant was never touched by the reset (gate 4 persists),
    // so unlocking with the new PIN succeeds immediately.
    const unlockWithNewPin = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ pin: "5678" });
    expect(unlockWithNewPin.status, JSON.stringify(unlockWithNewPin.body)).toBe(200);

    // The audit event: right payload, never a hash/PIN, actorUserId null
    // (the CLI runs outside any authenticated session — see
    // resetRestrictedPinAndEmit's doc comment).
    const event = await latestPinResetEvent(userId);
    expect(event).toBeDefined();
    expect(event!.payload).toEqual({ userId, username, actor: "cli" });
    expect(event!.actor_user_id).toBeNull();
    expect(JSON.stringify(event!.payload)).not.toContain("1234");
    expect(JSON.stringify(event!.payload)).not.toContain("5678");
  });

  it("declined confirmation: nothing changes, no event, exit 1", async () => {
    const username = "h2-reset-declined";
    const password = "correct-horse-battery-2";
    const { userId, accessToken } = await createRestrictedEligibleUser(username, password);

    const optIn = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ optIn: true, pin: "1111", currentPassword: password });
    expect(optIn.status).toBe(200);

    const cliResult = await runCli({
      argv: ["admin", "reset-pin", username],
      env: {},
      nodePlatform: "linux",
      doctorDeps: UNUSED_DOCTOR_DEPS,
      adminDeps: fakeAdminDeps(false),
    });
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stdout).toEqual([]);
    expect(cliResult.stderr).toEqual(["aborted, nothing changed"]);

    // Still opted in with the SAME PIN — unlock still works.
    const unlock = await request(app.getHttpServer())
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ pin: "1111" });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);

    const event = await latestPinResetEvent(userId);
    expect(event).toBeUndefined();
  });

  it("unknown user: clean one-line error, exit 1, no stack", async () => {
    const cliResult = await runCli({
      argv: ["admin", "reset-pin", "no-such-loombre-user-at-all"],
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

  it("a user who never opted in: reset is a no-op, exit 0, no event", async () => {
    const username = "h2-reset-never-opted-in";
    const { userId, accessToken } = await createRestrictedEligibleUser(username, "correct-horse-battery-3");
    void accessToken;

    const cliResult = await runCli({
      argv: ["admin", "reset-pin", username],
      env: {},
      nodePlatform: "linux",
      doctorDeps: UNUSED_DOCTOR_DEPS,
      adminDeps: fakeAdminDeps(true),
    });
    expect(cliResult.exitCode).toBe(0);
    expect(cliResult.stderr).toEqual([]);
    expect(cliResult.stdout.join("\n")).toContain("no restricted-content settings to clear");

    const event = await latestPinResetEvent(userId);
    expect(event).toBeUndefined();
  });
});
