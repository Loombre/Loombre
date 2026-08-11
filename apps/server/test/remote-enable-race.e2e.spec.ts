// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/remote-enable-race.e2e.spec.ts
//
// LD-9 (STATE.md's LD register; closes the Loombre Remote OPEN-ledger
// item V-SEC F2 — "cross-path enable is TOCTOU-racy"). The HTTP-level
// half of the proof; the mechanism itself is
// pinned by packages/db/test/remote-path-enable-serialization.spec.ts, and
// argued in packages/db/src/query/remote-path-guard.ts's design note.
//
// THE INTERLEAVE IS CONTROLLED, NOT HOPED FOR. V-SEC F2's race needs one
// enable to sit BETWEEN its own cross-path pre-check and its final commit
// while a second enable of a DIFFERENT path runs to completion. The Tunnel
// path's multi-second Cloudflare provisioning is exactly that window, so
// this suite makes it a window of arbitrary length: the fake Cloudflare
// transport blocks on a test-held promise at the tunnel-create call
// (`POST /accounts/{id}/cfd_tunnel`), which is the first call AFTER
// enableRemoteTunnel's own pre-checks have all passed. With the tunnel
// enable parked there, a Direct enable is driven to a full 200 over HTTP,
// and only then is the tunnel released to attempt its commit. No sleeps,
// no timing luck — the ordering is a hard synchronization.
//
// Before LD-9 the released tunnel enable committed too: both paths ended up
// enabled and GET /admin/remote/state 500'd on the RG15 invariant
// (deriveActivePath refuses to pick one). After LD-9 the tunnel's commit is
// the guarded one, it loses under the advisory lock, and the flow rolls its
// OWN Cloudflare side effects back before returning the house 409
// (`code: "remote-path-active"`).
//
// Provider/connector fakes follow remote-tunnel.e2e.spec.ts exactly (that
// file's header carries the full rationale): a fixture-table fake fetch on
// the REAL CloudflareTunnelProvider via setTestDeps, and the REAL
// CloudflaredConnectorManager spawning the Node stub script instead of a
// real cloudflared binary. R11 holds — nothing here touches the live
// Cloudflare API.

import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase, getUserByUsername, disableRemoteWireguardAndEmit } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { DbProvider } from "../src/common/db.provider.js";
import { TunnelProvider } from "../src/remote/tunnel/tunnel-provider.js";
import { CloudflareTunnelProvider } from "../src/remote/tunnel/cloudflare-tunnel-provider.js";
import { ConnectorManager } from "../src/remote/tunnel/connector-manager.js";
import type { CloudflaredConnectorManager, SpawnFn } from "../src/remote/tunnel/cloudflared-connector-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";
const STUB_SCRIPT_PATH = path.join(__dirname, "support", "cloudflared-stub.mjs");

const CF_CREATE_TUNNEL = "POST /client/v4/accounts/acct-1/cfd_tunnel";
const CF_DELETE_TUNNEL = "DELETE /client/v4/accounts/acct-1/cfd_tunnel/tunnel-race";
const CF_CREATE_DNS = "POST /client/v4/zones/zone-1/dns_records";
const CF_DELETE_DNS = "DELETE /client/v4/zones/zone-1/dns_records/record-race";

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

