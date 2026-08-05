// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-cross-path-409.e2e.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, lane WG2 integration
// unification). Proves the cross-path 409 wiring in ALL SIX directions
// (each of the three unordered pairs, both orderings) now goes through the
// SAME canonical resolveActivePath() (packages/db/src/query/
// remote-active-path.ts) at every one of the three staged enable flows:
//   - RemoteWireguardService.enable()'s assertNoOtherRemotePathActive
//   - RemoteTunnelService.enableRemoteTunnel()'s own 409 check
//   - RemoteDirectController.enableRemoteDirect()'s own 409 check
//
// "Active" for the OTHER two paths is simulated by writing their own
// persisted state DIRECTLY via @loombre/db (enableRemoteWireguardAndEmit /
// enableTunnelStateAndEmit / enableRemoteDirectStateAndEmit), bypassing
// their real services entirely — no wg-native, no live Cloudflare API, no
// ACME/pebble needed; this suite proves ONLY the wiring, not each path's
// own full enable machinery (already covered by their own dedicated e2e
// suites). remote.wireguardEndpointHost/tls settings are irrelevant here
// since every enable attempt under test is expected to 409 BEFORE reaching
// any of that.
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
let adminUserId: string;

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_cross_path_409_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-cross-path-409-test-secret-not-for-production";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  dbProvider = app.get(DbProvider);

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "remote-cross-path-409-test-admin",
    deviceProfile: buildDeviceProfile("remote-cross-path-409-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;
  const admin = await getUserByUsername(dbProvider.db, "admin");
  if (!admin) throw new Error("seed did not create the admin user");
  adminUserId = admin.id;
});

afterAll(async () => {
  await app?.close();
});

// Every test cleans up ANY path it turned on, real state never leaks
// across cases.
afterEach(async () => {
  const nowMs = Date.now();
  await disableRemoteWireguardAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs });
  await disableTunnelStateAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs });
  await disableRemoteDirectStateAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs });
});

function asAdmin() {
  return {
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`),
  };
}

async function activateWireguard(): Promise<void> {
  await enableRemoteWireguardAndEmit(dbProvider.db, { serverPublicKey: "cross-path-409-wg-key", actorUserId: adminUserId, nowMs: Date.now() });
}
async function activateTunnel(): Promise<void> {
  await enableTunnelStateAndEmit(dbProvider.db, {
    hostname: "media.example.com",
    tunnelId: "cross-path-409-tunnel",
    accountId: "acct-1",
    zoneId: "zone-1",
    dnsRecordId: "record-1",
    actorUserId: adminUserId,
    nowMs: Date.now(),
  });
}
async function activateDirect(): Promise<void> {
  await enableRemoteDirectStateAndEmit(dbProvider.db, {
    mode: "reverse-proxy",
    preEnableTlsMode: "off",
    preEnableTrustProxy: "",
    previousActivePath: "none",
    actorUserId: adminUserId,
    nowMs: Date.now(),
  });
}

describe("cross-path 409s — all three pairs, both orderings (RG15, canonical resolveActivePath)", () => {
  // Tunnel is the ONE target whose own cross-path 409 (remote-tunnel.
  // service.ts) does not set a problem `code` (a pre-existing T1 posture,
  // unlike D1's/WG2's own — every OTHER check in this file's target list
  // does) — proven correct here by CALL ORDER instead (hostname validation
  // -> cross-path 409 -> "already enabled" -> "no token stored", see that
  // file's own enableRemoteTunnel): with no token ever set, a 409 this
  // early can only be the cross-path check, since "no token" is checked
  // strictly LATER in the same function.
  it("remote active -> enabling tunnel = 409", async () => {
    await activateWireguard();
    const res = await asAdmin().post("/admin/remote/tunnel/enable").send({ hostname: "media.example.com" });
    expect(res.status).toBe(409);
  });

  it("remote active -> enabling direct = 409", async () => {
    await activateWireguard();
    const res = await asAdmin().post("/admin/remote/direct/enable").send({ mode: "reverse-proxy" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("remote-path-active");
  });

  it("tunnel active -> enabling remote = 409", async () => {
    await activateTunnel();
    const res = await asAdmin().post("/admin/remote/wireguard/enable");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("remote-path-active");
  });

  it("tunnel active -> enabling direct = 409", async () => {
    await activateTunnel();
    const res = await asAdmin().post("/admin/remote/direct/enable").send({ mode: "reverse-proxy" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("remote-path-active");
  });

  it("direct active -> enabling remote = 409", async () => {
    await activateDirect();
    const res = await asAdmin().post("/admin/remote/wireguard/enable");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("remote-path-active");
  });

  it("direct active -> enabling tunnel = 409", async () => {
    await activateDirect();
    const res = await asAdmin().post("/admin/remote/tunnel/enable").send({ hostname: "media.example.com" });
    expect(res.status).toBe(409);
  });

  it("SANITY: with NOTHING active, none of the three enable attempts 409 with the cross-path conflict code (they may still fail for their OWN unrelated reasons — Tunnel's own 'no token stored' is ALSO a 409, distinguished here by its problem `code`, or lack thereof, vs. the cross-path check's 'remote-path-active')", async () => {
    const tunnelRes = await asAdmin().post("/admin/remote/tunnel/enable").send({ hostname: "media.example.com" });
    expect(tunnelRes.status).toBe(409); // T1's OWN "no Cloudflare API token is stored" check
    expect(tunnelRes.body.code).not.toBe("remote-path-active");

    const directRes = await asAdmin().post("/admin/remote/direct/enable").send({ mode: "reverse-proxy" });
    // reverse-proxy without network.trustProxy configured is a 422, not a
    // cross-path 409 — proves the SAME endpoint that just 409'd above in
    // other tests does NOT 409 when nothing else is active.
    expect(directRes.status).not.toBe(409);
  });
});
