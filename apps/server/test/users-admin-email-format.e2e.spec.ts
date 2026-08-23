// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/users-admin-email-format.e2e.spec.ts
//
// Remediation api-validation-F4 (QA 2026-08-21, P2). Admin
// `PATCH /users/{id}` accepted and PERSISTED a format-invalid email:
// `{"email":"not-an-email"}` answered **200** and a follow-up GET read the
// literal string back. `updateUser`
// (apps/server/src/catalog/users.controller.ts) built the patch as a raw
// pass-through — `email: typeof body["email"] === "string" ? body["email"]
// : null` — with no `isValidEmailFormat` call and no trim, while BOTH
// sibling paths validate: `createUser` and `updateMe` each trim, then
// reject via `@loombre/shared`'s `isValidEmailFormat` (the R-F4 fix wave,
// which evidently skipped this third path).
//
// It is a contract violation, not a policy choice: `UpdateUserRequest.email`
// is `type: [string, 'null'], format: email` and the operation already
// declares a `'422'` (packages/contract/openapi.yaml) — so nothing in the
// contract or the SDK moves here, only the server catching up to what it
// already claims.
//
// Second-order but real: `users.email` is a third-party-triggerable mail
// recipient (password reset, the email-in-use notice, admin mail), so an
// address that is not an address breaks those flows at send time
// (admin-mail.controller.ts validates there) instead of at the moment an
// admin typed it.
//
// What this suite pins beyond the headline cell:
//   * every neighbouring guard is UNCHANGED — explicit `null` still clears
//     (this file's null-to-clear convention, and what the contract's
//     `[string,'null']` member means), a wrong-TYPE value still 422s
//     (api-validation-F5), a duplicate address still 409s (G9), and an
//     omitted member still leaves the stored address alone;
//   * trim-then-validate, not reject-on-whitespace — a padded address
//     normalizes into the SAME string the unique index compares, which is
//     exactly why a padded DUPLICATE must still reach the 409 (R-F4's
//     rationale on the updateMe path, asserted here for the admin path);
//   * nothing is written on a rejection — every 422 cell reads the column
//     back directly, because a 422 that still bumped the row would be the
//     same defect wearing a different status code;
//   * three-path parity: POST /users and PATCH /users/{id} reject the same
//     string, which is the invariant that actually failed here.
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
const PASSWORD = "f4-admin-email-format-pass-123";

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `users-admin-email-format-e2e-${username}-${Date.now()}-${Math.random()}`,
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

