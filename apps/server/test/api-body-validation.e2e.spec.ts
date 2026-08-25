// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/api-body-validation.e2e.spec.ts
//
// api-validation-F5 (QA 2026-08-21 remediation, P1). This house validates
// request bodies BY HAND (no class-validator, no zod — see
// users.controller.ts's SETTINGS_BODY_KEYS/UPDATE_ME_BODY_KEYS comments),
// and the pattern was applied unevenly: `PATCH /users/me`,
// `POST /users/{id}/reset-password` and `PUT /users/me/settings` all
// rejected an unknown property with 422, while `POST /users`,
// `PATCH /users/{id}`, `POST /libraries`, `PATCH /libraries/{id}` and
// `POST /libraries/{id}/scan` had NO allowlist at all — every one of their
// request schemas declares `additionalProperties: false` in
// packages/contract/openapi.yaml, so an unknown key was a contract
// violation that answered 201/200/202 AND performed the mutation.
//
// Two silent-divergence shapes, not one:
//   1. Unknown keys were accepted and dropped (a client typo — `isAdmin`
//      vs `admin` — looked like it worked).
//   2. Wrong-TYPED values were coerced instead of refused:
//      `{"full":"yes"}` on scan silently became an INCREMENTAL scan
//      (`(rawBody ?? {})["full"] === true` was the whole check), and the
//      nullable members of createUser/updateUser used
//      `typeof x === "string" ? x : null`, so a type mistake CLEARED the
//      stored value rather than failing.
//
// This suite is the regression net for both: every rejected request must
// be 422 `application/problem+json` `urn:loombre:problem:validation`, and
// must leave the server EXACTLY as it found it (no row created, no
// updated_at bump, no job enqueued). Every well-typed request — explicit
// `null` on a nullable member included — must still succeed unchanged.
//
// ROUND 2 (verifier verdict PARTIAL on the first fix): that fix scoped the
// type checks to createUser/updateUser and the libraries handlers and left
// `PATCH /users/me`'s `typeof x === "string" ? x : null` coercion alone,
// claiming api-validation-F3 had pinned it — but this finding's OWN repro
// list carries `PATCH /users/me {"displayName":123} -> 200` and its
// expected outcome is "422 for every case … UpdateMeRequest". A wrong-typed
// displayName/birthDate/email on /users/me silently CLEARED the caller's
// stored value (verified live: it wiped a just-set displayName, and a
// numeric birthDate wiped the stored date). updateMe now refuses a
// present-but-wrong-typed nullable member with the same 422 updateUser
// uses; an explicit `null` still clears (that is what the contract's
// `[string,'null']` means). The one F3 case that asserted the old clearing
// as intended (users-birthdate-validation.e2e.spec.ts) was flipped in the
// same commit.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { parse as parseYaml } from "yaml";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const CONTRACT_PATH = path.resolve(__dirname, "../../../packages/contract/openapi.yaml");
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
let targetUserId: string;
let targetLibraryId: string;

function admin() {
  return {
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${adminToken}`),
    post: (url: string, body?: unknown) => {
      const req = request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`);
      return body === undefined ? req : req.send(body as object);
    },
    patch: (url: string, body: unknown) =>
      request(app.getHttpServer())
        .patch(url)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body as object),
    put: (url: string, body: unknown) =>
      request(app.getHttpServer())
        .put(url)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body as object),
  };
}

/** Every rejection this suite asserts has the same wire shape. */
function expectValidationProblem(res: { status: number; headers: Record<string, string>; body: Record<string, unknown> }) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.headers["content-type"]).toContain("application/problem+json");
  expect(res.body["type"]).toBe("urn:loombre:problem:validation");
  expect(res.body["status"]).toBe(422);
}

async function listUsernames(): Promise<string[]> {
  const res = await admin().get("/users?limit=200");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as Array<{ username: string }>).map((u) => u.username);
}

async function listLibraryNames(): Promise<string[]> {
  const res = await admin().get("/libraries?limit=200");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as Array<{ name: string }>).map((l) => l.name);
}

