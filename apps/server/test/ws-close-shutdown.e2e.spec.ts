// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/ws-close-shutdown.e2e.spec.ts
//
// Remote-access verification finding (2026-08-30, found while pinning the
// WS-over-TLS fix): a client that connected to /v1/events and dropped
// IMMEDIATELY left the broadcaster's fire-and-forget connection-setup work
// (resolveSurfaces — a 3-way Promise.all that spawns fresh pg pool
// clients) racing graceful shutdown. GatewayModule is destroyed before
// CommonModule, so DbProvider's pool.end() could run mid-client-
// acquisition — and pg.Pool.end() during an in-flight connect NEVER
// resolves: app.close() hung forever (in production: every SIGTERM after
// any WS disconnect waited for the supervisor's SIGKILL). The fix makes
// WsBroadcasterService.onModuleDestroy await its own in-flight setup/poll
// work before the pool is torn down, and clears the zombie map entry a
// mid-resolve disconnect used to leave behind.
//
// The trigger needs the close to land INSIDE resolveSurfaces's in-flight
// window (~20ms) — hence close immediately after open, no settling sleep.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed) per
// this package's established live-DB test convention.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
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
let adminToken: string;
let port: number;
let appClosed = false;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "ws-close-shutdown-test-secret-not-for-production";
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "ws_close_shutdown_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  port = (app.getHttpServer().address() as AddressInfo).port;

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "ws-close-shutdown-test-admin",
    deviceProfile: buildDeviceProfile("ws-close-shutdown-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  if (!appClosed) await app?.close();
});

describe("graceful shutdown after an immediate WS disconnect", () => {
  it("app.close() completes after a client connects to /v1/events and drops at once", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/events?token=${adminToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // Close INSIDE the connection-setup window — no settling sleep. The
    // await only covers the client-side handshake; the server-side
    // resolveSurfaces is still in flight when close() below returns.
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });

    // The whole point: this must resolve (pre-fix it hung forever on
    // pool.end() waiting for clients acquired by the orphaned setup work).
    await app.close();
    appClosed = true;
    expect(appClosed).toBe(true);
  }, 25_000);
});
