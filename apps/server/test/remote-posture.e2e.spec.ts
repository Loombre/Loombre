// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-posture.e2e.spec.ts
//
// End-to-end (in-process Nest app, real HTTP via supertest, live Postgres)
// coverage for STATE.md "Loombre Remote — embedded WireGuard + three-path
// wizard + reachability proof + posture card" (R7/RG4, S1 lane), DRIFT
// DECISION #1's GET /admin/remote/posture. Mirrors notices.e2e.spec.ts's
// own boot pattern (own DB suffix, migrate reset + seed, loginAs
// admin/casual).
//
// SCOPE NOTE: this file proves the HTTP surface (auth wall, real 200
// shape) end-to-end against the REAL Nest-wired dependency graph. The
// "regression raises a notice" exit-gate item (flip a check across two
// sweeps, assert the outbox event) is proven in
// src/remote/posture/remote-posture-regression.scheduler.spec.ts instead —
// that file drives the SAME production RemotePostureRegressionScheduler-
// Service class + the real recordPostureRegressedEvent/recordPosture-
// RecoveredEvent DB writes against a live database; only its
// RemotePostureService collaborator is a scripted fake (so a specific,
// non-'none' active path can be forced — this codebase has no
// @nestjs/testing / overrideProvider() precedent to force that through the
// full HTTP+DI stack, and RemoteActivePathReaderService's wired default is
// honestly always 'none' on this branch — see that reader's own header).
// This file additionally proves the wired instance's runSweep() runs
// clean end-to-end against the real DB/settings stack without DI errors.
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
import { createDb, ensureTestDatabase, createUserAdmin } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { RemotePostureRegressionSchedulerService } from "../src/remote/posture/remote-posture-regression.scheduler.js";

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
let rawDb: ReturnType<typeof createDb>;
let adminToken: string;
let casualToken: string;

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `remote-posture-e2e-${username}-${Date.now()}-${Math.random()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

async function eventCount(type: string, matcher: (p: Record<string, unknown>) => boolean): Promise<number> {
  const rows = await rawDb.selectFrom("events").select(["payload"]).where("type", "=", type).execute();
  return (rows as { payload: Record<string, unknown> }[]).filter((r) => matcher(r.payload)).length;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_posture_e2e_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-posture-e2e-secret-not-for-production";
  process.env["LOOMBRE_UPDATE_CHECK"] = "off";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  rawDb = createDb(databaseUrl);
  adminToken = await loginAs("admin", "loombre-seed-admin");
  casualToken = await loginAs("casual", "loombre-seed-casual");
}, 30_000);

afterAll(async () => {
  await rawDb?.destroy();
  await app?.close();
});

describe("GET /admin/remote/posture", () => {
  it("401s unauthenticated", async () => {
    const res = await request(app.getHttpServer()).get("/admin/remote/posture");
    expect(res.status).toBe(401);
  });

  it("403s a non-admin (casual)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/remote/posture").set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(403);
  });

  it("200s for an admin — empty checks[] on the fresh reseeded DB (no remote-access path is enabled anywhere on this branch yet)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/remote/posture").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      checks: [],
      overallGrade: "pass",
      evaluatedAtMs: expect.any(Number),
    });
  });
});

describe("RemotePostureRegressionSchedulerService — real DI wiring", () => {
  it("the real, fully-wired instance's runSweep() runs clean against the live DB/settings stack, twice in a row, with no DI errors", async () => {
    const scheduler = app.get(RemotePostureRegressionSchedulerService);
    await expect(scheduler.runSweep()).resolves.toBeUndefined();
    await expect(scheduler.runSweep()).resolves.toBeUndefined();
  });

  it("writes no regression event on this branch — path is honestly 'none' end-to-end (RemoteActivePathReaderService's wired default, see its header), so card.checks is always empty and nothing CAN regress; a real stale account seeded live still doesn't surface until some path is active", async () => {
    const before = await eventCount("posture.regressed", () => true);
    await createUserAdmin(rawDb, {
      username: `posture-e2e-stale-${Date.now()}`,
      email: null,
      passwordHash: "not-a-real-hash",
      isAdmin: false,
      maxContentRating: null,
      nowMs: Date.now(),
    });

    const scheduler = app.get(RemotePostureRegressionSchedulerService);
    await scheduler.runSweep();

    expect(await eventCount("posture.regressed", () => true)).toBe(before);
    const res = await request(app.getHttpServer()).get("/admin/remote/posture").set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.checks).toEqual([]);
  });
});