function makeStubSpawnFn(): SpawnFn {
  return ((_cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    const env = { ...(opts["env"] as Record<string, string | undefined>), CLOUDFLARED_STUB_MODE: "healthy" };
    return nodeSpawn(process.execPath, [STUB_SCRIPT_PATH, ...args], { ...opts, env }) as ChildProcess;
  }) as unknown as SpawnFn;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

let app: INestApplication;
let adminToken: string;
let adminUserId: string;
let cfProvider: CloudflareTunnelProvider;
let connectorManager: CloudflaredConnectorManager;
let dbProvider: DbProvider;
let dataDir: string;

let cfCallLog: string[] = [];
let cfFixtures: Record<string, { status: number; body: unknown; success?: boolean }> = {};

/** When set, the fake transport parks on `gateHold` the first time it is
 *  asked for this call — the synchronization primitive this suite's whole
 *  argument rests on. */
let gatedCall: string | null = null;
let gateHold: Promise<void> = Promise.resolve();
let releaseGate: () => void = () => {};

function armGate(key: string) {
  gatedCall = key;
  gateHold = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
}

function cfEnvelope(result: unknown, success = true) {
  return JSON.stringify({ success, errors: success ? [] : [{ code: 1000, message: String(result) }], messages: [], result: success ? result : null });
}

function resetCfFixturesToHappyPath() {
  cfFixtures = {
    "GET /client/v4/user/tokens/verify": { status: 200, body: { id: "tok1", status: "active" } },
    "GET /client/v4/accounts": { status: 200, body: [{ id: "acct-1" }] },
    "GET /client/v4/accounts/acct-1/cfd_tunnel": { status: 200, body: [] },
    "GET /client/v4/zones": { status: 200, body: [{ id: "zone-1" }] },
    [CF_CREATE_TUNNEL]: { status: 200, body: { id: "tunnel-race" } },
    "GET /client/v4/accounts/acct-1/cfd_tunnel/tunnel-race/token": { status: 200, body: "opaque-run-token" },
    "PUT /client/v4/accounts/acct-1/cfd_tunnel/tunnel-race/configurations": { status: 200, body: {} },
    [CF_CREATE_DNS]: { status: 200, body: { id: "record-race" } },
    [CF_DELETE_DNS]: { status: 200, body: {} },
    [CF_DELETE_TUNNEL]: { status: 200, body: {} },
  };
}

const fakeCfFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const key = `${method} ${url.pathname}`;
  cfCallLog.push(key);
  if (gatedCall !== null && key === gatedCall) {
    gatedCall = null; // one-shot: the rollback's own calls must not re-park
    await gateHold;
  }
  const fixture = cfFixtures[key];
  if (!fixture) throw new Error(`fakeCfFetch: no fixture for ${key}`);
  return new Response(cfEnvelope(fixture.body, fixture.success ?? fixture.status < 300), { status: fixture.status });
}) as unknown as typeof fetch;

function asAdmin() {
  return {
    post: (url: string) => request(app.getHttpServer()).post(url).set("Authorization", `Bearer ${adminToken}`),
    get: (url: string) => request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${adminToken}`),
    put: (url: string) => request(app.getHttpServer()).put(url).set("Authorization", `Bearer ${adminToken}`),
  };
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_enable_race_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-enable-race-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-remote-enable-race-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;
  process.env["LOOMBRE_CLOUDFLARED_PATH"] = process.execPath;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  cfProvider = app.get(TunnelProvider) as CloudflareTunnelProvider;
  connectorManager = app.get(ConnectorManager) as CloudflaredConnectorManager;
  dbProvider = app.get(DbProvider);

  cfProvider.setTestDeps({ fetchImpl: fakeCfFetch, dnsLookup: async () => [{ address: "104.16.132.229", family: 4 }] });
  connectorManager.setTestDeps({ spawnFn: makeStubSpawnFn(), stopGraceTimeoutMs: 500 });

  const login = await request(app.getHttpServer())
    .post("/auth/login")
    .send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "remote-enable-race-admin",
      deviceProfile: buildDeviceProfile("remote-enable-race-admin"),
    });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  adminToken = login.body.accessToken;
  const admin = await getUserByUsername(dbProvider.db, "admin");
  if (!admin) throw new Error("seed did not create the admin user");
  adminUserId = admin.id;

  // network.trustProxy makes the Direct path's reverse-proxy mode enableable
  // without ACME/pebble — the cheapest real second path to race with.
  const put = await asAdmin().put("/admin/settings/network.trustProxy").send({ value: "1" });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
});

afterAll(async () => {
  await connectorManager.stop();
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  cfCallLog = [];
  resetCfFixturesToHappyPath();
  gatedCall = null;
  releaseGate();
  gateHold = Promise.resolve();

  // Everything off, in the order remote-tunnel.e2e.spec.ts establishes
  // (disable BEFORE clearing the token — a disable of a live tunnel needs a
  // token to verify teardown).
  await asAdmin().post("/admin/remote/tunnel/disable");
  await asAdmin().post("/admin/remote/direct/disable");
  await request(app.getHttpServer()).delete("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`);
  await disableRemoteWireguardAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs: Date.now() });

  await asAdmin().post("/admin/remote/tunnel/token").send({ token: "cf-race-token" });
});

