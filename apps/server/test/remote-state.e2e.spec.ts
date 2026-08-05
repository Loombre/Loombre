// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-state.e2e.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, lane WG2, item 6 of this
// lane's own mission — "THEN implement getRemoteState for real, replacing
// the LAST 501"). GET /admin/remote/state composition proof:
// activePath + wireguard/tunnel/direct statuses, each derived from the
// SAME "other path active DIRECTLY via @loombre/db" bypass this
// directory's other cross-path/devices e2e suites already establish (no
// wg-native/live Cloudflare/ACME needed — this suite proves composition,
// not each path's own enable machinery).
//
// Self-sufficient own ensureTestDatabase suffix — same convention as every
// other remote-*.e2e.spec.ts file in this directory.

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import {
  ensureTestDatabase,
  getUserByUsername,
  enableRemoteWireguardAndEmit,
  disableRemoteWireguardAndEmit,
  enableTunnelStateAndEmit,
  disableTunnelStateAndEmit,
  enableRemoteDirectStateAndEmit,
  disableRemoteDirectStateAndEmit,
} from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { DbProvider } from "../src/common/db.provider.js";

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
let dbProvider: DbProvider;
let adminToken: string;
let casualToken: string;
let adminUserId: string;

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_state_e2e_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-state-e2e-test-secret-not-for-production";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  dbProvider = app.get(DbProvider);

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "remote-state-e2e-test-admin",
    deviceProfile: buildDeviceProfile("remote-state-e2e-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;
  const admin = await getUserByUsername(dbProvider.db, "admin");
  if (!admin) throw new Error("seed did not create the admin user");
  adminUserId = admin.id;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "remote-state-e2e-test-casual",
    deviceProfile: buildDeviceProfile("remote-state-e2e-test-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
});

afterAll(async () => {
  await app?.close();
});

afterEach(async () => {
  const nowMs = Date.now();
  await disableRemoteWireguardAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs });
  await disableTunnelStateAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs });
  await disableRemoteDirectStateAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs });
});

function asAdmin() {
  return request(app.getHttpServer()).get("/admin/remote/state").set("Authorization", `Bearer ${adminToken}`);
}

describe("GET /admin/remote/state — auth walls", () => {
  it("401 unauthenticated", async () => {
    const res = await request(app.getHttpServer()).get("/admin/remote/state");
    expect(res.status).toBe(401);
  });

  it("403 for an authenticated non-admin", async () => {
    const res = await request(app.getHttpServer()).get("/admin/remote/state").set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/remote/state — composition", () => {
  it("nothing active: activePath 'none', all three sub-statuses honestly disabled/default-shaped", async () => {
    const res = await asAdmin();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.activePath).toBe("none");
    expect(res.body.wireguard).toMatchObject({ enabled: false, listening: false, peerCount: 0 });
    expect(res.body.tunnel).toMatchObject({ enabled: false, hostname: null });
    expect(res.body.direct).toEqual({ enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null });
  });

  it("WireGuard active (bypass-enabled, no live listener in THIS process): activePath 'remote', wireguard.enabled true", async () => {
    await enableRemoteWireguardAndEmit(dbProvider.db, { serverPublicKey: "remote-state-e2e-key", actorUserId: adminUserId, nowMs: Date.now() });
    const res = await asAdmin();
    expect(res.status).toBe(200);
    expect(res.body.activePath).toBe("remote");
    expect(res.body.wireguard.enabled).toBe(true);
    // tunnel/direct stay honestly untouched.
    expect(res.body.tunnel.enabled).toBe(false);
    expect(res.body.direct.enabled).toBe(false);
  });

  it("Tunnel active: activePath 'tunnel', tunnel.enabled true with the hostname", async () => {
    await enableTunnelStateAndEmit(dbProvider.db, {
      hostname: "media.example.com",
      tunnelId: "remote-state-e2e-tunnel",
      accountId: "acct-1",
      zoneId: "zone-1",
      dnsRecordId: "record-1",
      actorUserId: adminUserId,
      nowMs: Date.now(),
    });
    const res = await asAdmin();
    expect(res.status).toBe(200);
    expect(res.body.activePath).toBe("tunnel");
    expect(res.body.tunnel).toMatchObject({ enabled: true, hostname: "media.example.com" });
    expect(res.body.wireguard.enabled).toBe(false);
    expect(res.body.direct.enabled).toBe(false);
  });

  it("Direct active (reverse-proxy mode): activePath 'direct', direct.enabled true, mode reverse-proxy, domain/cert fields null", async () => {
    await enableRemoteDirectStateAndEmit(dbProvider.db, {
      mode: "reverse-proxy",
      preEnableTlsMode: "off",
      preEnableTrustProxy: "",
      previousActivePath: "none",
      actorUserId: adminUserId,
      nowMs: Date.now(),
    });
    const res = await asAdmin();
    expect(res.status).toBe(200);
    expect(res.body.activePath).toBe("direct");
    expect(res.body.direct).toEqual({ enabled: true, mode: "reverse-proxy", domain: null, certValid: null, certExpiresAtMs: null });
    expect(res.body.wireguard.enabled).toBe(false);
    expect(res.body.tunnel.enabled).toBe(false);
  });

  it("the response conforms to the frozen RemoteState schema shape — additionalProperties:false means no stray fields", async () => {
    const res = await asAdmin();
    expect(Object.keys(res.body).sort()).toEqual(["activePath", "direct", "tunnel", "wireguard"]);
    expect(Object.keys(res.body.wireguard).sort()).toEqual(["enabled", "endpointHost", "listenPort", "listening", "peerCount", "subnet"].sort());
    expect(Object.keys(res.body.tunnel).sort()).toEqual(
      ["enabled", "connectorState", "hostname", "backoffMs", "lastErrorMessage", "tokenConfigured", "tokenSetAtMs", "tokenScopesOk"].sort(),
    );
    expect(Object.keys(res.body.direct).sort()).toEqual(["enabled", "mode", "domain", "certValid", "certExpiresAtMs"].sort());
  });
});
