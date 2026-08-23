// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/users-duplicate-conflict.e2e.spec.ts
//
// Remediation api-validation-F2 (P1, dup browser-admin/browser-admin-F4):
// POST /users with an already-taken username answered HTTP 500
// `urn:loombre:problem:internal`. `createUser` handed the body straight to
// `createUserAdminAndEmit` with no duplicate pre-check and no unique-
// violation catch, so `users_username_key`'s 23505 travelled uncaught to
// ProblemJsonExceptionFilter's generic `@Catch()` and rendered an internal
// error for ordinary, user-typo-level input. `users_email_key` (CITEXT
// UNIQUE, still unique when present after 0023) had the identical hole on
// the same handler — the finding's verifier reproduced both.
//
// The contrast path the finding cites is PATCH /users/{id} (G9,
// users.controller.ts): an admin email conflict there has mapped to a real
// 409 for a while. This suite pins the same posture on the CREATE side, for
// BOTH constraints, and asserts the 409 names the right one — a free
// username must never surface as a (false) username conflict when it was
// the email that collided (the same distinct-constraint discipline
// packages/db/src/query/invites.ts's claim transaction already applies).
//
// Enumeration posture: admins already enumerate every account via
// GET /users, so a truthful 409 leaks nothing here — G9's own analysis,
// unchanged. (The self-serve invite-claim path stays silent-drop; that is a
// different flow with a different threat model and is NOT touched here.)
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed), same
// convention as every other apps/server e2e file in this package.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
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
const PASSWORD = "dup-conflict-pass-123";

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `users-dup-conflict-e2e-${username}-${Date.now()}-${Math.random()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

function createUser(body: Record<string, unknown>) {
  return request(app.getHttpServer())
    .post("/users")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("content-type", "application/json")
    .send(body);
}

async function countUsersNamed(username: string): Promise<number> {
  const row = await rawDb
    .selectFrom("users")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("username", "=", username)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_users_dup_conflict");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "users-dup-conflict-e2e-test-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
  adminToken = await loginAs("admin", ADMIN_PASSWORD);
});

afterAll(async () => {
  await app?.close();
  await rawDb?.destroy();
  delete process.env["LOOMBRE_RATE_LOGIN"];
});

describe("api-validation-F2: POST /users duplicate username -> 409, never 500", () => {
  it("answers 409 problem+json on a repeat of the exact same create, and writes no second row", async () => {
    const username = "qa-val-dup-user";

    const first = await createUser({ username, password: PASSWORD });
    expect(first.status).toBe(201);
    expect(first.body.username).toBe(username);

    const second = await createUser({ username, password: PASSWORD });

    expect(second.status).toBe(409);
    expect(second.headers["content-type"]).toContain("application/problem+json");
    expect(second.body).toMatchObject({
      type: "urn:loombre:problem:conflict",
      title: "Conflict",
      status: 409,
      instance: "/users",
    });
    expect(String(second.body.detail)).toMatch(/username/i);

    expect(await countUsersNamed(username)).toBe(1);
  });

  it("treats a case-only variant as the same taken username (CITEXT), still 409", async () => {
    const username = "qa-val-dup-case";

    expect((await createUser({ username, password: PASSWORD })).status).toBe(201);

    const clash = await createUser({ username: username.toUpperCase(), password: PASSWORD });
    expect(clash.status).toBe(409);
    expect(String(clash.body.detail)).toMatch(/username/i);
    expect(await countUsersNamed(username)).toBe(1);
  });

  it("answers 409 (not 500, and not a bogus username conflict) when only the EMAIL is taken", async () => {
    const email = "qa-val-dup@example.test";

    expect((await createUser({ username: "qa-val-dup-email-a", email, password: PASSWORD })).status).toBe(201);

    const clash = await createUser({ username: "qa-val-dup-email-b", email, password: PASSWORD });

    expect(clash.status).toBe(409);
    expect(clash.headers["content-type"]).toContain("application/problem+json");
    expect(clash.body.type).toBe("urn:loombre:problem:conflict");
    // The 409 must blame the constraint that actually fired: this username
    // is free, so wording that accuses it would be plainly wrong.
    expect(String(clash.body.detail)).toMatch(/email/i);
    expect(await countUsersNamed("qa-val-dup-email-b")).toBe(0);
  });

  it("still creates a genuinely free username/email pair (the fix narrows nothing)", async () => {
    const created = await createUser({
      username: "qa-val-dup-free",
      email: "qa-val-dup-free@example.test",
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    expect(created.body.username).toBe("qa-val-dup-free");
  });
});
