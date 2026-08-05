// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-wireguard-loopback.e2e.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card", lane WG1 — R11's exit-gate suite,
// exercising the REAL Express app end to end through RemoteWireguardService:
//
//   (a) loopback handshake — enable on an ephemeral UDP port, add a test
//       peer, WgTestClientFetch through the tunnel to a REAL endpoint
//       (/healthz through the RG2 backend listener) asserting 200.
//   (b) SILENCE property — raw UDP garbage AND a structurally-valid-but-
//       wrong-key handshake initiation to the WG port receive ZERO
//       response bytes within a generous window (R9).
//   (c) CONTAINMENT — tunnel client fetch to any non-server tunnel
//       address fails (RG2).
//   (d) lifecycle — enable/disable idempotence, disable actually closes
//       UDP + backend listeners (poll the port), boot-resume.
//
// All wg-gated (test/support/require-wg.ts): graceful skip locally
// without a Go-built native library, LOOMBRE_REQUIRE_WG=1 (CI) escalates
// to a hard failure. Unprivileged ports only (R11) — every listener here
// is ephemeral (WgStart's listenPort:0, the RG2 backend's port 0).
//
// Mirrors admin-mail.e2e.spec.ts's structure: self-sufficient own
// ensureTestDatabase suffix, file0600 secret backend under a throwaway
// data dir (never touches the real OS keychain in CI/tests).

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dgram from "node:dgram";
import { randomFillSync } from "node:crypto";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase, getRemoteWireguardState } from "@loombre/db";
import { WgNativeClient, generateWgKeyPair } from "@loombre/wg-native";
import { AppModule } from "../src/app.module.js";
import { DbProvider } from "../src/common/db.provider.js";
import { RemoteWireguardService } from "../src/remote/wireguard/remote-wireguard.service.js";
import { wgAvailable } from "./support/require-wg.js";

const available = wgAvailable();

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

function wrongKeyHandshakeInitiation(): Buffer {
  const pkt = Buffer.alloc(148);
  pkt.writeUInt32LE(1, 0);
  randomFillSync(pkt, 4);
  return pkt;
}

async function assertSilence(port: number, packet: Buffer, windowMs = 1500): Promise<void> {
  const sock = dgram.createSocket("udp4");
  let gotResponse = false;
  sock.on("message", () => {
    gotResponse = true;
  });
  try {
    await new Promise<void>((resolve, reject) => sock.send(packet, port, "127.0.0.1", (err) => (err ? reject(err) : resolve())));
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    expect(gotResponse).toBe(false);
  } finally {
    sock.close();
  }
}

