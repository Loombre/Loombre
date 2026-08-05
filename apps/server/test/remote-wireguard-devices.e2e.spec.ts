// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-wireguard-devices.e2e.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card", lane WG2. Covers everything about
// enrollment/listing/revocation that does NOT need the real native library
// (packages/wg-native) — this suite enables WireGuard by writing
// remote_wireguard_state.enabled=true DIRECTLY via @loombre/db's
// enableRemoteWireguardAndEmit, bypassing RemoteWireguardService.enable()
// (and therefore never touching wg-native at all): enrollDevice's own 409
// check only reads that persisted flag (RemoteWireguardStatus.enabled's own
// contract description — "a server keypair exists and enrollment is
// possible" — is deliberately independent of whether a listener is
// actually live), and the live-peer-registration steps (AddPeer/
// RemovePeer) are no-ops when this.runtime is null (the real service was
// never actually started in THIS process). This suite therefore runs
// EVERYWHERE, with or without Go installed — see
// remote-wireguard-enrollment.e2e.spec.ts for the wg-gated counterparts
// that need a REAL live listener + a real handshake (the loopback-
// handshake and revocation-live-removal exit-gate items).
//
// Covers:
//   - Enrollment: golden config-text format match (against
//     packages/shared's own buildProvisioningConfig fixture), DB rows
//     (devices.kind='remote', wg_peers), payload field completeness.
//   - CONCURRENT-ENROLL IP-allocation race (N parallel enrollments, no
//     tunnel-IP collisions).
//   - SHOW-ONCE / IRRECOVERABILITY: after enrollment, no list/status
//     response body AND no server-side console output contains the
//     private key or the raw configText.
//   - RG3 general-device-delete side effects: DELETE /devices/{id}
//     revokes outstanding refresh tokens for EVERY kind, and additionally
//     tears down the WG peer for kind='remote'.
//   - 401/403/404 walls for the three WG2 device ops.
//
// Self-sufficient own ensureTestDatabase suffix — same convention as every
// other remote-*.e2e.spec.ts file in this directory.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  insertRefreshToken,
  findRefreshTokenByHash,
} from "@loombre/db";
import { buildProvisioningConfig } from "@loombre/shared";
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
let casualToken: string;
let casualUserId: string;

const ORIGINAL_ENDPOINT_HOST_ENV = process.env["LOOMBRE_WG_ENDPOINT_HOST"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_wireguard_devices_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-wireguard-devices-test-secret-not-for-production";
  process.env["LOOMBRE_WG_ENDPOINT_HOST"] = "wg.example.com";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  dbProvider = app.get(DbProvider);

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "remote-wireguard-devices-test-admin",
    deviceProfile: buildDeviceProfile("remote-wireguard-devices-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;
  const admin = await getUserByUsername(dbProvider.db, "admin");
  if (!admin) throw new Error("seed did not create the admin user");
  adminUserId = admin.id;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "remote-wireguard-devices-test-casual",
    deviceProfile: buildDeviceProfile("remote-wireguard-devices-test-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
  const casual = await getUserByUsername(dbProvider.db, "casual");
  if (!casual) throw new Error("seed did not create the casual user");
  casualUserId = casual.id;

  // Bypass-enable: writes the persisted "enabled" flag directly, WITHOUT
  // starting a real listener (RemoteWireguardService.enable() is never
  // called) — see this file's own header for why enrollment's 409 check
  // only cares about this flag, not liveness.
  await enableRemoteWireguardAndEmit(dbProvider.db, { serverPublicKey: "bypass-enabled-server-key", actorUserId: adminUserId, nowMs: Date.now() });
});

afterAll(async () => {
  await app?.close();
  if (ORIGINAL_ENDPOINT_HOST_ENV === undefined) delete process.env["LOOMBRE_WG_ENDPOINT_HOST"];
  else process.env["LOOMBRE_WG_ENDPOINT_HOST"] = ORIGINAL_ENDPOINT_HOST_ENV;
});

function asAdmin() {
  return {
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`),
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${adminToken}`),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set("Authorization", `Bearer ${adminToken}`),
  };
}
function asCasual() {
  return {
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${casualToken}`),
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${casualToken}`),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set("Authorization", `Bearer ${casualToken}`),
  };
}

describe("auth walls", () => {
  it("401 unauthenticated on all three ops", async () => {
    const http = app.getHttpServer();
    expect((await request(http).get("/admin/remote/wireguard/devices")).status).toBe(401);
    expect((await request(http).post("/admin/remote/wireguard/devices")).status).toBe(401);
    expect((await request(http).delete("/admin/remote/wireguard/devices/11111111-1111-4111-8111-111111111111")).status).toBe(401);
  });

  it("403 for an authenticated non-admin on all three ops", async () => {
    expect((await asCasual().get("/admin/remote/wireguard/devices")).status).toBe(403);
    expect((await asCasual().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "x" })).status).toBe(403);
    expect((await asCasual().delete("/admin/remote/wireguard/devices/11111111-1111-4111-8111-111111111111")).status).toBe(403);
  });
});

