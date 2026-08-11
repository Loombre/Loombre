// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/playback-zero-file-item.e2e.spec.ts
//
// AUD-W6-001 (audit fafa47f, Wave 6 visual-verify): "GET /watch/<item> for a
// 0-file item hangs on 'Preparing playback…' indefinitely; UnavailableScreen
// never renders." Filed as a CANDIDATE, not a validated finding — the audit
// itself flagged that "movie with zero media files" might be a seed-artifact
// shape that never occurs against a realistic library, and asked for a repro
// against one before trusting the symptom.
//
// This is that repro, built against a REAL catalog_items row (not a
// nonexistent itemId — apps/server/test/playback.e2e.spec.ts already covers
// that distinct "item doesn't exist at all" 404 case) that a real library
// scan can legitimately produce: an item Loombre knows about (e.g. matched
// via metadata before any file was probed, or every one of its files went
// missing_since_ms) with literally zero media_files rows.
//
// Finding: the SERVER side does not hang. getMediaInfoAssembly's
// resolvePrimaryFile (packages/db/src/query/media-info.ts) returns undefined
// for a zero-file item, and both POST /playback/plan and POST
// /playback/sessions (apps/server/src/playback/plan.controller.ts,
// sessions.controller.ts) already map that straight to a fast 404 — this
// file pins that with an explicit generous time bound as a regression guard.
// The "hangs indefinitely" symptom described by the audit is therefore NOT
// reproducible at the server boundary; it can only live in how the web
// player (apps/web/src/components/player/VideoPlayer.tsx, Lane A4's file
// per this run's forbidden-file boundary) reacts to a create-session 404 —
// out of scope for this lane. See STATE.md's an upstream media server-study run, Lane A5
// exit report for the classification handed to the orchestrator.

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

function loginDeviceProfile(profileId: string) {
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

function compatibleDeviceProfile() {
  return {
    profileId: "capable-client",
    directPlayContainers: ["mp4", "mkv", "webm"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "hevc",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: 60,
        maxBitrateBps: 80_000_000,
      },
    ],
    hdr: { hdr10: true, hlg: true, dolbyVision: false },
    audio: [{ codec: "eac3", maxChannels: 6, passthrough: true }],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let adminToken: string;
let zeroFileItemId: string;

// Generous — this is a regression guard against a genuine hang, not a tight
// perf assertion. A correct 404 lands in milliseconds; anything anywhere
// near this bound would itself be worth investigating.
const HANG_GUARD_MS = 5_000;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "playback-zero-file-e2e-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "playback_zero_file_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "playback-zero-file-e2e-admin",
    deviceProfile: loginDeviceProfile("playback-zero-file-e2e-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  // A realistic-library shape: a real catalog_items row (matched, titled,
  // owned by a real library the admin has permission on — same library any
  // other seeded movie lives in) with ZERO media_files rows. This is what a
  // library scan produces for an item matched from metadata before its file
  // is probed, or whose sole file went missing_since_ms and was later
  // pruned — not a seed-artifact-only shape.
  const db = createDb(databaseUrl);
  try {
    const anyMovie = await db
      .selectFrom("catalog_items")
      .select(["library_id"])
      .where("item_type", "=", "movie")
      .limit(1)
      .executeTakeFirstOrThrow();

    const now = Date.now();
    const item = await db
      .insertInto("catalog_items")
      .values({
        library_id: anyMovie.library_id,
        item_type: "movie",
        parent_id: null,
        title: "Zero-File Fixture",
        sort_title: "zero-file fixture",
        year: null,
        community_rating: null,
        added_at_ms: now,
        updated_at_ms: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    zeroFileItemId = item.id;
    // Deliberately NO media_files insert — that absence is the fixture.
  } finally {
    await db.destroy();
  }
}, 30_000);

afterAll(async () => {
  await app.close();
});

function admin() {
  return {
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`),
  };
}

describe("AUD-W6-001 repro: a real catalog item with zero media_files rows", () => {
  it("POST /playback/plan is a fast 404, never a hang", async () => {
    const start = Date.now();
    const res = await admin()
      .post("/playback/plan")
      .send({
        itemId: zeroFileItemId,
        device: compatibleDeviceProfile(),
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
      })
      .timeout(HANG_GUARD_MS);
    expect(Date.now() - start).toBeLessThan(HANG_GUARD_MS);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("POST /playback/sessions is a fast 404, never a hang", async () => {
    const start = Date.now();
    const res = await admin()
      .post("/playback/sessions")
      .send({
        itemId: zeroFileItemId,
        device: compatibleDeviceProfile(),
        network: { maxBitrateBps: 50_000_000, isLocal: true },
        mode: "stream",
      })
      .timeout(HANG_GUARD_MS);
    expect(Date.now() - start).toBeLessThan(HANG_GUARD_MS);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });
});
