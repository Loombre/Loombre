// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/users-birthdate-validation.e2e.spec.ts
//
// api-validation-F3 (QA 2026-08-21 remediation, P1). PATCH /users/me
// forwarded ANY string birthDate straight through to updateUserSelf and
// the Postgres `date` column (`typeof body["birthDate"] === "string"` was
// the whole check), so `{"birthDate":"not-a-date"}` reached the cast, the
// driver raised 22007/22008, and ProblemJsonExceptionFilter's generic
// `@Catch()` rendered `urn:loombre:problem:internal` **500** for an
// ordinary client typo — while the contract declares
// `UpdateMeRequest.birthDate: { type: [string,'null'], format: date }`
// and a 422 response on this very operation. The sibling `email` field on
// the same handler has been format-validated since R-F4; birthDate was
// simply missed.
//
// This suite is the regression net for the whole shape: garbage strings,
// well-formed-but-nonexistent calendar dates (2024-02-30, 1900-02-29),
// unpadded components, a date-TIME, and Postgres' non-existent year zero
// all 422 with problem+json — and never 5xx — while every value the
// column actually accepts still round-trips, `null` still clears, and the
// file-wide null-to-clear convention for a present-but-not-a-string value
// is unchanged.
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
import { ensureTestDatabase } from "@loombre/db";
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

const ADMIN_PASSWORD = "loombre-seed-admin";

/** The seed admin's stored birth_date — every rejected PATCH below must
 *  leave it exactly here (a 422 writes nothing). */
const SEEDED_BIRTH_DATE = "1988-03-14";

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `users-birthdate-e2e-${username}-${Date.now()}-${Math.random()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

function patchMe(body: Record<string, unknown>) {
  return request(app.getHttpServer()).patch("/users/me").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_users_birthdate");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "users-birthdate-e2e-test-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  adminToken = await loginAs("admin", ADMIN_PASSWORD);
}, 120_000);

afterAll(async () => {
  await app?.close();
  delete process.env["LOOMBRE_RATE_LOGIN"];
});

// The cited defect, and the shapes around it. Every one of these is a
// string the Postgres `date` column cannot store; every one used to reach
// the cast and come back 500.
const REJECTED: ReadonlyArray<readonly [label: string, value: string]> = [
  ["the cited garbage string", "not-a-date"],
  ["an empty string", ""],
  ["whitespace only", "   "],
  ["a well-formed but non-existent calendar date", "2024-02-30"],
  ["Feb 29 of a non-leap century year", "1900-02-29"],
  ["month 13", "1988-13-01"],
  ["day 00", "1988-03-00"],
  ["unpadded components", "1988-3-14"],
  ["a date-TIME, not a date", "1988-03-14T00:00:00Z"],
  ["a trailing-space date", "1988-03-14 "],
  ["Postgres' non-existent year zero", "0000-01-01"],
  ["a US-format date", "03/14/1988"],
  ["a bare year", "1988"],
  ["SQL-ish text", "now()"],
];

describe("api-validation-F3: PATCH /users/me rejects a malformed birthDate with 422, never 500", () => {
  for (const [label, value] of REJECTED) {
    it(`422s on ${label} (${JSON.stringify(value)})`, async () => {
      const res = await patchMe({ birthDate: value });
      expect(res.status, `body: ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.body.type).toBe("urn:loombre:problem:validation");
      expect(res.body.instance).toBe("/users/me");
      // RFC 9457 detail must name the field and the expected shape without
      // echoing anything else back.
      expect(String(res.body.detail)).toContain("birthDate");
    });
  }

  it("writes nothing on rejection — the stored birthDate and updatedAtMs are untouched", async () => {
    const before = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${adminToken}`);
    expect(before.status).toBe(200);
    expect(before.body.birthDate).toBe(SEEDED_BIRTH_DATE);

    const rejected = await patchMe({ birthDate: "not-a-date" });
    expect(rejected.status).toBe(422);

    const after = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${adminToken}`);
    expect(after.status).toBe(200);
    expect(after.body.birthDate).toBe(SEEDED_BIRTH_DATE);
    expect(after.body.updatedAtMs).toBe(before.body.updatedAtMs);
  });

  it("rejects before any OTHER member of the same body is applied (atomic 422)", async () => {
    const before = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${adminToken}`);
    expect(before.status).toBe(200);

    const res = await patchMe({ displayName: "Should Not Persist", birthDate: "2024-02-30" });
    expect(res.status, `body: ${JSON.stringify(res.body)}`).toBe(422);

    const after = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${adminToken}`);
    expect(after.body.displayName).toBe(before.body.displayName);
  });
});

describe("api-validation-F3: every value the column really accepts still round-trips", () => {
  const ACCEPTED = ["1988-03-14", "1988-02-29", "2000-02-29", "2024-12-31", "0001-01-01", "9999-12-31"] as const;

  for (const value of ACCEPTED) {
    it(`accepts ${value} and reads it back verbatim`, async () => {
      const res = await patchMe({ birthDate: value });
      expect(res.status, `body: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.birthDate).toBe(value);

      const after = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${adminToken}`);
      expect(after.body.birthDate).toBe(value);
    });
  }

  it("an explicit null still clears it (the file's null-to-clear convention)", async () => {
    const set = await patchMe({ birthDate: "1988-03-14" });
    expect(set.status).toBe(200);

    const cleared = await patchMe({ birthDate: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.birthDate).toBeNull();

    const restored = await patchMe({ birthDate: SEEDED_BIRTH_DATE });
    expect(restored.status).toBe(200);
    expect(restored.body.birthDate).toBe(SEEDED_BIRTH_DATE);
  });

  it("a present-but-not-a-string value keeps clearing, exactly as before (unchanged convention)", async () => {
    const restored = await patchMe({ birthDate: SEEDED_BIRTH_DATE });
    expect(restored.status).toBe(200);

    const cleared = await patchMe({ birthDate: 42 });
    expect(cleared.status, `body: ${JSON.stringify(cleared.body)}`).toBe(200);
    expect(cleared.body.birthDate).toBeNull();

    const back = await patchMe({ birthDate: SEEDED_BIRTH_DATE });
    expect(back.status).toBe(200);
    expect(back.body.birthDate).toBe(SEEDED_BIRTH_DATE);
  });

  it("omitting birthDate entirely leaves it untouched", async () => {
    const before = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${adminToken}`);
    const res = await patchMe({ displayName: "Untouched Birthday" });
    expect(res.status).toBe(200);
    expect(res.body.birthDate).toBe(before.body.birthDate);
  });
});
