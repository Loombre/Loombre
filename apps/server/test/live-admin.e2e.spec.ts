// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/live-admin.e2e.spec.ts
//
// Security review L2 closure: admin authorization must be re-verified with
// a FRESH server-side DB read at request time — never trusted from the JWT
// access-token claim alone, which stays valid for up to the token's
// 15-minute lifetime after an admin is demoted. The settings and plugins
// surfaces adopted this (A10 / F1c) in Phase 4 + Addendum A; this file
// proves the remaining claim-gated surfaces — the catalog admin
// controllers (admin.controller.ts, users.controller.ts,
// libraries.controller.ts) — now behave the same way:
//
//   admin #1 (seed) creates admin #2 → admin #2 logs in (token claims
//   isAdmin:true) → admin #1 demotes admin #2 → the SAME still-valid
//   token must now 403 on every admin surface, immediately, with no
//   token-expiry grace window.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed) — same
// convention as security-hardening.e2e.spec.ts.

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

let app: INestApplication;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "live-admin-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "live_admin_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("live admin re-verify (L2): a demoted admin's still-valid token stops working immediately", () => {
  it("admin surfaces 403 a demoted admin with no token-expiry grace window", async () => {
    const httpServer = app.getHttpServer();

    // --- admin #1: the seed admin ---
    const seedLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "live-admin-seed",
      deviceProfile: buildDeviceProfile("live-admin-seed"),
    });
    expect(seedLogin.status, JSON.stringify(seedLogin.body)).toBe(200);
    const seedToken: string = seedLogin.body.accessToken;

    // --- admin #1 creates admin #2 ---
    const created = await request(httpServer)
      .post("/users")
      .set("Authorization", `Bearer ${seedToken}`)
      .send({
        username: "demote-me",
        email: "demote-me@example.invalid",
        password: "demote-me-password-1",
        isAdmin: true,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const secondAdminId: string = created.body.id;

    const secondLogin = await request(httpServer).post("/auth/login").send({
      username: "demote-me",
      password: "demote-me-password-1",
      deviceName: "live-admin-second",
      deviceProfile: buildDeviceProfile("live-admin-second"),
    });
    expect(secondLogin.status, JSON.stringify(secondLogin.body)).toBe(200);
    const secondToken: string = secondLogin.body.accessToken;

    // --- positive control: the fresh admin passes every surface ---
    const jobsBefore = await request(httpServer).get("/admin/jobs").set("Authorization", `Bearer ${secondToken}`);
    expect(jobsBefore.status, JSON.stringify(jobsBefore.body)).toBe(200);

    const usersBefore = await request(httpServer).get("/users").set("Authorization", `Bearer ${secondToken}`);
    expect(usersBefore.status, JSON.stringify(usersBefore.body)).toBe(200);

    // An empty body fails VALIDATION (422) — proof it got PAST the admin
    // gate; after demotion the same request must fail the GATE (403).
    const libsBefore = await request(httpServer).post("/libraries").set("Authorization", `Bearer ${secondToken}`).send({});
    expect(libsBefore.status, JSON.stringify(libsBefore.body)).toBe(422);

    // --- admin #1 demotes admin #2 ---
    const demoted = await request(httpServer)
      .patch(`/users/${secondAdminId}`)
      .set("Authorization", `Bearer ${seedToken}`)
      .send({ isAdmin: false });
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);

    // --- the SAME still-valid token must now 403 everywhere, immediately ---
    const jobsAfter = await request(httpServer).get("/admin/jobs").set("Authorization", `Bearer ${secondToken}`);
    expect(jobsAfter.status, JSON.stringify(jobsAfter.body)).toBe(403);

    const usersAfter = await request(httpServer).get("/users").set("Authorization", `Bearer ${secondToken}`);
    expect(usersAfter.status, JSON.stringify(usersAfter.body)).toBe(403);

    const libsAfter = await request(httpServer).post("/libraries").set("Authorization", `Bearer ${secondToken}`).send({});
    expect(libsAfter.status, JSON.stringify(libsAfter.body)).toBe(403);

    // RFC 9457 problem+json shape on the gate rejection.
    expect(jobsAfter.body.status).toBe(403);
    expect(typeof jobsAfter.body.detail).toBe("string");

    // Non-admin surfaces keep working for the demoted user (demotion is
    // not a ban): own profile still readable with the same token.
    const me = await request(httpServer).get("/users/me").set("Authorization", `Bearer ${secondToken}`);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.isAdmin).toBe(false);
  }, 30_000);
});
