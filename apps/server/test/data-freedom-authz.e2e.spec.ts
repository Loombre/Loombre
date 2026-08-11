// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/data-freedom-authz.e2e.spec.ts
//
// The two feedback loops the /import + /libraries/{id}/scan job-enqueue
// surfaces shipped without:
//
//   1. AUTHORIZATION. packages/contract/openapi.yaml documents POST /import
//      as "(admin)" with a 403 response, but the handler carried no gate at
//      all — any authenticated non-admin could hand the import consumer an
//      archive whose `users[]` rows it applies verbatim (isAdmin included).
//      This suite pins the L2 shape its siblings already have: claim
//      fast-fail PLUS a fresh users.is_admin re-read, so a demoted admin's
//      still-valid 15-minute token 403s immediately. GET /export is the
//      deliberate asymmetry — authenticated but NOT admin (its own
//      admin-only `users` phase is filtered inside packages/db/src/query/
//      export.ts), so a non-admin must keep getting 200 there.
//
//   2. STATUS CODES. Both endpoints enqueue a job and the contract
//      documents 202 Accepted; Nest defaults a bare @Post to 201. The
//      conformance table only exercises their failure paths (scanLibrary
//      404, importData 422), which short-circuit before the enqueue line,
//      so the drift was invisible. These are the success-path assertions.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed) — same
// convention as live-admin.e2e.spec.ts.

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

// Structurally valid per the contract's ExportArchive — so a 403 here can
// only be the admin gate, never body validation (which would be 422).
function buildMinimalArchive() {
  return { exportedAtMs: 1_700_000_000_000, users: [], libraries: [], items: [], progress: [], playlists: [] };
}

let app: INestApplication;
let adminToken: string;
let casualToken: string;
let seededLibraryId: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "data-freedom-authz-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "data_freedom_authz_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const httpServer = app.getHttpServer();

  const adminLogin = await request(httpServer).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "data-freedom-admin",
    deviceProfile: buildDeviceProfile("data-freedom-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const created = await request(httpServer)
    .post("/users")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      username: "import-casual",
      email: "import-casual@example.invalid",
      password: "import-casual-password-1",
      isAdmin: false,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const casualLogin = await request(httpServer).post("/auth/login").send({
    username: "import-casual",
    password: "import-casual-password-1",
    deviceName: "data-freedom-casual",
    deviceProfile: buildDeviceProfile("data-freedom-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;

  const libraries = await request(httpServer).get("/libraries").set("Authorization", `Bearer ${adminToken}`);
  expect(libraries.status, JSON.stringify(libraries.body)).toBe(200);
  seededLibraryId = libraries.body.items[0].id;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("POST /import is admin-only", () => {
  it("403s an authenticated non-admin holding a structurally valid archive", async () => {
    const res = await request(app.getHttpServer())
      .post("/import")
      .set("Authorization", `Bearer ${casualToken}`)
      .send(buildMinimalArchive());

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.status).toBe(403);
    expect(typeof res.body.detail).toBe("string");
    expect(res.body.jobId).toBeUndefined();
  });

  it("403s a demoted admin's still-valid token (fresh is_admin re-read, no grace window)", async () => {
    const httpServer = app.getHttpServer();

    const created = await request(httpServer)
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        username: "import-demote-me",
        email: "import-demote-me@example.invalid",
        password: "import-demote-me-password-1",
        isAdmin: true,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const login = await request(httpServer).post("/auth/login").send({
      username: "import-demote-me",
      password: "import-demote-me-password-1",
      deviceName: "data-freedom-demote",
      deviceProfile: buildDeviceProfile("data-freedom-demote"),
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const demotedToken: string = login.body.accessToken;

    // Positive control: the claim is real, the gate passes it.
    const before = await request(httpServer)
      .post("/import")
      .set("Authorization", `Bearer ${demotedToken}`)
      .send(buildMinimalArchive());
    expect(before.status, JSON.stringify(before.body)).toBe(202);

    const demoted = await request(httpServer)
      .patch(`/users/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isAdmin: false });
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);

    const after = await request(httpServer)
      .post("/import")
      .set("Authorization", `Bearer ${demotedToken}`)
      .send(buildMinimalArchive());
    expect(after.status, JSON.stringify(after.body)).toBe(403);
  }, 30_000);

  it("keeps GET /export authenticated-but-not-admin", async () => {
    const res = await request(app.getHttpServer()).get("/export").set("Authorization", `Bearer ${casualToken}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Admin-only `users` phase is filtered inside the query layer, not here.
    expect(res.body.users).toEqual([]);
  }, 30_000);
});

describe("job-enqueue endpoints return the contract's 202 Accepted", () => {
  it("POST /import -> 202 + JobRef", async () => {
    const res = await request(app.getHttpServer())
      .post("/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(buildMinimalArchive());

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(typeof res.body.jobId).toBe("string");
  });

  it("POST /libraries/{id}/scan -> 202 + JobRef", async () => {
    const res = await request(app.getHttpServer())
      .post(`/libraries/${seededLibraryId}/scan`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ full: false });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(typeof res.body.jobId).toBe("string");
  });
});