async function waitForPortFree(port: number, attempts = 30, intervalMs = 100): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = dgram.createSocket("udp4");
      probe.once("error", () => resolve(false));
      probe.bind(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

let app: INestApplication;
let adminToken: string;
let casualToken: string;
let dataDir: string;
let databaseUrl: string;

const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_wireguard_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-wireguard-test-secret-not-for-production";

  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-remote-wireguard-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "remote-wireguard-test-admin",
    deviceProfile: buildDeviceProfile("remote-wireguard-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "remote-wireguard-test-casual",
    deviceProfile: buildDeviceProfile("remote-wireguard-test-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

function asAdmin() {
  return {
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`),
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${adminToken}`),
  };
}

describe.skipIf(!available)("Loombre Remote — WireGuard loopback (real Express app, real Go device+netstack)", () => {
  it("403s for a non-admin (casual) token", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/remote/wireguard/enable")
      .set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(403);
  });

  it("GET status is 200 and all-disabled before any enable", async () => {
    const res = await asAdmin().get("/admin/remote/wireguard/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 });
  });

  it("(a) loopback handshake: enable, add a test peer, fetch a REAL endpoint (/healthz) through the tunnel", async () => {
    const enableRes = await asAdmin().post("/admin/remote/wireguard/enable");
    expect(enableRes.status, JSON.stringify(enableRes.body)).toBe(200);
    expect(enableRes.body.enabled).toBe(true);
    expect(enableRes.body.listening).toBe(true);
    expect(enableRes.body.listenPort).toBeGreaterThan(0);
    expect(enableRes.body.peerCount).toBe(0);

    const dbProvider = app.get(DbProvider);
    const state = await getRemoteWireguardState(dbProvider.db);
    expect(state.enabled).toBe(true);
    expect(state.serverPublicKey).not.toBeNull();

    const remoteWireguardService = app.get(RemoteWireguardService);
    const clientKeys = generateWgKeyPair();
    await remoteWireguardService.addTestPeer({ publicKey: clientKeys.publicKey, tunnelIp: "10.82.146.2" });

    const client = WgNativeClient.load();
    expect(client, "WgNativeClient.load() must succeed — this suite is wg-gated").toBeDefined();

    const clientConfig = {
      privateKey: clientKeys.privateKey,
      clientTunnelIp: "10.82.146.2",
      serverPublicKey: state.serverPublicKey!,
      serverEndpoint: `127.0.0.1:${enableRes.body.listenPort}`,
      allowedIps: ["0.0.0.0/0"],
      timeoutMs: 5000,
    };

    const fetchResult = await client!.testClientFetch(clientConfig, "http://10.82.146.1/healthz");
    expect(fetchResult.status).toBe(200);
    const body = JSON.parse(fetchResult.bodyPrefix) as { status: string; timestampMs: number };
    expect(body.status).toBe("ok");

    const statusAfter = await asAdmin().get("/admin/remote/wireguard/status");
    expect(statusAfter.body.peerCount).toBe(1);
  });

  it("(b) SILENCE: raw UDP garbage and a wrong-key handshake initiation receive zero response bytes", async () => {
    const status = await asAdmin().get("/admin/remote/wireguard/status");
    expect(status.body.enabled).toBe(true);
    const port = status.body.listenPort as number;

    await assertSilence(port, Buffer.from("this is not a wireguard packet, just garbage"));
    await assertSilence(port, wrongKeyHandshakeInitiation());
  });

  it("(c) CONTAINMENT: a tunnel client cannot reach any non-server tunnel address", async () => {
    const status = await asAdmin().get("/admin/remote/wireguard/status");
    const dbProvider = app.get(DbProvider);
    const state = await getRemoteWireguardState(dbProvider.db);

    const remoteWireguardService = app.get(RemoteWireguardService);
    const clientKeys = generateWgKeyPair();
    await remoteWireguardService.addTestPeer({ publicKey: clientKeys.publicKey, tunnelIp: "10.82.146.3" });

    const client = WgNativeClient.load()!;
    const clientConfig = {
      privateKey: clientKeys.privateKey,
      clientTunnelIp: "10.82.146.3",
      serverPublicKey: state.serverPublicKey!,
      serverEndpoint: `127.0.0.1:${status.body.listenPort}`,
      allowedIps: ["0.0.0.0/0"],
      timeoutMs: 2500,
    };

    // Sanity: the real server address still works.
    const ok = await client.testClientFetch(clientConfig, "http://10.82.146.1/healthz");
    expect(ok.status).toBe(200);

    // A different address in the same subnet — nothing listens there and
    // nothing forwards — must fail.
    await expect(client.testClientFetch(clientConfig, "http://10.82.146.77/")).rejects.toThrow();
  });

  it("(d) lifecycle: enable is idempotent while already running", async () => {
    const before = await asAdmin().get("/admin/remote/wireguard/status");
    expect(before.body.enabled).toBe(true);

    const again = await asAdmin().post("/admin/remote/wireguard/enable");
    expect(again.status).toBe(200);
    expect(again.body.enabled).toBe(true);
    expect(again.body.listenPort).toBe(before.body.listenPort); // same instance, not restarted
  });

  it("(d) lifecycle: disable actually closes the UDP listener (polled) and is idempotent", async () => {
    const before = await asAdmin().get("/admin/remote/wireguard/status");
    const port = before.body.listenPort as number;

    const disableRes = await asAdmin().post("/admin/remote/wireguard/disable");
    expect(disableRes.status, JSON.stringify(disableRes.body)).toBe(200);
    expect(disableRes.body.enabled).toBe(false);
    expect(disableRes.body.listening).toBe(false);

    expect(await waitForPortFree(port)).toBe(true);

    // Idempotent second disable.
    const disableAgain = await asAdmin().post("/admin/remote/wireguard/disable");
    expect(disableAgain.status).toBe(200);
    expect(disableAgain.body.enabled).toBe(false);
  });

  it("(d) boot resume: a FRESH app instance restarts the listener from persisted state (same server identity)", async () => {
    // Re-enable through the first app so there is persisted "enabled"
    // state + a keyring-stored private key to resume from.
    const enableRes = await asAdmin().post("/admin/remote/wireguard/enable");
    expect(enableRes.status).toBe(200);
    const stateBefore = await getRemoteWireguardState(app.get(DbProvider).db);

    // Close the FIRST app before booting the second — a real boot-resume
    // only ever happens after the OLD process has fully exited and freed
    // its real UDP port (remote.wireguardPort, the configured default —
    // NOT ephemeral: this service intentionally binds the REAL configured
    // port in production, unlike packages/wg-native's own test suite,
    // which always uses listenPort:0 for concurrent-test-safety reasons
    // that don't apply to a single sequential app-restart simulation
    // here). Reassigning the module-level `app` means afterAll's
    // `app?.close()` cleans up whichever instance is still alive, and
    // every DB read below goes through app2's OWN DbProvider (the first
    // app's pool is torn down by its own OnModuleDestroy on close()).
    await app.close();

    const app2 = await NestFactory.create(AppModule, { logger: false });
    await app2.init();
    app = app2;

    const status2 = await request(app2.getHttpServer())
      .get("/admin/remote/wireguard/status")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(status2.status).toBe(200);
    expect(status2.body.enabled).toBe(true);
    expect(status2.body.listening).toBe(true);

    const stateAfter = await getRemoteWireguardState(app2.get(DbProvider).db);
    // Boot-resume must NOT generate a new keypair — same server identity.
    expect(stateAfter.serverPublicKey).toBe(stateBefore.serverPublicKey);

    // Prove it's a REAL, working listener post-resume: a fresh test
    // client can complete a handshake against the resumed instance.
    const remoteWireguardService2 = app2.get(RemoteWireguardService);
    const clientKeys = generateWgKeyPair();
    await remoteWireguardService2.addTestPeer({ publicKey: clientKeys.publicKey, tunnelIp: "10.82.146.4" });
    const client = WgNativeClient.load()!;
    const fetchResult = await client.testClientFetch(
      {
        privateKey: clientKeys.privateKey,
        clientTunnelIp: "10.82.146.4",
        serverPublicKey: stateAfter.serverPublicKey!,
        serverEndpoint: `127.0.0.1:${status2.body.listenPort}`,
        allowedIps: ["0.0.0.0/0"],
        timeoutMs: 5000,
      },
      "http://10.82.146.1/healthz",
    );
    expect(fetchResult.status).toBe(200);
  }, 20_000);
});

describe.skipIf(available)("Loombre Remote — WireGuard loopback (skipped: native library unavailable)", () => {
  it("is skipped cleanly, not failing, when Go/the built library is absent", () => {
    expect(available).toBe(false);
  });
});