describe("LD-9 — two concurrent enables of DIFFERENT paths cannot both land", () => {
  it("Direct wins while Tunnel is parked mid-provisioning: Tunnel loses with the house 409, rolls its Cloudflare side effects back, and no read ever 500s", async () => {
    armGate(CF_CREATE_TUNNEL);

    // (1) Tunnel enable: past every pre-check, now parked inside Cloudflare
    //     provisioning with NOTHING persisted — exactly V-SEC F2's window.
    const tunnelPromise = asAdmin()
      .post("/admin/remote/tunnel/enable")
      .send({ hostname: "media.example.com" })
      .then((r) => r);
    await waitFor(() => cfCallLog.includes(CF_CREATE_TUNNEL));

    // (2) A DIFFERENT path enables, start to finish, while it waits.
    const directRes = await asAdmin().post("/admin/remote/direct/enable").send({ mode: "reverse-proxy" });
    expect(directRes.status, JSON.stringify(directRes.body)).toBe(200);
    expect(directRes.body.enabled).toBe(true);

    // (3) Release the parked enable into its commit.
    releaseGate();
    const tunnelRes = await tunnelPromise;

    // The loser is refused, in the house conflict shape.
    expect(tunnelRes.status, JSON.stringify(tunnelRes.body)).toBe(409);
    expect(tunnelRes.body.code).toBe("remote-path-active");
    expect(tunnelRes.body.detail).toContain("direct");

    // ...and does not abandon a live tunnel + DNS record on Cloudflare's side.
    expect(cfCallLog).toContain(CF_DELETE_DNS);
    expect(cfCallLog).toContain(CF_DELETE_TUNNEL);

    // The RG15 invariant 500 is unreachable: exactly one path is active and
    // every remote read is clean.
    const state = await asAdmin().get("/admin/remote/state");
    expect(state.status, JSON.stringify(state.body)).toBe(200);
    expect(state.body.activePath).toBe("direct");
    expect(state.body.tunnel.enabled).toBe(false);
    expect(state.body.direct.enabled).toBe(true);

    const tunnelStatus = await asAdmin().get("/admin/remote/tunnel/status");
    expect(tunnelStatus.status).toBe(200);
    expect(tunnelStatus.body.enabled).toBe(false);
  });

  it("recovery is immediate: disabling the winner lets the loser's path enable on the very next call", async () => {
    armGate(CF_CREATE_TUNNEL);
    const tunnelPromise = asAdmin()
      .post("/admin/remote/tunnel/enable")
      .send({ hostname: "media.example.com" })
      .then((r) => r);
    await waitFor(() => cfCallLog.includes(CF_CREATE_TUNNEL));
    expect((await asAdmin().post("/admin/remote/direct/enable").send({ mode: "reverse-proxy" })).status).toBe(200);
    releaseGate();
    expect((await tunnelPromise).status).toBe(409);

    // No lock, no claim, no cooldown stands between the loser and a retry —
    // only the winner's own enabled state, which a normal disable clears.
    expect((await asAdmin().post("/admin/remote/direct/disable")).status).toBe(200);

    const retry = await asAdmin().post("/admin/remote/tunnel/enable").send({ hostname: "media.example.com" });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.enabled).toBe(true);

    const state = await asAdmin().get("/admin/remote/state");
    expect(state.status).toBe(200);
    expect(state.body.activePath).toBe("tunnel");
  });
});

describe("LD-9 §3 — a thrown external side effect mid-enable never wedges the next one", () => {
  // Standing guard rather than a regression: this passes both before and
  // after LD-9, and that is the point — the mechanism must not have
  // introduced the permanent lockout the original deferral feared. The
  // enable holds no lock while it is out at Cloudflare (design note §3b),
  // so there is nothing a throw here can leak.
  it("Cloudflare fails mid-enable: 422, the half-provisioned tunnel is torn down, and the NEXT enable runs to a clean 200", async () => {
    cfFixtures[CF_CREATE_DNS] = { status: 500, body: "cloudflare exploded", success: false };

    const failed = await asAdmin().post("/admin/remote/tunnel/enable").send({ hostname: "media.example.com" });
    expect(failed.status, JSON.stringify(failed.body)).toBe(422);
    expect(cfCallLog).toContain(CF_DELETE_TUNNEL);

    const stillOff = await asAdmin().get("/admin/remote/state");
    expect(stillOff.status).toBe(200);
    expect(stillOff.body.activePath).toBe("none");

    resetCfFixturesToHappyPath();
    const ok = await asAdmin().post("/admin/remote/tunnel/enable").send({ hostname: "media.example.com" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const state = await asAdmin().get("/admin/remote/state");
    expect(state.status).toBe(200);
    expect(state.body.activePath).toBe("tunnel");
  });

  it("a DIFFERENT path can enable straight after a failed enable of another (no cross-path residue)", async () => {
    cfFixtures[CF_CREATE_DNS] = { status: 500, body: "cloudflare exploded", success: false };
    expect((await asAdmin().post("/admin/remote/tunnel/enable").send({ hostname: "media.example.com" })).status).toBe(422);

    const direct = await asAdmin().post("/admin/remote/direct/enable").send({ mode: "reverse-proxy" });
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
    const state = await asAdmin().get("/admin/remote/state");
    expect(state.status).toBe(200);
    expect(state.body.activePath).toBe("direct");
  });
});