function patchUser(id: string, body: Record<string, unknown>) {
  return request(app.getHttpServer())
    .patch(`/users/${id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .set("content-type", "application/json")
    .send(body);
}

function getUser(id: string) {
  return request(app.getHttpServer()).get(`/users/${id}`).set("Authorization", `Bearer ${adminToken}`);
}

/** Reads the stored column directly. A 422 response is not by itself proof
 *  that nothing was written, and a `null` in a response body is not proof
 *  the column holds NULL rather than an empty string. */
async function storedEmail(id: string): Promise<string | null> {
  const row = await rawDb.selectFrom("users").select(["email"]).where("id", "=", id).executeTakeFirstOrThrow();
  return row.email ?? null;
}

function expectValidationProblem(res: {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.headers["content-type"]).toContain("application/problem+json");
  expect(res.body["type"]).toBe("urn:loombre:problem:validation");
  expect(res.body["status"]).toBe(422);
}

/** A fresh target user with a known-good stored address, so every cell can
 *  assert "the address I started with is the address that is still there". */
let seq = 0;
async function freshTarget(): Promise<{ id: string; username: string; email: string }> {
  seq += 1;
  const username = `f4-target-${seq}-${Date.now()}`;
  const email = `${username}@example.test`;
  const created = await createUser({ username, email, password: PASSWORD });
  if (created.status !== 201) {
    throw new Error(`freshTarget failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  return { id: created.body.id as string, username, email };
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_users_admin_email_format");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "users-admin-email-format-e2e-secret-not-for-production";
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

describe("api-validation-F4: PATCH /users/{id} (admin) validates the email FORMAT", () => {
  it("422s on the cited body `{\"email\":\"not-an-email\"}` and persists nothing", async () => {
    const target = await freshTarget();

    const res = await patchUser(target.id, { email: "not-an-email" });

    expectValidationProblem(res);
    expect(await storedEmail(target.id)).toBe(target.email);

    const readback = await getUser(target.id);
    expect(readback.status, JSON.stringify(readback.body)).toBe(200);
    expect(readback.body.email).toBe(target.email);
  }, 20_000);

  // The R-F4 corpus the sibling paths already reject, applied to this one.
  const REJECTED: ReadonlyArray<readonly [label: string, value: string]> = [
    ["a bare word", "not-an-email"],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["a local part with no domain", "user@"],
    ["a domain with no local part", "@example.test"],
    ["no @ at all", "plainaddress"],
    ["an embedded space", "first last@example.test"],
    ["a CRLF header-injection payload", "victim@example.test\r\nBcc: evil@example.test"],
    ["an embedded newline", "victim@example.test\nevil@example.test"],
    ["an embedded NUL", "victim@example.test\u0000"],
    ["two @ signs", "a@b@example.test"],
  ];

  for (const [label, value] of REJECTED) {
    it(`422s on ${label}, leaving the stored address untouched`, async () => {
      const target = await freshTarget();

      const res = await patchUser(target.id, { email: value });

      expectValidationProblem(res);
      expect(await storedEmail(target.id)).toBe(target.email);
    }, 20_000);
  }

  it("trims a whitespace-padded address before validating and storing it (R-F4 shape)", async () => {
    const target = await freshTarget();
    const padded = `  f4-padded-${Date.now()}@example.test  `;

    const res = await patchUser(target.id, { email: padded });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.email).toBe(padded.trim());
    expect(await storedEmail(target.id)).toBe(padded.trim());
  }, 20_000);

  it("still reaches the 409 when a PADDED address duplicates an existing one (trim, then compare)", async () => {
    const victim = await freshTarget();
    const target = await freshTarget();

    const res = await patchUser(target.id, { email: `  ${victim.email}  ` });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.type).toBe("urn:loombre:problem:conflict");
    expect(await storedEmail(target.id)).toBe(target.email);
  }, 20_000);
});

describe("api-validation-F4: the neighbouring guards are NOT changed", () => {
  it("explicit `email: null` still clears the address (null-to-clear bypasses the format check)", async () => {
    const target = await freshTarget();

    const res = await patchUser(target.id, { email: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.email).toBeNull();
    expect(await storedEmail(target.id)).toBeNull();
  }, 20_000);

  it("a valid address still saves (200)", async () => {
    const target = await freshTarget();
    const next = `f4-valid-${Date.now()}@example.test`;

    const res = await patchUser(target.id, { email: next });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.email).toBe(next);
    expect(await storedEmail(target.id)).toBe(next);
  }, 20_000);

  it("an omitted email member leaves the stored address alone", async () => {
    const target = await freshTarget();

    const res = await patchUser(target.id, { displayName: "F4 Untouched" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.displayName).toBe("F4 Untouched");
    expect(await storedEmail(target.id)).toBe(target.email);
  }, 20_000);

  it("a wrong-TYPE email still 422s via api-validation-F5's type check, not the format check", async () => {
    const target = await freshTarget();

    const res = await patchUser(target.id, { email: 42 });

    expectValidationProblem(res);
    expect(String(res.body["detail"])).toBe("email must be a string or null.");
    expect(await storedEmail(target.id)).toBe(target.email);
  }, 20_000);

  it("a duplicate address still answers 409, not 422 (G9 untouched)", async () => {
    const victim = await freshTarget();
    const target = await freshTarget();

    const res = await patchUser(target.id, { email: victim.email });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.type).toBe("urn:loombre:problem:conflict");
    expect(await storedEmail(target.id)).toBe(target.email);
  }, 20_000);
});

describe("api-validation-F4: the three user-email write paths agree", () => {
  it("POST /users rejects the same string PATCH /users/{id} now rejects", async () => {
    const target = await freshTarget();

    const created = await createUser({
      username: `f4-parity-${Date.now()}`,
      email: "not-an-email",
      password: PASSWORD,
    });
    const patched = await patchUser(target.id, { email: "not-an-email" });

    expectValidationProblem(created);
    expectValidationProblem(patched);
    expect(String(patched.body["detail"])).toBe(String(created.body["detail"]));
  }, 20_000);
});