async function getUserSnapshot(id: string): Promise<Record<string, unknown>> {
  const res = await admin().get(`/users/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Record<string, unknown>;
}

async function getLibrarySnapshot(id: string): Promise<Record<string, unknown>> {
  const res = await admin().get(`/libraries/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Record<string, unknown>;
}

/** How "no job was enqueued" is proved: the `jobs` ledger every enqueue
 *  writes through (@loombre/jobs' queue mirrors into it), read back over
 *  the same HTTP surface. No worker runs in-process, so an enqueued scan
 *  simply stays queued and is counted.
 *
 *  If this ever fails with a 401 whose body is NOT problem+json, it is the
 *  known mid-suite flake this package's vitest.config.ts header describes
 *  (seen once on a full-suite run, green on the immediate re-run and in
 *  every isolated run) — re-run before believing it. */
async function countJobs(): Promise<number> {
  const res = await admin().get("/admin/jobs?limit=200");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as unknown[]).length;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_api_body_validation");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "api-body-validation-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const login = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "api-body-validation-admin",
    deviceProfile: buildDeviceProfile("api-body-validation-admin"),
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  adminToken = login.body.accessToken;

  const user = await admin().post("/users", {
    username: "f5-target",
    password: "f5-target-password",
    displayName: "F5 Target",
    email: "f5-target@example.test",
    maxContentRating: "PG-13",
  });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  targetUserId = user.body.id;

  const library = await admin().post("/libraries", {
    name: "F5 Target Library",
    mediaKind: "movie",
    paths: ["/data/f5-target"],
  });
  expect(library.status, JSON.stringify(library.body)).toBe(201);
  targetLibraryId = library.body.id;
}, 180_000);

afterAll(async () => {
  await app?.close();
  delete process.env["LOOMBRE_RATE_LOGIN"];
});

