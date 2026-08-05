// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-wireguard-enrollment.e2e.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card", lane WG2 — R11's exit-gate items that
// genuinely NEED the real native library (a live listener + a real
// handshake, not just the DB-layer enrollment write — see
// remote-wireguard-devices.e2e.spec.ts for the golden-config/DB-rows/
// payload/concurrent-enroll/show-once proofs, none of which need wg-native
// at all since they bypass RemoteWireguardService.enable() via a direct
// @loombre/db write):
//
//   (a) ENROLLMENT-BASED loopback handshake: enroll a device through the
//       REAL HTTP API, parse the private key/address/endpoint OUT of the
//       returned configText (the same text a real WireGuard app would
//       import), and WgTestClientFetch a real endpoint through the tunnel
//       using ONLY what that config text contains — superseding WG1's own
//       addTestPeer test as its "enrollment-based" sibling (that test is
//       KEPT, not replaced — remote-wireguard-loopback.e2e.spec.ts still
//       proves the API-level seam directly).
//   (b) REVOCATION LIVE-REMOVAL: the SAME enrolled peer's fetch succeeds
//       BEFORE revoke and FAILS immediately after — proving
//       RemoteWireguardService.revokeDevice's live WgRemovePeer, not just
//       the DB row deletion.
//
// All wg-gated (test/support/require-wg.ts): graceful skip locally without
// a Go-built native library, LOOMBRE_REQUIRE_WG=1 (CI) escalates to a hard
// failure. Unprivileged ports only (R11) — every listener here is
// ephemeral. Mirrors remote-wireguard-loopback.e2e.spec.ts's own structure
// (self-sufficient ensureTestDatabase suffix, file0600 secret backend
// under a throwaway data dir).

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase, getUserByUsername, readUnprocessedEvents } from "@loombre/db";
import { buildProvisioningConfig } from "@loombre/shared";
import { WgNativeClient } from "@loombre/wg-native";
import { AppModule } from "../src/app.module.js";
import { DbProvider } from "../src/common/db.provider.js";
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

/** Test-only wg-quick parser — production code never needs to parse ITS
 *  OWN generated config back out (packages/shared/src/remote/
 *  provisioning.ts only ever builds this text, never reads it); this
 *  suite needs it to prove the config text a real client would import is
 *  itself sufficient to complete a handshake, using ONLY fields extracted
 *  from that text (not values this file already happens to know from the
 *  enrollment response's other fields). */
function parseWgQuickConfig(text: string): { privateKey: string; address: string; peerPublicKey: string; endpointHost: string; endpointPort: number; allowedIps: string } {
  const line = (key: string): string => {
    const match = text.match(new RegExp(`^${key} = (.+)$`, "m"));
    if (!match) throw new Error(`parseWgQuickConfig: no "${key}" line found in:\n${text}`);
    return match[1]!;
  };
  const address = line("Address").split("/")[0]!;
  const endpoint = line("Endpoint");
  const [endpointHost, endpointPortRaw] = endpoint.split(":");
  return {
    privateKey: line("PrivateKey"),
    address,
    peerPublicKey: line("PublicKey"),
    endpointHost: endpointHost!,
    endpointPort: Number(endpointPortRaw),
    allowedIps: line("AllowedIPs"),
  };
}

let app: INestApplication;
let adminToken: string;
let adminUserId: string;
let dataDir: string;
let databaseUrl: string;
let targetUserId: string;

const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];
const ORIGINAL_ENDPOINT_HOST_ENV = process.env["LOOMBRE_WG_ENDPOINT_HOST"];

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_wireguard_enrollment_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-wireguard-enrollment-test-secret-not-for-production";

  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-remote-wireguard-enrollment-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;
  // remote.wireguardEndpointHost must be configured for enrollment to
  // succeed (422 otherwise, see remote-wireguard.service.ts's
  // enrollDevice) — env-pinned so this suite's own admin never has to PUT
  // /admin/settings first.
  process.env["LOOMBRE_WG_ENDPOINT_HOST"] = "127.0.0.1";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "remote-wireguard-enrollment-test-admin",
    deviceProfile: buildDeviceProfile("remote-wireguard-enrollment-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const adminUser = await getUserByUsername(app.get(DbProvider).db, "admin");
  if (!adminUser) throw new Error("seed did not create the admin user");
  adminUserId = adminUser.id;

  const targetUser = await getUserByUsername(app.get(DbProvider).db, "casual");
  if (!targetUser) throw new Error("seed did not create the casual user");
  targetUserId = targetUser.id;
}, 30_000);

afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
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

describe.skipIf(!available)("Loombre Remote — WireGuard enrollment (real Express app, real Go device+netstack)", () => {
  it("enable, THEN enroll a device — 201 with a complete one-time payload", async () => {
    const enableRes = await asAdmin().post("/admin/remote/wireguard/enable");
    expect(enableRes.status, JSON.stringify(enableRes.body)).toBe(200);

    const enrollRes = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: targetUserId, name: "Casual's phone (enrollment e2e)" });
    expect(enrollRes.status, JSON.stringify(enrollRes.body)).toBe(201);
    expect(enrollRes.body.device.userId).toBe(targetUserId);
    expect(enrollRes.body.device.tunnelIp).toBe("10.82.146.2");
    expect(typeof enrollRes.body.configText).toBe("string");
    expect(enrollRes.body.configText).toContain("[Interface]");
    expect(enrollRes.body.configText).toContain("[Peer]");
    expect(enrollRes.body.configText).toContain(`AllowedIPs = 10.82.146.1/32`);
    expect(enrollRes.body.configText).toContain("PersistentKeepalive = 25");
  });

  it(
    "(a) ENROLLMENT-BASED loopback handshake: parse the returned configText and fetch a REAL endpoint (/healthz) through the tunnel using ONLY what it contains",
    async () => {
      const enrollRes = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: targetUserId, name: "Casual's laptop (handshake e2e)" });
      expect(enrollRes.status, JSON.stringify(enrollRes.body)).toBe(201);
      const parsed = parseWgQuickConfig(enrollRes.body.configText as string);
      expect(parsed.address).toBe(enrollRes.body.device.tunnelIp);
      expect(parsed.allowedIps).toBe("10.82.146.1/32"); // R3 split-tunnel — never 0.0.0.0/0

      const statusRes = await asAdmin().get("/admin/remote/wireguard/status");
      const listenPort = statusRes.body.listenPort as number;

      const client = WgNativeClient.load();
      expect(client, "WgNativeClient.load() must succeed — this suite is wg-gated").toBeDefined();

      const fetchResult = await client!.testClientFetch(
        {
          privateKey: parsed.privateKey,
          clientTunnelIp: parsed.address,
          serverPublicKey: parsed.peerPublicKey,
          // The parsed endpoint HOST is whatever remote.wireguardEndpointHost
          // was configured to (127.0.0.1 here) — the REAL bound port always
          // comes from the live status read (ephemeral in this suite, R11
          // unprivileged-ports), same as the loopback suite's own posture.
          serverEndpoint: `${parsed.endpointHost}:${listenPort}`,
          allowedIps: [parsed.allowedIps],
          timeoutMs: 10_000,
        },
        "http://10.82.146.1/healthz",
      );
      expect(fetchResult.status).toBe(200);
      const body = JSON.parse(fetchResult.bodyPrefix) as { status: string };
      expect(body.status).toBe("ok");

      // This deviceId is reused by the revocation test below.
      (globalThis as Record<string, unknown>)["__wg_enrollment_e2e_device"] = {
        deviceId: enrollRes.body.device.id as string,
        parsed,
      };
    },
    20_000,
  );

  it("(b) REVOCATION LIVE-REMOVAL: the same peer's fetch succeeds before revoke and FAILS immediately after", async () => {
    const { deviceId, parsed } = (globalThis as Record<string, unknown>)["__wg_enrollment_e2e_device"] as {
      deviceId: string;
      parsed: ReturnType<typeof parseWgQuickConfig>;
    };

    const statusRes = await asAdmin().get("/admin/remote/wireguard/status");
    const listenPort = statusRes.body.listenPort as number;
    const client = WgNativeClient.load()!;
    const baseClientConfig = {
      privateKey: parsed.privateKey,
      clientTunnelIp: parsed.address,
      serverPublicKey: parsed.peerPublicKey,
      serverEndpoint: `${parsed.endpointHost}:${listenPort}`,
      allowedIps: [parsed.allowedIps],
    };

    // Sanity: still working before revoke — a generous timeout for a
    // FRESH ephemeral client-side handshake (matches test (a)'s own
    // working budget), unlike the post-revoke check below, which is
    // EXPECTED to fail and should not wait needlessly long to prove it.
    const before = await client.testClientFetch({ ...baseClientConfig, timeoutMs: 10_000 }, "http://10.82.146.1/healthz");
    expect(before.status).toBe(200);

    const revokeRes = await asAdmin().delete(`/admin/remote/wireguard/devices/${deviceId}`);
    expect(revokeRes.status).toBe(204);

    // The exact same peer, same key, same config: now must fail — the
    // live WG peer was removed (handshake fails immediately after, R2/RG3).
    await expect(client.testClientFetch({ ...baseClientConfig, timeoutMs: 2500 }, "http://10.82.146.1/healthz")).rejects.toThrow();

    // DB-level proof too: the device is really gone.
    const listRes = await asAdmin().get("/admin/remote/wireguard/devices");
    expect(listRes.body.items.some((d: { id: string }) => d.id === deviceId)).toBe(false);
  }, 20_000);

  // WG3 mission item 4 (STATE.md "Loombre Remote ...", "REAL-ENDPOINT
  // VERIFICATION of the enrollment ceremony"): walks U2's exact client
  // sequence against the REAL stack — WG enabled via the real native lib
  // (this whole file is wg-gated, LOOMBRE_REQUIRE_WG=1 in CI), asserts the
  // payload parses as a valid wg-quick config matching the frozen
  // provisioning golden shape byte-for-byte, tunnel-IP allocation visible
  // in the GENERAL devices list (GET /devices, R2's own literal wording)
  // with kind='remote', and the config text/private key NEVER appear in
  // any later response — the FULL response-surface sweep WG2's own show-
  // once test (remote-wireguard-devices.e2e.spec.ts) only covered at
  // list/status: this also checks state, posture, the general devices
  // list, and the outbox event.
  it(
    "REAL-ENDPOINT show-once sweep: golden wg-quick config, kind='remote' in GET /devices, configText/privateKey absent from list/status/state/posture/events",
    async () => {
      const enrollRes = await asAdmin().post("/admin/remote/wireguard/devices").send({ userId: adminUserId, name: "Admin's watch (WG3 sweep)" });
      expect(enrollRes.status, JSON.stringify(enrollRes.body)).toBe(201);
      const { device, configText } = enrollRes.body as { device: { id: string; tunnelIp: string }; configText: string };

      // The frozen provisioning golden shape: parse the device's own
      // private key + the server's public key out of the RETURNED text and
      // rebuild independently via the SAME shared builder production code
      // uses — byte-identical output, same discipline as remote-wireguard-
      // devices.e2e.spec.ts's own golden-format test, here against the
      // REAL native-lib enrollment path instead of the bypass-enabled one.
      const parsed = parseWgQuickConfig(configText);
      const privateKey = parsed.privateKey;
      expect(privateKey.length).toBeGreaterThan(0);
      const statusForPort = await asAdmin().get("/admin/remote/wireguard/status");
      const rebuilt = buildProvisioningConfig({
        serverPublicKey: parsed.peerPublicKey,
        serverEndpointHost: "127.0.0.1",
        serverEndpointPort: statusForPort.body.listenPort,
        devicePrivateKey: privateKey,
        deviceTunnelIp: device.tunnelIp,
        serverTunnelIp: "10.82.146.1",
        subnetCidr: "10.82.146.0/24",
      });
      expect(configText).toBe(rebuilt);

      // Tunnel-IP allocation visible in the GENERAL devices list (R2:
      // "enrolled devices appear in the existing devices list (kind:
      // remote)") — self-scoped, so enrolled for the admin's OWN userId
      // above so `asAdmin()` can read it back via GET /devices directly.
      // Cross-referenced against the WG-specific list's own tunnelIp for
      // the SAME device id.
      const generalListRes = await asAdmin().get("/devices");
      expect(generalListRes.status).toBe(200);
      const generalRow = (generalListRes.body.items as Array<{ id: string; kind: string }>).find((d) => d.id === device.id);
      expect(generalRow).toBeDefined();
      expect(generalRow!.kind).toBe("remote");

      const wgListRes = await asAdmin().get("/admin/remote/wireguard/devices");
      const wgRow = (wgListRes.body.items as Array<{ id: string; tunnelIp: string }>).find((d) => d.id === device.id);
      expect(wgRow).toBeDefined();
      expect(wgRow!.tunnelIp).toBe(device.tunnelIp);

      // SHOW-ONCE at the API level — the FULL response-surface sweep: list,
      // status, state, posture, general devices list. WG2 proved this at
      // storage level and for list/status; this proves it across every
      // documented admin read the enrolled device's data could leak into.
      const [stateRes, postureRes] = await Promise.all([asAdmin().get("/admin/remote/state"), asAdmin().get("/admin/remote/posture")]);
      const surfaces: Record<string, unknown> = {
        wireguardDevicesList: wgListRes.body,
        generalDevicesList: generalListRes.body,
        wireguardStatus: statusForPort.body,
        remoteState: stateRes.body,
        remotePosture: postureRes.body,
      };
      for (const [name, body] of Object.entries(surfaces)) {
        const json = JSON.stringify(body);
        expect(json, `${name} leaked the private key`).not.toContain(privateKey);
        expect(json, `${name} leaked the raw config text`).not.toContain(configText);
        expect(json, `${name} leaked a "PrivateKey" field`).not.toMatch(/PrivateKey/);
      }

      // Events: remote.device.enrolled carries ids/names/timestamps ONLY —
      // WG2 proved this shape at the db layer (packages/db/test/
      // wg-peers.spec.ts or equivalent); this asserts it holds at the REAL
      // end-to-end native-lib enrollment path too.
      const events = await readUnprocessedEvents(app.get(DbProvider).db, 5000);
      const enrolledEvent = events.find((e) => e.type === "remote.device.enrolled" && (e.payload as { deviceId?: string }).deviceId === device.id);
      expect(enrolledEvent).toBeDefined();
      const eventJson = JSON.stringify(enrolledEvent!.payload);
      expect(eventJson).not.toContain(privateKey);
      expect(eventJson).not.toContain(configText);
      expect(eventJson).not.toMatch(/PrivateKey/);

      // Cleanup — a real live-peer revoke, so this device doesn't linger
      // into the suite's own "cleanup: disable" test below.
      const revokeRes = await asAdmin().delete(`/admin/remote/wireguard/devices/${device.id}`);
      expect(revokeRes.status).toBe(204);
    },
    20_000,
  );

  it("(F1) disable REVOKES every enrolled device — 'peers gone' per R8 + the exit gate, not a pause that leaves dead rows showing as active", async () => {
    // By now this suite has enrolled several devices. Confirm they exist,
    // then disable and confirm the peer + device rows are actually gone
    // (the pre-fix behavior left them, so they reappeared as "enrolled"
    // after a re-enable while the rotated server key made them dead — V-UX
    // F1). This is the exit gate's literal "disable ... tears down
    // verifiably (... peers gone ...)".
    // Enroll a fresh device here so this test does not depend on which
    // prior tests happened to leave enrollments behind (WG is still enabled
    // from earlier in this suite). The list is cursor-paginated (`items`).
    const enrollRes = await asAdmin()
      .post("/admin/remote/wireguard/devices")
      .send({ userId: targetUserId, name: "Casual's tablet (disable-revokes e2e)" });
    expect(enrollRes.status).toBe(201);

    const beforeList = await asAdmin().get("/admin/remote/wireguard/devices");
    expect(beforeList.status).toBe(200);
    expect(beforeList.body.items.length).toBeGreaterThan(0);

    const disableRes = await asAdmin().post("/admin/remote/wireguard/disable");
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.enabled).toBe(false);

    // The admin list is built by joining wg_peers → devices, so an empty
    // list proves the peer rows are gone (not merely hidden).
    const afterList = await asAdmin().get("/admin/remote/wireguard/devices");
    expect(afterList.status).toBe(200);
    expect(afterList.body.items).toEqual([]);

    // A remote.device.revoked event was emitted for the teardown (audit).
    const events = await readUnprocessedEvents(app.get(DbProvider).db, 5000);
    expect(events.some((e) => e.type === "remote.device.revoked")).toBe(true);
  });
});

describe.skipIf(available)("Loombre Remote — WireGuard enrollment (skipped: native library unavailable)", () => {
  it("is skipped cleanly, not failing, when Go/the built library is absent", () => {
    expect(available).toBe(false);
  });
});
