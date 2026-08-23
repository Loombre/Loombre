// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/users-create-email-null.e2e.spec.ts
//
// Remediation browser-admin-F3 (QA 2026-08-21, P1). `POST /users` with an
// EXPLICIT `email: null` answered 422 "email must be a non-empty string
// when present." — over-rejection of a body the contract declares valid.
// `CreateUserRequest.email` is `type: [string, 'null']`
// (packages/contract/openapi.yaml), M1 made an email-less user a real
// feature, and the admin UI's Add-user sheet
// (apps/web/src/components/settings/sections/AddUserSheet.tsx) sends
// `email: email || null` for a blank field, citing exactly that contract.
// Net effect: the E4/M1 email-less-user feature was UNREACHABLE from the
// UI — every blank-email submit 422'd.
//
// The controller's own PATCH /users/{id} handler has always accepted
// explicit null (null-to-clear), so the CREATE-side rejection contradicted
// both the contract AND the file's own convention. This suite pins the
// parity: on POST, `null` means "no email" exactly as an omitted member
// does, and BOTH still leave every other guard in place —
//   * a present-but-wrong-TYPE value still 422s (api-validation-F5),
//   * an empty string still 422s (never stored as an address),
//   * a syntactically invalid address still 422s (R-F4's isValidEmailFormat),
//   * a whitespace-padded address is still trimmed before storage (R-F4),
//   * duplicate detection is untouched (api-validation-F2).
//
// Multi-NULL coexistence is asserted deliberately: `users_email_key` is
// UNIQUE and Postgres treats NULLs as mutually distinct
// (migrations/0023_user_invites.sql says so in the column comment), so any
// number of email-less users may exist. Without that cell a "fix" that
// stored `''` instead of NULL would look green on the headline case and
// then 409 on the second email-less user.
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
    video: [],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let adminToken: string;
let rawDb: ReturnType<typeof createDb>;

const ADMIN_PASSWORD = "loombre-seed-admin";
const PASSWORD = "f3-email-null-pass-123";

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `users-create-email-null-e2e-${username}-${Date.now()}-${Math.random()}`,
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

function getUser(id: string) {
  return request(app.getHttpServer()).get(`/users/${id}`).set("Authorization", `Bearer ${adminToken}`);
}

function patchUser(id: string, body: Record<string, unknown>) {
  return request(app.getHttpServer())
    .patch(`/users/${id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("content-type", "application/json")
    .send(body);
}

/** Reads the stored column directly: a response of `null` is not proof the
 *  DB holds NULL rather than an empty string. */
async function storedEmail(username: string): Promise<string | null> {
  const row = await rawDb
    .selectFrom("users")
    .select(["email"])
    .where("username", "=", username)
    .executeTakeFirstOrThrow();
  return row.email ?? null;
}

async function userExists(username: string): Promise<boolean> {
  const row = await rawDb
    .selectFrom("users")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("username", "=", username)
    .executeTakeFirstOrThrow();
  return Number(row.n) > 0;
}

function expectValidationProblem(res: { status: number; headers: Record<string, string>; body: Record<string, unknown> }) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.headers["content-type"]).toContain("application/problem+json");
  expect(res.body["type"]).toBe("urn:loombre:problem:validation");
  expect(res.body["status"]).toBe(422);
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_users_create_email_null");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "users-create-email-null-e2e-secret-not-for-production";
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

describe("browser-admin-F3: POST /users accepts an explicit email: null", () => {
  it("creates an email-less user on `email: null` (the cited cell)", async () => {
    const username = "f3-email-explicit-null";

    const res = await createUser({ username, email: null, password: PASSWORD });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.username).toBe(username);
    expect(res.body.email).toBeNull();
    expect(await storedEmail(username)).toBeNull();

    const readback = await getUser(res.body.id as string);
    expect(readback.status, JSON.stringify(readback.body)).toBe(200);
    expect(readback.body.email).toBeNull();
  }, 20_000);

  it("treats `email: null` exactly like an omitted email (parity control)", async () => {
    const omitted = await createUser({ username: "f3-email-omitted", password: PASSWORD });
    expect(omitted.status, JSON.stringify(omitted.body)).toBe(201);
    expect(omitted.body.email).toBeNull();
    expect(await storedEmail("f3-email-omitted")).toBeNull();
  }, 20_000);

  it("accepts the exact body shape AddUserSheet serializes for a blank Email field", async () => {
    // apps/web/src/components/settings/sections/AddUserSheet.tsx: every
    // member present, `email: email || null`, `maxContentRating: … || null`.
    const res = await createUser({
      username: "f3-sheet-shape",
      email: null,
      password: PASSWORD,
      displayName: "F3 Sheet Shape",
      isAdmin: false,
      maxContentRating: null,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.email).toBeNull();
    expect(res.body.displayName).toBe("F3 Sheet Shape");
    expect(res.body.isAdmin).toBe(false);
    expect(res.body.maxContentRating).toBeNull();
  }, 20_000);

  it("lets any number of email-less users coexist (NULLs are distinct under users_email_key)", async () => {
    const a = await createUser({ username: "f3-null-coexist-a", email: null, password: PASSWORD });
    const b = await createUser({ username: "f3-null-coexist-b", email: null, password: PASSWORD });

    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(await storedEmail("f3-null-coexist-a")).toBeNull();
    expect(await storedEmail("f3-null-coexist-b")).toBeNull();
  }, 20_000);

  it("can give an email-less user an address afterwards, and clear it again (PATCH parity)", async () => {
    const created = await createUser({ username: "f3-null-then-patch", email: null, password: PASSWORD });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;

    const set = await patchUser(id, { email: "f3-null-then-patch@example.test" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.email).toBe("f3-null-then-patch@example.test");

    const cleared = await patchUser(id, { email: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.email).toBeNull();
    expect(await storedEmail("f3-null-then-patch")).toBeNull();
  }, 20_000);
});

describe("browser-admin-F3: the surrounding email guards are NOT loosened", () => {
  const REJECTED: ReadonlyArray<readonly [label: string, username: string, email: unknown]> = [
    ["an empty string (never stored as an address)", "f3-email-empty", ""],
    ["a whitespace-only string", "f3-email-blank", "   "],
    ["a number", "f3-email-number", 42],
    ["a boolean", "f3-email-boolean", false],
    ["an object", "f3-email-object", { address: "x@example.test" }],
    ["an array", "f3-email-array", ["x@example.test"]],
    ["a syntactically invalid address", "f3-email-malformed", "not-an-email"],
  ];

  for (const [label, username, email] of REJECTED) {
    it(`422s on ${label}, and creates NO user`, async () => {
      const res = await createUser({ username, email, password: PASSWORD });
      expectValidationProblem(res);
      expect(await userExists(username)).toBe(false);
    }, 20_000);
  }

  it("still trims a whitespace-padded address before storing it (R-F4)", async () => {
    const res = await createUser({
      username: "f3-email-padded",
      email: "  f3-padded@example.test  ",
      password: PASSWORD,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.email).toBe("f3-padded@example.test");
    expect(await storedEmail("f3-email-padded")).toBe("f3-padded@example.test");
  }, 20_000);

  it("still answers 409 on a duplicate address (api-validation-F2 untouched)", async () => {
    const email = "f3-dup@example.test";
    expect((await createUser({ username: "f3-dup-a", email, password: PASSWORD })).status).toBe(201);

    const clash = await createUser({ username: "f3-dup-b", email, password: PASSWORD });
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
    expect(String(clash.body.detail)).toMatch(/email/i);
    expect(await userExists("f3-dup-b")).toBe(false);
  }, 20_000);
});