// ─────────────────────────────── POST /users ────────────────────────────────
// CreateUserRequest: additionalProperties:false; username/password string,
// email/displayName/maxContentRating [string,'null'], isAdmin boolean.
describe("POST /users body validation (CreateUserRequest additionalProperties:false)", () => {
  const REJECTED: ReadonlyArray<readonly [label: string, body: Record<string, unknown>]> = [
    ["an unknown property", { username: "f5-bogus-key", password: "pw123456", bogus: true }],
    ["a misspelled known property", { username: "f5-typo-key", password: "pw123456", admin: true }],
    ["isAdmin as a string", { username: "f5-isadmin-string", password: "pw123456", isAdmin: "yes" }],
    ["isAdmin as null (not a nullable member)", { username: "f5-isadmin-null", password: "pw123456", isAdmin: null }],
    ["displayName as a number", { username: "f5-display-number", password: "pw123456", displayName: 123 }],
    [
      "maxContentRating as a number",
      { username: "f5-rating-number", password: "pw123456", maxContentRating: 5 },
    ],
    ["username as a number", { username: 42, password: "pw123456" }],
    ["password as a number", { username: "f5-password-number", password: 12345678 }],
  ];

  for (const [label, body] of REJECTED) {
    it(`422s on ${label}, and creates NO user`, async () => {
      const before = await listUsernames();
      const res = await admin().post("/users", body);
      expectValidationProblem(res);
      const after = await listUsernames();
      expect(after.sort()).toEqual(before.sort());
    }, 20_000);
  }

  it("still accepts a well-typed body, explicit nulls on the nullable members included", async () => {
    const res = await admin().post("/users", {
      username: "f5-well-typed",
      password: "pw123456",
      displayName: null,
      maxContentRating: null,
      isAdmin: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.username).toBe("f5-well-typed");
    expect(res.body.displayName).toBeNull();
    expect(res.body.maxContentRating).toBeNull();
    expect(res.body.isAdmin).toBe(false);
  }, 20_000);

  it("still accepts a well-typed body carrying every member", async () => {
    const res = await admin().post("/users", {
      username: "f5-full-body",
      password: "pw123456",
      email: "f5-full-body@example.test",
      displayName: "F5 Full Body",
      maxContentRating: "PG",
      isAdmin: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.email).toBe("f5-full-body@example.test");
    expect(res.body.displayName).toBe("F5 Full Body");
    expect(res.body.maxContentRating).toBe("PG");
    expect(res.body.isAdmin).toBe(true);
  }, 20_000);

  // The over-rejection this suite left unpinned on purpose — `email: null`
  // 422'd even though CreateUserRequest types it `[string,'null']` and
  // AddUserSheet sends exactly that for a blank field — was fixed as
  // browser-admin-F3. Its own suite
  // (users-create-email-null.e2e.spec.ts) carries the full matrix; this
  // one cell lives here so the F5 allowlist and the F3 acceptance can
  // never drift apart unnoticed.
  it("accepts an explicit email: null on a nullable member (browser-admin-F3)", async () => {
    const res = await admin().post("/users", {
      username: "f5-email-null",
      password: "pw123456",
      email: null,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.email).toBeNull();
  }, 20_000);
});

// ────────────────────────────── PATCH /users/{id} ───────────────────────────
// UpdateUserRequest: additionalProperties:false; email/displayName/
// maxContentRating [string,'null'], isAdmin boolean.
describe("PATCH /users/{id} body validation (UpdateUserRequest additionalProperties:false)", () => {
  const REJECTED: ReadonlyArray<readonly [label: string, body: Record<string, unknown>]> = [
    ["an unknown property", { bogus: 1 }],
    ["a member this schema does not carry (birthDate is UpdateMeRequest-only)", { birthDate: "1988-03-14" }],
    ["a member this schema does not carry (username is immutable here)", { username: "renamed" }],
    ["isAdmin as a string — the cited case", { isAdmin: "yes" }],
    ["isAdmin as null (not a nullable member)", { isAdmin: null }],
    ["displayName as a number", { displayName: 123 }],
    ["email as a number", { email: 42 }],
    ["maxContentRating as a number", { maxContentRating: 7 }],
  ];

  for (const [label, body] of REJECTED) {
    it(`422s on ${label}, and mutates NOTHING`, async () => {
      const before = await getUserSnapshot(targetUserId);
      const res = await admin().patch(`/users/${targetUserId}`, body);
      expectValidationProblem(res);
      const after = await getUserSnapshot(targetUserId);
      expect(after).toEqual(before);
    }, 20_000);
  }

  it("still applies a well-typed update", async () => {
    const res = await admin().patch(`/users/${targetUserId}`, { displayName: "F5 Renamed", isAdmin: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.displayName).toBe("F5 Renamed");
    const restore = await admin().patch(`/users/${targetUserId}`, { displayName: "F5 Target" });
    expect(restore.status).toBe(200);
  }, 20_000);

  it("still honours explicit null on a nullable member (null-to-clear survives)", async () => {
    const cleared = await admin().patch(`/users/${targetUserId}`, { maxContentRating: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.maxContentRating).toBeNull();
    const restore = await admin().patch(`/users/${targetUserId}`, { maxContentRating: "PG-13" });
    expect(restore.status).toBe(200);
    expect(restore.body.maxContentRating).toBe("PG-13");
  }, 20_000);
});

// ────────────────────────────── POST /libraries ─────────────────────────────
describe("POST /libraries body validation (CreateLibraryRequest additionalProperties:false)", () => {
  const REJECTED: ReadonlyArray<readonly [label: string, body: Record<string, unknown>]> = [
    ["an unknown property — the cited case", { name: "f5-lib-bogus", mediaKind: "movie", paths: ["/tmp/empty"], bogus: 1 }],
    [
      "a misspelled known property",
      { name: "f5-lib-typo", mediaKind: "movie", paths: ["/tmp/empty"], contentclass: "general" },
    ],
  ];

  for (const [label, body] of REJECTED) {
    it(`422s on ${label}, and creates NO library`, async () => {
      const before = await listLibraryNames();
      const res = await admin().post("/libraries", body);
      expectValidationProblem(res);
      const after = await listLibraryNames();
      expect(after.sort()).toEqual(before.sort());
    }, 20_000);
  }

  it("still accepts a well-typed body", async () => {
    const res = await admin().post("/libraries", {
      name: "F5 Well Typed Library",
      mediaKind: "tv",
      paths: ["/data/f5-well-typed"],
      contentClass: "general",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.name).toBe("F5 Well Typed Library");
  }, 20_000);
});

// ───────────────────────────── PATCH /libraries/{id} ────────────────────────
describe("PATCH /libraries/{id} body validation (UpdateLibraryRequest additionalProperties:false)", () => {
  const REJECTED: ReadonlyArray<readonly [label: string, body: Record<string, unknown>]> = [
    ["an unknown property — the cited silent no-op", { bogus: 1 }],
    ["a member this schema does not carry (mediaKind is create-only)", { mediaKind: "tv" }],
    ["a member this schema does not carry (contentClass is create-only)", { contentClass: "restricted" }],
  ];

  for (const [label, body] of REJECTED) {
    it(`422s on ${label}, and does NOT bump updatedAtMs`, async () => {
      const before = await getLibrarySnapshot(targetLibraryId);
      const res = await admin().patch(`/libraries/${targetLibraryId}`, body);
      expectValidationProblem(res);
      const after = await getLibrarySnapshot(targetLibraryId);
      expect(after).toEqual(before);
    }, 20_000);
  }

  it("still applies a well-typed update", async () => {
    const res = await admin().patch(`/libraries/${targetLibraryId}`, { name: "F5 Target Library Renamed" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.name).toBe("F5 Target Library Renamed");
    const restore = await admin().patch(`/libraries/${targetLibraryId}`, { name: "F5 Target Library" });
    expect(restore.status).toBe(200);
  }, 20_000);
});

// ──────────────────────── POST /libraries/{id}/scan ─────────────────────────
// ScanLibraryRequest: additionalProperties:false, `full` boolean (default
// false). `{"full":"yes"}` used to enqueue a real INCREMENTAL scan job —
// the caller asked for a full rescan and silently got the other one.
describe("POST /libraries/{id}/scan body validation (ScanLibraryRequest additionalProperties:false)", () => {
  const REJECTED: ReadonlyArray<readonly [label: string, body: Record<string, unknown>]> = [
    ['full as the string "yes" — the cited silent downgrade', { full: "yes" }],
    ['full as the string "true"', { full: "true" }],
    ["full as a number", { full: 1 }],
    ["full as null (not a nullable member)", { full: null }],
    ["an unknown property", { bogus: true }],
    ["an unknown property alongside a valid full", { full: true, bogus: true }],
  ];

  for (const [label, body] of REJECTED) {
    it(`422s on ${label}, and enqueues NO job`, async () => {
      const before = await countJobs();
      const res = await admin().post(`/libraries/${targetLibraryId}/scan`, body);
      expectValidationProblem(res);
      const after = await countJobs();
      expect(after).toBe(before);
    }, 20_000);
  }

  it("still enqueues on an explicit full:true", async () => {
    const res = await admin().post(`/libraries/${targetLibraryId}/scan`, { full: true });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(typeof res.body.jobId).toBe("string");
  }, 20_000);

  it("still enqueues on an explicit full:false", async () => {
    const res = await admin().post(`/libraries/${targetLibraryId}/scan`, { full: false });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(typeof res.body.jobId).toBe("string");
  }, 20_000);

  it("still enqueues with no body at all (the contract makes the body optional)", async () => {
    const res = await admin().post(`/libraries/${targetLibraryId}/scan`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(typeof res.body.jobId).toBe("string");
  }, 20_000);
});

// ────────────────────────────── PATCH /users/me ─────────────────────────────
// UpdateMeRequest: displayName/email/birthDate are all `[string,'null']`.
// Round 2 of this finding: a present-but-wrong-typed value must 422 and
// leave the stored value AND updatedAtMs untouched — the old coercion
// CLEARED the stored value instead. Explicit `null` still clears. The
// caller here is the seeded admin acting on their own profile (seed state:
// displayName null, email admin@loombre.local, birthDate 1988-03-14).
describe("PATCH /users/me body validation (UpdateMeRequest wrong-typed nullable members)", () => {
  const ADMIN_PASSWORD = "loombre-seed-admin";
  const SEEDED_EMAIL = "admin@loombre.local";
  const SEEDED_BIRTH_DATE = "1988-03-14";

  async function getMe(): Promise<Record<string, unknown>> {
    const res = await admin().get("/users/me");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Record<string, unknown>;
  }

  it("422s on displayName as a number — the verifier's live repro — and does NOT clear a just-set value", async () => {
    const set = await admin().patch("/users/me", { displayName: "QA Verify Admin" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const before = await getMe();
    expect(before["displayName"]).toBe("QA Verify Admin");

    const res = await admin().patch("/users/me", { displayName: 123 });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe("displayName must be a string or null.");
    expect(res.body["instance"]).toBe("/users/me");

    const after = await getMe();
    expect(after["displayName"]).toBe("QA Verify Admin");
    expect(after["updatedAtMs"]).toBe(before["updatedAtMs"]);

    const restore = await admin().patch("/users/me", { displayName: null });
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    expect(restore.body.displayName).toBeNull();
  }, 20_000);

  it("422s on displayName as a boolean", async () => {
    const res = await admin().patch("/users/me", { displayName: true });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe("displayName must be a string or null.");
  }, 20_000);

  it("422s on birthDate as a number — the sibling clear — and keeps the stored date", async () => {
    const before = await getMe();
    expect(before["birthDate"]).toBe(SEEDED_BIRTH_DATE);

    const res = await admin().patch("/users/me", { birthDate: 19880314 });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe("birthDate must be a string or null.");

    const after = await getMe();
    expect(after["birthDate"]).toBe(SEEDED_BIRTH_DATE);
    expect(after["updatedAtMs"]).toBe(before["updatedAtMs"]);
  }, 20_000);

  it("422s on email as a number even with a CORRECT currentPassword, and does not clear the stored address", async () => {
    const before = await getMe();
    expect(before["email"]).toBe(SEEDED_EMAIL);

    const res = await admin().patch("/users/me", { email: 42, currentPassword: ADMIN_PASSWORD });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe("email must be a string or null.");

    const after = await getMe();
    expect(after["email"]).toBe(SEEDED_EMAIL);
    expect(after["updatedAtMs"]).toBe(before["updatedAtMs"]);
  }, 20_000);

  it("explicit null still clears displayName — null-to-clear is for null, not for type mistakes", async () => {
    const set = await admin().patch("/users/me", { displayName: "Clear Me" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    const cleared = await admin().patch("/users/me", { displayName: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.displayName).toBeNull();
  }, 20_000);

  it("explicit null (with currentPassword) still clears email, and a well-typed value restores it", async () => {
    const cleared = await admin().patch("/users/me", { email: null, currentPassword: ADMIN_PASSWORD });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.email).toBeNull();

    const restored = await admin().patch("/users/me", { email: SEEDED_EMAIL, currentPassword: ADMIN_PASSWORD });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.email).toBe(SEEDED_EMAIL);
  }, 20_000);
});

// The `detail` is the only part of a 422 a human ever reads, and the whole
// point of this finding is that a client could not tell a dropped key from
// an applied one — so the message has to NAME the offending member.
describe("api-validation-F5 rejection details name the offending member", () => {
  it('POST /users -> Unknown property "bogus".', async () => {
    const res = await admin().post("/users", { username: "f5-detail", password: "pw123456", bogus: true });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('Unknown property "bogus".');
    expect(res.body["instance"]).toBe("/users");
  }, 20_000);

  it("PATCH /users/{id} -> isAdmin must be a boolean.", async () => {
    const res = await admin().patch(`/users/${targetUserId}`, { isAdmin: "yes" });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe("isAdmin must be a boolean.");
  }, 20_000);

  it('PATCH /libraries/{id} -> Unknown property "mediaKind".', async () => {
    const res = await admin().patch(`/libraries/${targetLibraryId}`, { mediaKind: "tv" });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('Unknown property "mediaKind".');
  }, 20_000);

  it("POST /libraries/{id}/scan -> full must be a boolean.", async () => {
    const res = await admin().post(`/libraries/${targetLibraryId}/scan`, { full: "yes" });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe("full must be a boolean.");
    expect(res.body["instance"]).toBe(`/libraries/${targetLibraryId}/scan`);
  }, 20_000);
});

// ────────────────── PUT /libraries/{id}/permissions (d3-b5) ──────────────────
// F5 enforced `additionalProperties: false` on the five endpoints its report
// named — all of them FLAT bodies. This one was outside that list and is the
// only request body in this controller with a NESTED shape: LibraryPermissionSet
// is `additionalProperties:false` with `permissions` an array of
// LibraryPermission, itself `additionalProperties:false` (userId, granted).
// Neither level was enforced: an unknown key at the top OR inside any array
// entry answered 200 and performed the grant/revoke anyway, so a client typo
// (`user` for `userId`, `allowed` for `granted`) looked like it worked.
//
// The web's own callers send `{ libraryId, permissions: [{ userId, granted }] }`
// (LibrariesSection.tsx:161, AddLibrarySheet.tsx:168, UsersSection.tsx:161), so
// `libraryId` must stay ACCEPTED — the fix is an allowlist, not a narrowing.
describe("PUT /libraries/{id}/permissions body validation (nested additionalProperties:false)", () => {
  let permsLibraryId: string;

  /** Its own library: putLibraryPermissionsAdmin applies a DELTA (grant the
   *  listed userIds, revoke the ones sent `granted:false`), so a stray write
   *  here would silently change what a later cell — or another describe in
   *  this file — sees on targetLibraryId. */
  beforeAll(async () => {
    const created = await admin().post("/libraries", {
      name: "d3-b5 Permissions Library",
      mediaKind: "movie",
      paths: ["/data/d3-b5-permissions"],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    permsLibraryId = created.body.id;
  }, 30_000);

  async function grantedUserIds(): Promise<string[]> {
    const res = await admin().get(`/libraries/${permsLibraryId}/permissions`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.permissions as Array<{ userId: string }>).map((p) => p.userId).sort();
  }

  it('422s on an unknown TOP-LEVEL key, and writes no grant', async () => {
    const before = await grantedUserIds();

    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: targetUserId, granted: true }],
      bogus: true,
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('Unknown property "bogus".');
    expect(res.body["instance"]).toBe(`/libraries/${permsLibraryId}/permissions`);

    expect(await grantedUserIds()).toEqual(before);
  }, 20_000);

  it("422s on an unknown key INSIDE a permission entry, and writes no grant", async () => {
    const before = await grantedUserIds();

    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: targetUserId, granted: true, bogus: 1 }],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('Unknown property "permissions[0].bogus".');

    expect(await grantedUserIds()).toEqual(before);
  }, 20_000);

  it("422s on a misspelled entry member (the client-typo case) rather than silently dropping it", async () => {
    const before = await grantedUserIds();

    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      permissions: [{ userId: targetUserId, allowed: true }],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('Unknown property "permissions[0].allowed".');

    expect(await grantedUserIds()).toEqual(before);
  }, 20_000);

  it("rejects atomically: an unknown key on a LATER entry writes none of the earlier ones", async () => {
    const before = await grantedUserIds();

    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [
        { userId: targetUserId, granted: true },
        { userId: targetUserId, granted: true, nope: "x" },
      ],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('Unknown property "permissions[1].nope".');

    expect(await grantedUserIds()).toEqual(before);
  }, 20_000);

  it("still accepts the exact body shape the web sends, and the grant lands", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: targetUserId, granted: true }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await grantedUserIds()).toContain(targetUserId);

    const revoke = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: targetUserId, granted: false }],
    });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    expect(await grantedUserIds()).not.toContain(targetUserId);
  }, 20_000);

  it("still accepts a body with no libraryId at all (the path is authoritative — unchanged posture)", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, { permissions: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }, 20_000);

  it("still 422s on a missing/non-array permissions member (guard, unchanged)", async () => {
    const missing = await admin().put(`/libraries/${permsLibraryId}/permissions`, { libraryId: permsLibraryId });
    expectValidationProblem(missing);
    expect(missing.body["detail"]).toBe("permissions must be an array.");

    const wrongType = await admin().put(`/libraries/${permsLibraryId}/permissions`, { permissions: "all" });
    expectValidationProblem(wrongType);
  }, 20_000);

  it("still 422s on a wrong-typed entry member (guard, unchanged)", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      permissions: [{ userId: targetUserId, granted: "yes" }],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe("Each permission entry requires userId (string) and granted (boolean).");
  }, 20_000);

  it("422s on an entry that is not an object at all (null / array / scalar)", async () => {
    for (const entry of [null, [], "grant", 7] as unknown[]) {
      const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, { permissions: [entry] });
      expectValidationProblem(res);
    }
  }, 20_000);
});