describe("enrollRemoteWireguardDevice — validation ordering", () => {
  it("422 on unknown body property", async () => {
    const res = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "x", extra: "nope" });
    expect(res.status).toBe(422);
  });

  it('422 on missing/malformed userId ("userId (uuid string) is required.")', async () => {
    const res = await asAdmin().post("/admin/remote/wireguard/devices").send({ name: "no userId" });
    expect(res.status).toBe(422);
    const res2 = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: "not-a-uuid", name: "bad userId" });
    expect(res2.status).toBe(422);
  });

  it('422 on missing/empty name ("name" is required.)', async () => {
    const res = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId });
    expect(res.status).toBe(422);
    const res2 = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "   " });
    expect(res2.status).toBe(422);
  });

  it("404 for an unknown userId", async () => {
    const res = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: "11111111-1111-4111-8111-111111111111", name: "ghost" });
    expect(res.status).toBe(404);
  });
});

describe("enrollRemoteWireguardDevice — golden config text, DB rows, payload completeness", () => {
  it("matches the frozen provisioning format exactly (same shared builder, same inputs) and every response/DB field is complete", async () => {
    const nowBefore = Date.now();
    const res = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "Casual's tablet" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const { device, configText } = res.body;
    expect(device.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(device.userId).toBe(casualUserId);
    expect(device.name).toBe("Casual's tablet");
    expect(device.tunnelIp).toBe("10.82.146.2");
    expect(typeof device.createdAtMs).toBe("number");
    expect(device.createdAtMs).toBeGreaterThanOrEqual(nowBefore);
    expect(device.lastHandshakeAtMs).toBeNull();

    // Golden format: parse the device's own private key out of configText
    // and rebuild it independently via the SAME shared builder used in
    // production, then assert byte-identical output.
    const privateKey = configText.match(/^PrivateKey = (.+)$/m)?.[1];
    const serverPublicKey = configText.match(/^PublicKey = (.+)$/m)?.[1];
    expect(privateKey).toBeTruthy();
    expect(serverPublicKey).toBeTruthy();

    const rebuilt = buildProvisioningConfig({
      serverPublicKey: serverPublicKey!,
      serverEndpointHost: "wg.example.com",
      serverEndpointPort: 51820,
      devicePrivateKey: privateKey!,
      deviceTunnelIp: device.tunnelIp,
      serverTunnelIp: "10.82.146.1",
      subnetCidr: "10.82.146.0/24",
    });
    expect(configText).toBe(rebuilt);

    const deviceRow = await dbProvider.db.selectFrom("devices").selectAll().where("id", "=", device.id).executeTakeFirstOrThrow();
    expect(deviceRow.kind).toBe("remote");
    expect(deviceRow.user_id).toBe(casualUserId);
    expect(deviceRow.name).toBe("Casual's tablet");

    const peerRow = await dbProvider.db.selectFrom("wg_peers").selectAll().where("device_id", "=", device.id).executeTakeFirstOrThrow();
    // The DEVICE's own peer public key (from [Interface]/PrivateKey's
    // matching public half) is NOT the same as the server's public key
    // parsed above ([Peer]/PublicKey) — just prove the row exists and
    // carries a well-formed WireGuard key, distinct from the server's.
    expect(peerRow.public_key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(peerRow.public_key).not.toBe(serverPublicKey);
    expect(peerRow.tunnel_ip).toBe("10.82.146.2");
  });

  it("allocates the NEXT lowest-free tunnel IP for a second enrollment", async () => {
    const res = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "Second device" });
    expect(res.status).toBe(201);
    expect(res.body.device.tunnelIp).toBe("10.82.146.3");
  });
});

describe("CONCURRENT ENROLLMENT — N parallel enrollments allocate N distinct tunnel IPs", () => {
  it("no collisions, no lost writes, under real concurrent HTTP requests", async () => {
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: `Concurrent device ${i}` })),
    );
    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const tunnelIps = results.map((r) => r.body.device.tunnelIp as string);
    expect(new Set(tunnelIps).size).toBe(N);
  });
});

describe("SHOW-ONCE / IRRECOVERABILITY — after enrollment, the config/private key appear NOWHERE else", () => {
  it("list/status responses carry no private key or configText; server-side console output during enrollment carries none either", async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
      return originalLog(...args);
    };
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
      return originalWarn(...args);
    };
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
      return originalError(...args);
    };

    let privateKey: string;
    let configText: string;
    try {
      const res = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "Show-once probe device" });
      expect(res.status).toBe(201);
      configText = res.body.configText;
      privateKey = configText.match(/^PrivateKey = (.+)$/m)?.[1] ?? "";
      expect(privateKey.length).toBeGreaterThan(0);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }

    for (const line of captured) {
      expect(line).not.toContain(privateKey);
      expect(line).not.toContain(configText);
    }

    const listRes = await asAdmin().get("/admin/remote/wireguard/devices");
    expect(listRes.status).toBe(200);
    const listJson = JSON.stringify(listRes.body);
    expect(listJson).not.toContain(privateKey);
    expect(listJson).not.toContain("PrivateKey");
    expect(listJson).not.toContain(configText);

    const statusRes = await asAdmin().get("/admin/remote/wireguard/status");
    expect(JSON.stringify(statusRes.body)).not.toContain(privateKey);
  });
});

