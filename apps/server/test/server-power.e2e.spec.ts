// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /system/restart + /system/shutdown (contract restartServer /
 * shutdownServer) — the admin power actions behind the web client's
 * "Restart server / Shut down server" controls.
 *
 * What this suite pins, beyond the conformance walk's status codes:
 *  - 401 wall unauthenticated; 403 for an authenticated NON-admin (the
 *    requireAdmin fast-fail + requireLiveAdmin fresh-read pair).
 *  - UNARMED (embedded context, this suite's own default): 202 accepted
 *    and nothing else happens — the seam that keeps the conformance
 *    walk from SIGTERMing the test runner is itself under test here.
 *  - ARMED (fake triggers injected via app.get(ServerPowerService).arm):
 *    the correct trigger fires exactly once, only AFTER the 202 has been
 *    flushed, and restart/shutdown never cross wires.
 *  - Container supervision (LOOMBRE_SUPERVISOR=container, the shipped
 *    Docker image's env): shutdown is refused 409 with the documented
 *    problem code BEFORE any trigger involvement — an in-process exit
 *    cannot keep an unless-stopped container down, so the endpoint must
 *    not pretend — while restart stays a 202 (any exit restarts there).
 */
import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { ServerPowerService } from "../src/common/server-power.service.js";

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
let casualToken: string;
let power: ServerPowerService;

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username,
      password,
      deviceName: `server-power-e2e-${username}-${Date.now()}-${Math.random()}`,
      deviceProfile: buildDeviceProfile(),
    });
  if (res.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

/** One macrotask, so a res.once("finish") hook that WAS going to fire has
 *  had every chance to — used to prove the negative (unarmed = nothing). */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeTriggers {
  restartCalls = 0;
  shutdownCalls = 0;
  restart = () => {
    this.restartCalls += 1;
  };
  shutdown = () => {
    this.shutdownCalls += 1;
  };
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_server_power");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "server-power-e2e-test-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";
  delete process.env["LOOMBRE_SUPERVISOR"];

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  power = app.get(ServerPowerService);
  adminToken = await loginAs("admin", "loombre-seed-admin");
  casualToken = await loginAs("casual", "loombre-seed-casual");
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  delete process.env["LOOMBRE_SUPERVISOR"];
});

describe("auth walls", () => {
  it("unauthenticated restart/shutdown -> 401 problem", async () => {
    for (const p of ["/system/restart", "/system/shutdown"]) {
      const res = await request(app.getHttpServer()).post(p);
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
    }
  });

  it("authenticated NON-admin -> 403, and no trigger involvement even when armed", async () => {
    const fakes = new FakeTriggers();
    power.arm(fakes);
    for (const p of ["/system/restart", "/system/shutdown"]) {
      const res = await request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${casualToken}`);
      expect(res.status).toBe(403);
    }
    await tick();
    expect(fakes.restartCalls).toBe(0);
    expect(fakes.shutdownCalls).toBe(0);
  });
});

describe("unarmed (embedded context) — the conformance-walk safety property", () => {
  it("a fresh, never-armed service's post-response hook is a logged no-op", async () => {
    // Unit-level on a FRESH instance: the app-wide instance in this suite
    // gets armed by other tests (arm() is last-writer-wins by design —
    // main.ts calls it exactly once), so the unarmed property is pinned
    // here without depending on test order. The walk-level version of
    // this property is the conformance suite itself surviving its
    // authenticated POST /system/restart call.
    const fresh = new ServerPowerService();
    const { EventEmitter } = await import("node:events");
    const fakeRes = new EventEmitter();
    fresh.scheduleAfterResponse(fakeRes as never, "restart", "unit-test");
    fakeRes.emit("finish"); // must not throw, must not exit — nothing is armed
    await tick();
  });
});

describe("armed — the real path main.ts wires", () => {
  it("admin restart -> 202 {accepted, action:'restart'} and ONLY the restart trigger fires", async () => {
    const fakes = new FakeTriggers();
    power.arm(fakes);
    const res = await request(app.getHttpServer())
      .post("/system/restart")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true, action: "restart" });
    await tick();
    expect(fakes.restartCalls).toBe(1);
    expect(fakes.shutdownCalls).toBe(0);
  });

  it("admin shutdown -> 202 {accepted, action:'shutdown'} and ONLY the shutdown trigger fires", async () => {
    const fakes = new FakeTriggers();
    power.arm(fakes);
    const res = await request(app.getHttpServer())
      .post("/system/shutdown")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true, action: "shutdown" });
    await tick();
    expect(fakes.shutdownCalls).toBe(1);
    expect(fakes.restartCalls).toBe(0);
  });
});

describe("container supervision (LOOMBRE_SUPERVISOR=container — the shipped Docker image env)", () => {
  it("shutdown -> 409 with the documented problem code, trigger untouched", async () => {
    const fakes = new FakeTriggers();
    power.arm(fakes);
    process.env["LOOMBRE_SUPERVISOR"] = "container";
    const res = await request(app.getHttpServer())
      .post("/system/shutdown")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body.code).toBe("shutdown-unsupported-under-container-supervision");
    expect(res.body.detail).toContain("docker compose stop");
    await tick();
    expect(fakes.shutdownCalls).toBe(0);
  });

  it("restart stays 202 under container supervision (any exit restarts there)", async () => {
    const fakes = new FakeTriggers();
    power.arm(fakes);
    process.env["LOOMBRE_SUPERVISOR"] = "container";
    const res = await request(app.getHttpServer())
      .post("/system/restart")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    await tick();
    expect(fakes.restartCalls).toBe(1);
  });
});