// ───────────── PUT /libraries/{id}/permissions: entry userId (d4-b1) ─────────
// d3-b5 taught this handler about unknown KEYS; the VALUE of a known key was
// still only `typeof === "string"`-checked, so every entry.userId reached
// Postgres verbatim. Two 500s came out of that — the same defect class as
// api-validation-F1, one level deeper (an array member, which
// requireUuidParam never reaches): a non-UUID string blew up the implicit
// `uuid` cast (22P02) on BOTH the grant (INSERT) and revoke (DELETE … WHERE
// user_id IN) arms, and a well-formed uuid naming no user violated
// library_permissions' FK to users (23503). Contract: LibraryPermission.userId
// is `{type: string, format: uuid}` and the op already declares 404 + 422.
describe("PUT /libraries/{id}/permissions entry userId validation (d4-b1)", () => {
  let permsLibraryId: string;
  /** Well-formed and syntactically valid, but no such user on this DB. */
  const UNKNOWN_USER_ID = "01a01f7a-0000-7000-8000-0000000d4b10";

  beforeAll(async () => {
    const created = await admin().post("/libraries", {
      name: "d4-b1 Permissions Library",
      mediaKind: "movie",
      paths: ["/data/d4-b1-permissions"],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    permsLibraryId = created.body.id;
  }, 30_000);

  async function grantedUserIds(): Promise<string[]> {
    const res = await admin().get(`/libraries/${permsLibraryId}/permissions`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.permissions as Array<{ userId: string }>).map((p) => p.userId).sort();
  }

  it("422s (never 500s) on a non-UUID userId being GRANTED", async () => {
    const before = await grantedUserIds();

    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: "not-a-uuid", granted: true }],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('permissions[0].userId must be a valid UUID.');
    expect(res.body["instance"]).toBe(`/libraries/${permsLibraryId}/permissions`);

    expect(await grantedUserIds()).toEqual(before);
  }, 20_000);

  it("422s (never 500s) on a non-UUID userId being REVOKED — the DELETE arm casts too", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      permissions: [{ userId: "not-a-uuid", granted: false }],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('permissions[0].userId must be a valid UUID.');
  }, 20_000);

  it("names the offending ENTRY, not just the body, when a later entry is the bad one", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      permissions: [
        { userId: targetUserId, granted: true },
        { userId: "still-not-a-uuid", granted: true },
      ],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('permissions[1].userId must be a valid UUID.');
    expect(await grantedUserIds()).not.toContain(targetUserId);
  }, 20_000);

  it("404s (never 500s) on a well-formed userId that names no user — the FK arm", async () => {
    const before = await grantedUserIds();

    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: UNKNOWN_USER_ID, granted: true }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body["type"]).toBe("urn:loombre:problem:not-found");
    expect(res.body["detail"]).toBe('Unknown userId in permissions[0].');
    expect(res.body["instance"]).toBe(`/libraries/${permsLibraryId}/permissions`);

    expect(await grantedUserIds()).toEqual(before);
  }, 20_000);

  it("404s on an unknown userId being REVOKED too (one rule for the member, not one per arm)", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      permissions: [{ userId: UNKNOWN_USER_ID, granted: false }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body["detail"]).toBe('Unknown userId in permissions[0].');
  }, 20_000);

  it("rejects atomically: an unknown userId on a LATER entry writes none of the earlier ones", async () => {
    const before = await grantedUserIds();

    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      permissions: [
        { userId: targetUserId, granted: true },
        { userId: UNKNOWN_USER_ID, granted: true },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body["detail"]).toBe('Unknown userId in permissions[1].');

    expect(await grantedUserIds()).toEqual(before);
  }, 20_000);

  it("shape wins over existence: a non-UUID entry is a 422 even when a LATER entry is an unknown user", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      permissions: [
        { userId: "not-a-uuid", granted: true },
        { userId: UNKNOWN_USER_ID, granted: true },
      ],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('permissions[0].userId must be a valid UUID.');
  }, 20_000);

  it("still grants and revokes a real user (the fix is a guard, not a narrowing)", async () => {
    const grant = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: targetUserId, granted: true }],
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    expect(await grantedUserIds()).toContain(targetUserId);

    const revoke = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: targetUserId, granted: false }],
    });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    expect(await grantedUserIds()).not.toContain(targetUserId);
  }, 20_000);
});

