// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/plugins/plugin-events-ws.e2e.spec.ts
//
// LD4: all six plugin.* event types register in
// apps/server/src/gateway/ws-broadcaster.service.ts's ADMIN_ONLY_TYPES.
// Mirrors apps/server/test/ws-broadcaster.e2e.spec.ts's own job.updated
// ADMIN_ONLY test EXACTLY (same raw-outbox-row-insert technique, same
// two-live-sockets pattern) — that file already proves the general
// ADMIN_ONLY_TYPES delivery MECHANISM works; this file's only job is
// proving the SIX NEW types were actually added to that list, one socket
// pair reused across all six for speed.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed), per
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
import { createDb, ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");
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

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let app: INestApplication;
let baseWsUrl: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "plugin-events-ws-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "plugin_events_ws_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address() as AddressInfo;
  baseWsUrl = `ws://127.0.0.1:${address.port}/v1/events`;
}, 30_000);

afterAll(async () => {
  await app.close();
});

const PLUGIN_EVENT_SAMPLES: Array<{ type: string; payload: Record<string, unknown> }> = [
  {
    type: "plugin.registered",
    payload: {
      pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
      name: "ws-test-plugin",
      baseUrl: "http://127.0.0.1:1",
      contentClass: "general",
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypes: [],
      registeredAtMs: 1_700_000_000_000,
    },
  },
  {
    type: "plugin.updated",
    payload: {
      pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
      name: "ws-test-plugin",
      change: "manifest",
      oldValue: "0.1.0",
      newValue: "0.1.1",
      updatedAtMs: 1_700_000_000_000,
    },
  },
  {
    type: "plugin.enabled",
    payload: { pluginId: "018f6f1e-0000-7000-8000-0000000000c1", name: "ws-test-plugin", enabledAtMs: 1_700_000_000_000 },
  },
  {
    type: "plugin.disabled",
    payload: {
      pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
      name: "ws-test-plugin",
      reason: "admin",
      disabledAtMs: 1_700_000_000_000,
    },
  },
  {
    type: "plugin.removed",
    payload: { pluginId: "018f6f1e-0000-7000-8000-0000000000c1", name: "ws-test-plugin", removedAtMs: 1_700_000_000_000 },
  },
  {
    type: "plugin.health-changed",
    payload: {
      pluginId: "018f6f1e-0000-7000-8000-0000000000c1",
      name: "ws-test-plugin",
      previousState: "unknown",
      newState: "healthy",
      changedAtMs: 1_700_000_000_000,
    },
  },
];

describe("plugin.* events are ADMIN_ONLY over the /v1/events websocket (LD4)", () => {
  it("every plugin.* type reaches the admin socket and NEVER the casual (non-admin) socket", async () => {
    const httpServer = app.getHttpServer();

    const adminLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "plugin-events-ws-admin",
      deviceProfile: buildDeviceProfile("plugin-events-ws-admin"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;

    const casualLogin = await request(httpServer).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "plugin-events-ws-casual",
      deviceProfile: buildDeviceProfile("plugin-events-ws-casual"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
    const casualToken: string = casualLogin.body.accessToken;

    const adminWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(adminToken)}`);
    const casualWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(casualToken)}`);

    const adminMessages: Array<{ type?: string; payload?: { pluginId?: string } }> = [];
    const casualMessages: Array<{ type?: string; payload?: { pluginId?: string } }> = [];
    adminWs.on("message", (data) => adminMessages.push(JSON.parse(data.toString())));
    casualWs.on("message", (data) => casualMessages.push(JSON.parse(data.toString())));

    await Promise.all([waitForOpen(adminWs), waitForOpen(casualWs)]);

    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const nowMs = Date.now();
      for (const sample of PLUGIN_EVENT_SAMPLES) {
        await db
          .insertInto("events")
          .values({ type: sample.type, ts_ms: nowMs, actor_user_id: null, payload: sample.payload })
          .execute();
      }

      // Broadcaster polls every 500ms — two ticks' worth of margin.
      await sleep(1500);

      for (const sample of PLUGIN_EVENT_SAMPLES) {
        expect(
          adminMessages.some((m) => m.type === sample.type && m.payload?.pluginId === sample.payload["pluginId"]),
          `admin socket should receive ${sample.type}; got ${JSON.stringify(adminMessages)}`,
        ).toBe(true);
        expect(
          casualMessages.some((m) => m.type === sample.type),
          `casual (non-admin) socket must NEVER receive ${sample.type}; got ${JSON.stringify(casualMessages)}`,
        ).toBe(false);
      }

      // Negative window: nothing further arrives for casual after this point.
      const casualCountAfterFirstWindow = casualMessages.length;
      await sleep(750);
      expect(casualMessages.length, "casual socket received additional message(s) during the negative-window grace period").toBe(
        casualCountAfterFirstWindow,
      );
    } finally {
      await db.destroy();
      adminWs.close();
      casualWs.close();
    }
  }, 20_000);
});
