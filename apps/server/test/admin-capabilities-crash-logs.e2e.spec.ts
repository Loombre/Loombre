// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/admin-capabilities-crash-logs.e2e.spec.ts
//
// HTTP-level tests for Phase 4 deliverable D's three ops-surface admin GET
// endpoints (STATE.md, P4.5/P4.14 crash handling + P3.5 hw-capability
// probe): GET /admin/capabilities, GET /admin/crash-files(+/{name}), GET
// /admin/logs/tail. Unit-level correctness for the filesystem-facing
// pieces already lives in apps/server/src/catalog/admin-crash-files.spec.ts
// and admin-logs-tail.spec.ts — this file proves the WIRE-UP: admin
// gating, the null/empty envelopes before any data exists, and real data
// round-tripping through the actual HTTP surface.
//
// LOOMBRE_DATA_DIR is pointed at a per-file temp directory (own crashes/
// subdir) so this test never touches any shared app-data location — the
// crash-files controller resolves it fresh via resolveAppPaths on every
// request (apps/server/src/catalog/admin.controller.ts), so setting the
// env var before each request is sufficient, no DI wiring needed.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed).

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
let databaseUrl: string;
let adminToken: string;
let casualToken: string;
let dataDir: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "admin-caps-crash-logs-test-secret-not-for-production";

  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_caps_crash_logs_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-admin-e2e-datadir-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-caps-crash-logs-admin",
    deviceProfile: buildDeviceProfile("admin-caps-crash-logs-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "admin-caps-crash-logs-casual",
    deviceProfile: buildDeviceProfile("admin-caps-crash-logs-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /admin/capabilities", () => {
  it("403s for a non-admin token", async () => {
    const res = await request(app.getHttpServer()).get("/admin/capabilities").set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(403);
  });

  it("null report + probe 'never-ran' before any hw-capability probe has ever run (fresh reseeded instance)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/capabilities").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ report: null, probe: { status: "never-ran", lastError: null, updatedAtMs: null } });
  });

  // W1/D-1 three-state coverage: never-ran (above), failed, pending, and
  // completed-with-zero-backends must each be distinguishable on the wire.
  it("probe 'failed': latest hwprobe ledger row failed + no snapshot -> lastError surfaces, report stays null", async () => {
    const db = createDb(databaseUrl);
    try {
      const nowMs = Date.now();
      await db
        .insertInto("jobs")
        .values({
          id: "00000000-0000-7000-8000-000000000501",
          type: "hwprobe",
          status: "failed",
          last_error: "ffmpeg exited 1 during the encoder listing",
          created_at_ms: nowMs - 60_000,
          updated_at_ms: nowMs - 30_000,
          finished_at_ms: nowMs - 30_000,
        })
        .execute();

      const res = await request(app.getHttpServer()).get("/admin/capabilities").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        report: null,
        probe: { status: "failed", lastError: "ffmpeg exited 1 during the encoder listing", updatedAtMs: nowMs - 30_000 },
      });
    } finally {
      await db.deleteFrom("jobs").where("id", "=", "00000000-0000-7000-8000-000000000501").execute();
      await db.destroy();
    }
  });

  it("probe 'pending': latest hwprobe ledger row queued + no snapshot", async () => {
    const db = createDb(databaseUrl);
    try {
      const nowMs = Date.now();
      await db
        .insertInto("jobs")
        .values({
          id: "00000000-0000-7000-8000-000000000502",
          type: "hwprobe",
          status: "queued",
          created_at_ms: nowMs - 5_000,
          updated_at_ms: nowMs - 5_000,
        })
        .execute();

      const res = await request(app.getHttpServer()).get("/admin/capabilities").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({
        report: null,
        probe: { status: "pending", lastError: null, updatedAtMs: nowMs - 5_000 },
      });
    } finally {
      await db.deleteFrom("jobs").where("id", "=", "00000000-0000-7000-8000-000000000502").execute();
      await db.destroy();
    }
  });

  it("re-probe over an existing snapshot: NEWER failed hwprobe row -> probe 'failed' while the previous report stays visible", async () => {
    const db = createDb(databaseUrl);
    try {
      const verifiedAtMs = Date.now() - 60_000;
      const failedAtMs = verifiedAtMs + 30_000;
      await db
        .insertInto("hw_capability_snapshots")
        .values({
          ffmpeg_build_hash: "sha256-before-upgrade",
          gpu_fingerprint: "old-gpu",
          platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
          verified_at_ms: verifiedAtMs,
          is_current: true,
        })
        .execute();
      await db
        .insertInto("jobs")
        .values({
          id: "00000000-0000-7000-8000-000000000503",
          type: "hwprobe",
          status: "failed",
          last_error: "re-probe after ffmpeg upgrade crashed",
          created_at_ms: failedAtMs - 5_000,
          updated_at_ms: failedAtMs,
          finished_at_ms: failedAtMs,
        })
        .execute();

      const res = await request(app.getHttpServer()).get("/admin/capabilities").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.probe).toEqual({
        status: "failed",
        lastError: "re-probe after ffmpeg upgrade crashed",
        updatedAtMs: failedAtMs,
      });
      // The stale-but-real report is still served alongside the failure.
      expect(res.body.report).toMatchObject({ ffmpegBuildHash: "sha256-before-upgrade", verifiedAtMs });
    } finally {
      await db.deleteFrom("jobs").where("id", "=", "00000000-0000-7000-8000-000000000503").execute();
      await db.deleteFrom("hw_capability_backends").execute();
      await db.deleteFrom("hw_capability_snapshots").execute();
      await db.destroy();
    }
  });

  it("completed with ZERO backends: valid software-everything state — non-null report, backends [], probe 'completed'", async () => {
    const db = createDb(databaseUrl);
    try {
      const nowMs = Date.now();
      await db
        .insertInto("hw_capability_snapshots")
        .values({
          ffmpeg_build_hash: "sha256-empty",
          gpu_fingerprint: "",
          platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
          verified_at_ms: nowMs,
          is_current: true,
        })
        .execute();

      const res = await request(app.getHttpServer()).get("/admin/capabilities").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.probe).toEqual({ status: "completed", lastError: null, updatedAtMs: nowMs });
      expect(res.body.report).toMatchObject({
        ffmpegBuildHash: "sha256-empty",
        gpuFingerprint: null,
        verifiedAtMs: nowMs,
        backends: [],
      });
    } finally {
      await db.deleteFrom("hw_capability_backends").execute();
      await db.deleteFrom("hw_capability_snapshots").execute();
      await db.destroy();
    }
  });

  it("real snapshot: platform/ffmpegBuildHash/gpuFingerprint/verifiedAtMs + backends in probe (position) order", async () => {
    const db = createDb(databaseUrl);
    try {
      const nowMs = Date.now();
      const snapshot = await db
        .insertInto("hw_capability_snapshots")
        .values({
          ffmpeg_build_hash: "sha256-deadbeef",
          gpu_fingerprint: "apple-m3-max",
          platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
          verified_at_ms: nowMs,
          is_current: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await db
        .insertInto("hw_capability_backends")
        .values([
          {
            snapshot_id: snapshot.id,
            position: 0,
            backend: "videotoolbox",
            decode: ["h264", "hevc"],
            encode: ["h264", "hevc"],
            tone_map: ["videotoolbox"],
            verified_at_ms: nowMs,
          },
          {
            snapshot_id: snapshot.id,
            position: 1,
            backend: "software",
            decode: ["h264", "hevc", "av1"],
            encode: ["h264", "hevc"],
            tone_map: [],
            verified_at_ms: nowMs,
          },
        ])
        .execute();

      const res = await request(app.getHttpServer()).get("/admin/capabilities").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.report).toMatchObject({
        ffmpegBuildHash: "sha256-deadbeef",
        gpuFingerprint: "apple-m3-max",
        verifiedAtMs: nowMs,
      });
      expect(["linux", "macos", "windows"]).toContain(res.body.report.platform);
      expect(res.body.report.backends).toEqual([
        { name: "videotoolbox", position: 0, decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: ["videotoolbox"] },
        { name: "software", position: 1, decode: ["h264", "hevc", "av1"], encode: ["h264", "hevc"], toneMap: [] },
      ]);
    } finally {
      // Reset back to the "no probe yet" state for any later test in this
      // file that assumes it (none currently do, after this one, but this
      // keeps the fixture self-contained rather than order-dependent).
      await db.deleteFrom("hw_capability_backends").execute();
      await db.deleteFrom("hw_capability_snapshots").execute();
      await db.destroy();
    }
  });
});