// ──────── PUT /libraries/{id}/permissions: path/body libraryId (d4-b2) ───────
// LibraryPermissionSet declares `libraryId` REQUIRED, and the handler neither
// required nor cross-checked it: a body naming a DIFFERENT library answered
// 200 having written the grant against the PATH id — an admin who edited the
// wrong field of a copy-pasted body silently granted access to a library they
// were not looking at. The path stays authoritative (all three web callers
// send the body member and every one of them sends the path id); a MISMATCH
// is now a 422, and openapi.yaml says so.
describe("PUT /libraries/{id}/permissions path/body libraryId agreement (d4-b2)", () => {
  let permsLibraryId: string;
  let otherLibraryId: string;

  beforeAll(async () => {
    const created = await admin().post("/libraries", {
      name: "d4-b2 Permissions Library",
      mediaKind: "movie",
      paths: ["/data/d4-b2-permissions"],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    permsLibraryId = created.body.id;

    const other = await admin().post("/libraries", {
      name: "d4-b2 Other Library",
      mediaKind: "movie",
      paths: ["/data/d4-b2-other"],
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    otherLibraryId = other.body.id;
  }, 30_000);

  async function grantedUserIds(libraryId: string): Promise<string[]> {
    const res = await admin().get(`/libraries/${libraryId}/permissions`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.permissions as Array<{ userId: string }>).map((p) => p.userId).sort();
  }

  it("422s when the body names a DIFFERENT library than the path", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: otherLibraryId,
      permissions: [],
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe("libraryId must match the library in the path.");
    expect(res.body["instance"]).toBe(`/libraries/${permsLibraryId}/permissions`);
  }, 20_000);

  it("writes NOTHING on a mismatch — not to the path library, not to the body's", async () => {
    const beforePath = await grantedUserIds(permsLibraryId);
    const beforeOther = await grantedUserIds(otherLibraryId);

    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: otherLibraryId,
      permissions: [{ userId: targetUserId, granted: true }],
    });
    expectValidationProblem(res);

    expect(await grantedUserIds(permsLibraryId)).toEqual(beforePath);
    expect(await grantedUserIds(otherLibraryId)).toEqual(beforeOther);
  }, 20_000);

  it("422s on a libraryId that is not even a string (any present value must equal the path id)", async () => {
    for (const libraryId of [7, true, null, ["x"], { id: "x" }] as unknown[]) {
      const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, { libraryId, permissions: [] });
      expectValidationProblem(res);
      expect(res.body["detail"], JSON.stringify(libraryId)).toBe("libraryId must match the library in the path.");
    }
  }, 20_000);

  it("an unknown TOP-LEVEL key still wins over the mismatch (allowlist first, unchanged)", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: otherLibraryId,
      permissions: [],
      bogus: true,
    });
    expectValidationProblem(res);
    expect(res.body["detail"]).toBe('Unknown property "bogus".');
  }, 20_000);

  it("still accepts a MATCHING libraryId (the body shape all three web callers send)", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      libraryId: permsLibraryId,
      permissions: [{ userId: targetUserId, granted: true }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.libraryId).toBe(permsLibraryId);
    expect(await grantedUserIds(permsLibraryId)).toContain(targetUserId);
  }, 20_000);

  it("still accepts an ABSENT libraryId (the path is authoritative — unchanged posture)", async () => {
    const res = await admin().put(`/libraries/${permsLibraryId}/permissions`, {
      permissions: [{ userId: targetUserId, granted: false }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await grantedUserIds(permsLibraryId)).not.toContain(targetUserId);
  }, 20_000);

  it("openapi.yaml documents the rule the server now enforces", () => {
    const doc = parseYaml(readFileSync(CONTRACT_PATH, "utf8")) as Record<string, any>;
    const description = String(doc.components.schemas.LibraryPermissionSet.properties.libraryId.description ?? "");
    expect(description).toMatch(/path/i);
    expect(description).toMatch(/422/);
    expect(doc.paths["/libraries/{id}/permissions"].put.responses["422"]).toBeDefined();
  });
});
