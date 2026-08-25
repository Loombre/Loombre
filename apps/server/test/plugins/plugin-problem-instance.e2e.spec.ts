// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/plugins/plugin-problem-instance.e2e.spec.ts
//
// Remediation d3-b7 (P3, B/api-validation-F1-adjacent): every problem this
// server raises carries an RFC 9457 `instance` that names WHERE the problem
// happened — every controller passes `req.originalUrl`, and every service
// that raises one without a request in hand (AdminLibraryProviderChain-
// Service, admin-plugins.controller.ts's own toDto) hardcodes the FULL
// MOUNTED path. plugin-lifecycle.service.ts (setEnabled / rotateHmac /
// updateConfig / removePlugin) and plugin-health.service.ts
// (runHealthCheck) instead built `/plugins/{id}` — a path this server does
// not mount at all (the surface is `/admin/plugins/**`, LPP v1 Lane W5).
//
// The defect is observable as a SPLIT on one single URL: with an unknown
// but well-formed uuid, `GET /admin/plugins/{id}` 404s with
// `instance: "/admin/plugins/{id}"` (the controller's own toDto) while
// `DELETE /admin/plugins/{id}` — the very same URL — 404s with
// `instance: "/plugins/{id}"`. Worse on the same handler: a NON-uuid id
// stops at api-validation-F1's `requireUuidParam(id, …, req.originalUrl)`
// and reports the true path, so whether the echoed path exists depended on
// the SHAPE of the id in the URL.
//
// This suite pins the invariant rather than the strings: for every
// plugin-lifecycle route, the 404's `instance` must equal the request path
// that produced it, and no problem body may name the unmounted `/plugins`
// prefix. Deliberately light — nothing here needs a live plugin process
// (every assertion is about an id that resolves to no row), so unlike
// admin-plugins.e2e.spec.ts it spawns no example plugins and touches no
// keyring.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import { HttpException, type INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../../src/app.module.js";
import { PluginHealthService } from "../../src/plugins/plugin-health.service.js";

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

/** Well-formed uuid that resolves to no plugins row on this fresh DB. */
const UNKNOWN_ID = randomUUID();

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "plugin_problem_instance_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "plugin-problem-instance-test-secret-not-for-production";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "plugin-problem-instance-admin",
    deviceProfile: buildDeviceProfile("plugin-problem-instance-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;
});

afterAll(async () => {
  await app?.close();
});

type Call = { label: string; send: (url: string) => request.Test };

function calls(): Call[] {
  const server = () => app.getHttpServer();
  const auth = (t: request.Test) => t.set("Authorization", `Bearer ${adminToken}`);
  return [
    { label: "GET /admin/plugins/{id}", send: (url) => auth(request(server()).get(url)) },
    { label: "DELETE /admin/plugins/{id}", send: (url) => auth(request(server()).delete(url)) },
    { label: "PUT /admin/plugins/{id}/config", send: (url) => auth(request(server()).put(url)).send({ config: {} }) },
    { label: "POST /admin/plugins/{id}/enable", send: (url) => auth(request(server()).post(url)) },
    { label: "POST /admin/plugins/{id}/disable", send: (url) => auth(request(server()).post(url)) },
    { label: "POST /admin/plugins/{id}/rotate-hmac", send: (url) => auth(request(server()).post(url)) },
  ];
}

function urlFor(label: string, id: string): string {
  const suffix = label.split("{id}")[1] ?? "";
  return `/admin/plugins/${id}${suffix}`;
}

describe("d3-b7: plugin problems name the path they actually happened on", () => {
  for (const call of calls()) {
    it(`${call.label} -> 404 whose instance is the request path, not the unmounted /plugins/{id}`, async () => {
      const url = urlFor(call.label, UNKNOWN_ID);
      const res = await call.send(url);

      expect(res.status, `${call.label} ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.body.instance, `${call.label} instance`).toBe(url);
      expect(String(res.body.instance)).not.toMatch(/^\/plugins\//);
    });
  }

  it("agrees with the non-uuid arm of the same handlers (requireUuidParam already echoes the true path)", async () => {
    for (const call of calls()) {
      const url = urlFor(call.label, "not-a-uuid");
      const res = await call.send(url);
      expect(res.status, `${call.label} ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.instance, `${call.label} (non-uuid) instance`).toBe(url);
    }
  });

  // Not reachable over HTTP with an unknown id (registerPlugin has just
  // written the row, refreshPlugin 404s first, and the scheduler has no
  // request at all) — so it is asserted at the service boundary, which is
  // also the only honest place to say what its `instance` should be: the
  // plugin RESOURCE, since three different callers reach this line.
  it("PluginHealthService.runHealthCheck names the plugin resource, not /plugins/{id}", async () => {
    const health = app.get(PluginHealthService);
    let thrown: unknown;
    try {
      await health.runHealthCheck(UNKNOWN_ID);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "runHealthCheck must reject for an unknown plugin id").toBeInstanceOf(HttpException);
    const body = (thrown as HttpException).getResponse() as Record<string, unknown>;
    expect(body["status"]).toBe(404);
    expect(body["instance"]).toBe(`/admin/plugins/${UNKNOWN_ID}`);
  });
});