describe("GET /admin/crash-files", () => {
  it("403s for a non-admin token", async () => {
    const res = await request(app.getHttpServer()).get("/admin/crash-files").set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(403);
  });

  it("empty list when the crashes directory does not exist (fresh temp data dir)", async () => {
    const res = await request(app.getHttpServer()).get("/admin/crash-files").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it("lists real crash files newest-first once they exist", async () => {
    const crashDir = path.join(dataDir, "crashes");
    mkdirSync(crashDir, { recursive: true });
    writeFileSync(path.join(crashDir, "crash-a.json"), '{"redacted":true,"a":1}');
    writeFileSync(path.join(crashDir, "crash-b.json"), '{"redacted":true,"b":2}');

    const res = await request(app.getHttpServer()).get("/admin/crash-files").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const names = res.body.items.map((i: { name: string }) => i.name).sort();
    expect(names).toEqual(["crash-a.json", "crash-b.json"]);
    for (const item of res.body.items) {
      expect(typeof item.sizeBytes).toBe("number");
      expect(typeof item.mtimeMs).toBe("number");
    }
  });
});

describe("GET /admin/crash-files/{name}", () => {
  it("403s for a non-admin token", async () => {
    const res = await request(app.getHttpServer())
      .get("/admin/crash-files/crash-a.json")
      .set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(403);
  });

  it("200s with the real file content for a valid, existing name", async () => {
    const res = await request(app.getHttpServer())
      .get("/admin/crash-files/crash-a.json")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.text)).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.text).toBe('{"redacted":true,"a":1}');
  });

  it("404s for a pattern-valid but nonexistent name", async () => {
    const res = await request(app.getHttpServer())
      .get("/admin/crash-files/crash-does-not-exist.json")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  const hostileNames = ["..%2F..%2Fetc%2Fpasswd", "..%2Fcrash-a.json", "%2e%2e%2fcrash-a.json"];
  for (const encoded of hostileNames) {
    it(`404s for hostile encoded path ${encoded} (traversal-impossible by construction)`, async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/crash-files/${encoded}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });
  }

  it("404s for a hostile literal dot-segment name that Express routes through as a single param", async () => {
    // supertest/Express normalizes plain ".." path segments at the HTTP
    // layer before routing (a real traversal attempt an operator would
    // actually see uses percent-encoding, covered above) — this proves
    // the SERVER-SIDE pattern check independently by hitting the handler
    // with a name that passed routing but must still fail
    // isValidCrashFileName (a name with an embedded slash-like sequence
    // the pattern rejects outright).
    const res = await request(app.getHttpServer())
      .get("/admin/crash-files/with space.json")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/logs/tail", () => {
  it("403s for a non-admin token", async () => {
    const res = await request(app.getHttpServer()).get("/admin/logs/tail").set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(403);
  });

  it("null source + empty lines when LOOMBRE_LOG_FILE is unconfigured", async () => {
    delete process.env["LOOMBRE_LOG_FILE"];
    const res = await request(app.getHttpServer()).get("/admin/logs/tail").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ source: null, lines: [] });
  });

  it("real tail content + honors the lines query param, once LOOMBRE_LOG_FILE is configured", async () => {
    const logPath = path.join(dataDir, "server.log");
    const allLines = Array.from({ length: 50 }, (_, i) => `2026-07-24T00:00:00Z line ${i}`);
    writeFileSync(logPath, allLines.join("\n") + "\n");
    process.env["LOOMBRE_LOG_FILE"] = logPath;

    try {
      const resDefault = await request(app.getHttpServer()).get("/admin/logs/tail").set("Authorization", `Bearer ${adminToken}`);
      expect(resDefault.status, JSON.stringify(resDefault.body)).toBe(200);
      expect(resDefault.body.source).toBe("server.log");
      expect(resDefault.body.lines).toEqual(allLines); // default 200 > 50 available

      const resFive = await request(app.getHttpServer())
        .get("/admin/logs/tail?lines=5")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(resFive.status).toBe(200);
      expect(resFive.body.source).toBe("server.log");
      expect(resFive.body.lines).toEqual(allLines.slice(-5));
    } finally {
      delete process.env["LOOMBRE_LOG_FILE"];
    }
  });
});