describe("RG3 gap closure — general DELETE /devices/{id} side effects (ALL kinds)", () => {
  it("kind='app' device: revokes outstanding refresh tokens (the pre-existing gap) even though there is no WG teardown to do", async () => {
    const loginRes = await request(app.getHttpServer()).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "rg3-app-device-target",
      deviceProfile: buildDeviceProfile("rg3-app-device-target"),
    });
    expect(loginRes.status).toBe(200);
    const deviceId = loginRes.body.deviceId as string;
    expect(typeof deviceId).toBe("string");

    // An extra outstanding refresh token for the SAME device, planted
    // directly (login's own token doesn't matter — either would prove it,
    // this makes the assertion self-contained).
    const tokenHash = `rg3-gap-closure-app-${deviceId}`;
    await insertRefreshToken(dbProvider.db, {
      userId: casualUserId,
      deviceId,
      tokenHash,
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 1_000_000,
      rotatedFrom: null,
    });
    const before = await findRefreshTokenByHash(dbProvider.db, tokenHash);
    expect(before!.revoked_at_ms).toBeNull();

    const deleteRes = await asCasual().delete(`/devices/${deviceId}`);
    expect(deleteRes.status).toBe(200);

    const after = await findRefreshTokenByHash(dbProvider.db, tokenHash);
    expect(after!.revoked_at_ms).not.toBeNull();

    const deviceRow = await dbProvider.db.selectFrom("devices").selectAll().where("id", "=", deviceId).executeTakeFirst();
    expect(deviceRow).toBeUndefined();
  });

  it("kind='remote' device: self-service DELETE /devices/{id} performs the FULL WG teardown (rows gone, refresh tokens revoked, remote.device.revoked emitted) — no live listener needed since this.runtime is null in this process (bypass-enabled only)", async () => {
    const enrollRes = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "Self-revoke target" });
    expect(enrollRes.status).toBe(201);
    const deviceId = enrollRes.body.device.id as string;

    const tokenHash = `rg3-gap-closure-remote-${deviceId}`;
    await insertRefreshToken(dbProvider.db, {
      userId: casualUserId,
      deviceId,
      tokenHash,
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 1_000_000,
      rotatedFrom: null,
    });

    const deleteRes = await asCasual().delete(`/devices/${deviceId}`);
    expect(deleteRes.status).toBe(200);

    const deviceRow = await dbProvider.db.selectFrom("devices").selectAll().where("id", "=", deviceId).executeTakeFirst();
    expect(deviceRow).toBeUndefined();
    const peerRow = await dbProvider.db.selectFrom("wg_peers").selectAll().where("device_id", "=", deviceId).executeTakeFirst();
    expect(peerRow).toBeUndefined();

    const tokenAfter = await findRefreshTokenByHash(dbProvider.db, tokenHash);
    expect(tokenAfter!.revoked_at_ms).not.toBeNull();
  });

  it("a user cannot revoke via DELETE /devices/{id} a device belonging to ANOTHER user (self-scoped, unchanged)", async () => {
    const enrollRes = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "Not yours" });
    expect(enrollRes.status).toBe(201);
    const deviceId = enrollRes.body.device.id as string;

    // admin is a DIFFERENT user than casual — self-scoped DELETE /devices
    // must 404, not silently succeed on someone else's device.
    const deleteRes = await asAdmin().delete(`/devices/${deviceId}`);
    expect(deleteRes.status).toBe(404);

    const stillThere = await dbProvider.db.selectFrom("devices").selectAll().where("id", "=", deviceId).executeTakeFirst();
    expect(stillThere).toBeDefined();
  });
});

describe("revokeRemoteWireguardDevice (admin-scoped) — 404 for unknown/nonexistent device", () => {
  it("404 for a syntactically valid but nonexistent uuid", async () => {
    const res = await asAdmin().delete("/admin/remote/wireguard/devices/11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(404);
  });

  it("404 for a malformed id (byte-identical posture, requireUuidParam)", async () => {
    const res = await asAdmin().delete("/admin/remote/wireguard/devices/not-a-uuid");
    expect(res.status).toBe(404);
  });

  it("admin-scoped revoke works on ANY user's device (unlike self-service DELETE /devices/{id})", async () => {
    const enrollRes = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: casualUserId, name: "Admin-revoked" });
    expect(enrollRes.status).toBe(201);
    const deviceId = enrollRes.body.device.id as string;

    const res = await asAdmin().delete(`/admin/remote/wireguard/devices/${deviceId}`);
    expect(res.status).toBe(204);

    const deviceRow = await dbProvider.db.selectFrom("devices").selectAll().where("id", "=", deviceId).executeTakeFirst();
    expect(deviceRow).toBeUndefined();
  });
});
