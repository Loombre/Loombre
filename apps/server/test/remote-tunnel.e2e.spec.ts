// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loombre Remote — Tunnel path (STATE.md R4/R9/RG7, lane T1). Six ops:
 *   POST/DELETE /admin/remote/tunnel/token, POST /admin/remote/tunnel/
 *   {enable,disable}, GET /admin/remote/tunnel/{status,logs}.
 *
 * R11: ALL provider tests run against recorded/local fixtures — never the
 * live Cloudflare API, including here. This suite boots the REAL AppModule
 * (the standing e2e convention — server-power.e2e.spec.ts's own header),
 * so the real DI binding for TunnelProvider is the real
 * CloudflareTunnelProvider; `app.get(TunnelProvider).setTestDeps(...)`
 * redirects its outbound HTTP to a fake fetchImpl for this suite's
 * lifetime (that class's own doc comment — the only seam available once
 * Nest has already resolved a live instance). ConnectorManager/
 * RemoteActivePathReader are the registered no-op defaults, introspected
 * via `app.get(...)` the same way (mirrors server-power.e2e.spec.ts's
 * `power.arm(fakes)` convention).
 *
 * What this suite pins:
 *  - 401 wall unauthenticated; 403 for an authenticated non-admin, on all
 *    six ops.
 *  - Token lifecycle: set validates + stores + never echoes back (the
 *    response AND every subsequent status read); clear removes from the
 *    keyring.
 *  - Scope-insufficient rejection (200 valid:false, NOT stored).
 *  - Provision/deprovision against fixtures, incl. API-error paths: bad
 *    token (401-equivalent invalid), zone not found, tunnel name
 *    collision — and that a DNS-route failure AFTER a successful tunnel
 *    create rolls the tunnel back (best-effort deprovision).
 *  - enable 409s when a DIFFERENT path is active (RemoteActivePathReader
 *    override) and when Tunnel itself is already enabled.
 *  - A full enable -> disable cycle: teardown REALLY calls
 *    removeDnsRoute + deprovisionTunnel (fixture call-log assertions) and
 *    ConnectorManager.stop(), matching R8 "verified teardown".
 *  - Events: remote.enabled/remote.path.changed/remote.disabled all
 *    emitted with the frozen Wave-0 payload shapes (no `path` field on
 *    remote.enabled itself — remote.path.changed's `newPath`/
 *    `previousPath` carries that, see remote-tunnel.service.ts's header)
 *    and NO secrets in any payload (R9).
 */
import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase, readUnprocessedEvents } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { DbProvider } from "../src/common/db.provider.js";
import { TunnelProvider } from "../src/remote/tunnel/tunnel-provider.js";
import { CloudflareTunnelProvider } from "../src/remote/tunnel/cloudflare-tunnel-provider.js";
import { ConnectorManager, NoopConnectorManager } from "../src/remote/tunnel/connector-manager.js";
import { RemoteActivePathReader, NoopRemoteActivePathReader } from "../src/remote/active-path-reader.js";

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
      { codec: "h264", maxProfile: null, maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: 20_000_000 },
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
let cfProvider: CloudflareTunnelProvider;
let connectorManager: NoopConnectorManager;
let activePathReader: NoopRemoteActivePathReader;
let dbProvider: DbProvider;

/** Records every request the fake Cloudflare transport receives, and
 *  answers from a per-path/per-method fixture table — same convention as
 *  cloudflare-tunnel-provider.spec.ts's own fakeFetch, extended with a
 *  shared call log this suite's teardown-verification tests read. */
let cfCallLog: string[] = [];
let cfFixtures: Record<string, { status: number; body: unknown; success?: boolean }> = {};

function cfEnvelope(result: unknown, success = true) {
  return JSON.stringify({ success, errors: success ? [] : [{ code: 1000, message: String(result) }], messages: [], result: success ? result : null });
}

function resetCfFixturesToHappyPath() {
  cfFixtures = {
    "GET /client/v4/user/tokens/verify": { status: 200, body: { id: "tok1", status: "active" } },
    "GET /client/v4/accounts": { status: 200, body: [{ id: "acct-1" }] },
    "GET /client/v4/accounts/acct-1/cfd_tunnel": { status: 200, body: [] },
    "GET /client/v4/zones": { status: 200, body: [{ id: "zone-1" }] },
    "POST /client/v4/accounts/acct-1/cfd_tunnel": { status: 200, body: { id: "tunnel-e2e" } },
    "GET /client/v4/accounts/acct-1/cfd_tunnel/tunnel-e2e/token": { status: 200, body: "opaque-run-token" },
    "PUT /client/v4/accounts/acct-1/cfd_tunnel/tunnel-e2e/configurations": { status: 200, body: {} },
    "POST /client/v4/zones/zone-1/dns_records": { status: 200, body: { id: "record-e2e" } },
    "DELETE /client/v4/zones/zone-1/dns_records/record-e2e": { status: 200, body: {} },
    "DELETE /client/v4/accounts/acct-1/cfd_tunnel/tunnel-e2e": { status: 200, body: {} },
  };
}

const fakeCfFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const key = `${method} ${url.pathname}`;
  cfCallLog.push(key);
  const fixture = cfFixtures[key];
  if (!fixture) throw new Error(`fakeCfFetch: no fixture for ${key}`);
  return new Response(cfEnvelope(fixture.body, fixture.success ?? fixture.status < 300), { status: fixture.status });
}) as unknown as typeof fetch;

async function loginAs(username: string, password: string) {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `remote-tunnel-e2e-${username}-${Date.now()}-${Math.random()}`, deviceProfile: buildDeviceProfile() });
  if (res.status !== 200) throw new Error(`loginAs(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_tunnel_e2e_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "remote-tunnel-e2e-test-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "10000";
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  process.env["LOOMBRE_DATA_DIR"] = process.env["LOOMBRE_DATA_DIR"] ?? "/tmp/loombre-remote-tunnel-e2e-data";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  cfProvider = app.get(TunnelProvider) as CloudflareTunnelProvider;
  connectorManager = app.get(ConnectorManager) as NoopConnectorManager;
  activePathReader = app.get(RemoteActivePathReader) as NoopRemoteActivePathReader;
  dbProvider = app.get(DbProvider);

  cfProvider.setTestDeps({ fetchImpl: fakeCfFetch, dnsLookup: async () => [{ address: "104.16.132.229", family: 4 }] });

  adminToken = await loginAs("admin", "loombre-seed-admin");
  casualToken = await loginAs("casual", "loombre-seed-casual");
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  cfCallLog = [];
  resetCfFixturesToHappyPath();
  activePathReader.activePathOverride = "none";
  // Clear any token/enabled state a prior test left behind — the token
  // via clearRemoteTunnelToken (also proves clear itself works, every
  // test), the enabled row via disableRemoteTunnel's own idempotent path.
  await request(app.getHttpServer()).delete("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`);
  await request(app.getHttpServer()).post("/admin/remote/tunnel/disable").set("Authorization", `Bearer ${adminToken}`);
});

const ROUTES: Array<{ method: "post" | "delete" | "get"; path: string }> = [
  { method: "post", path: "/admin/remote/tunnel/token" },
  { method: "delete", path: "/admin/remote/tunnel/token" },
  { method: "post", path: "/admin/remote/tunnel/enable" },
  { method: "post", path: "/admin/remote/tunnel/disable" },
  { method: "get", path: "/admin/remote/tunnel/status" },
  { method: "get", path: "/admin/remote/tunnel/logs" },
];

describe("auth walls", () => {
  it("unauthenticated -> 401 problem on every op", async () => {
    for (const r of ROUTES) {
      const res = await request(app.getHttpServer())[r.method](r.path);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
    }
  });

  it("authenticated non-admin -> 403 on every op", async () => {
    for (const r of ROUTES) {
      const res = await request(app.getHttpServer())[r.method](r.path).set("Authorization", `Bearer ${casualToken}`);
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  });
});

describe("token lifecycle", () => {
  it("set validates + stores + never echoes back; every subsequent GET carries no token", async () => {
    const setRes = await request(app.getHttpServer())
      .post("/admin/remote/tunnel/token")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ token: "cf-super-secret-token" });

    expect(setRes.status).toBe(200);
    expect(setRes.body).toEqual({ valid: true, detail: null });
    expect(JSON.stringify(setRes.body)).not.toContain("cf-super-secret-token");

    const statusRes = await request(app.getHttpServer()).get("/admin/remote/tunnel/status").set("Authorization", `Bearer ${adminToken}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.tokenConfigured).toBe(true);
    expect(typeof statusRes.body.tokenSetAtMs).toBe("number");
    expect(statusRes.body.tokenScopesOk).toBe(true);
    expect(JSON.stringify(statusRes.body)).not.toContain("cf-super-secret-token");
  });

  it("clear removes from the keyring — status reverts to unconfigured", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "to-clear" });
    const clearRes = await request(app.getHttpServer()).delete("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`);
    expect(clearRes.status).toBe(204);

    const statusRes = await request(app.getHttpServer()).get("/admin/remote/tunnel/status").set("Authorization", `Bearer ${adminToken}`);
    expect(statusRes.body.tokenConfigured).toBe(false);
    expect(statusRes.body.tokenSetAtMs).toBeNull();
    expect(statusRes.body.tokenScopesOk).toBeNull();
  });

  it("a bad/invalid token (401-equivalent) is rejected with a helpful detail and NEVER stored", async () => {
    cfFixtures["GET /client/v4/user/tokens/verify"] = { status: 400, body: "Invalid API Token", success: false };
    const res = await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "bad-token" });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(typeof res.body.detail).toBe("string");

    const statusRes = await request(app.getHttpServer()).get("/admin/remote/tunnel/status").set("Authorization", `Bearer ${adminToken}`);
    expect(statusRes.body.tokenConfigured).toBe(false);
  });

  it("scope-insufficient rejection: helpful detail listing what's missing, and the token is NOT stored", async () => {
    cfFixtures["GET /client/v4/accounts/acct-1/cfd_tunnel"] = { status: 403, body: "Unauthorized to access requested resource", success: false };
    const res = await request(app.getHttpServer())
      .post("/admin/remote/tunnel/token")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ token: "under-scoped-token" });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.detail).toContain("Cloudflare Tunnel: Edit");

    const statusRes = await request(app.getHttpServer()).get("/admin/remote/tunnel/status").set("Authorization", `Bearer ${adminToken}`);
    expect(statusRes.body.tokenConfigured).toBe(false);
  });
});

describe("enableRemoteTunnel — validation and provider-error paths", () => {
  it("422 when the hostname is empty", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    const res = await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "  " });
    expect(res.status).toBe(422);
  });

  it("409 when no token is stored", async () => {
    const res = await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
    expect(res.status).toBe(409);
  });

  it("409 when a DIFFERENT remote-access path is already active (RG15)", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    activePathReader.activePathOverride = "remote";
    const res = await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
    expect(res.status).toBe(409);
  });

  it("422 on tunnel name collision (Cloudflare create returns success:false)", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    cfFixtures["POST /client/v4/accounts/acct-1/cfd_tunnel"] = { status: 409, body: "tunnel with that name already exists", success: false };
    const res = await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain("already exists");
  });

  it("422 when the zone is not found for the hostname, AND the just-created tunnel is rolled back (deprovisioned)", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    cfFixtures["GET /client/v4/zones"] = { status: 200, body: [] };
    const res = await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/no Cloudflare zone was found/);
    // Rollback: the tunnel WAS created before the DNS lookup failed, so a
    // deprovision DELETE for that exact tunnelId must have fired.
    expect(cfCallLog).toContain("DELETE /client/v4/accounts/acct-1/cfd_tunnel/tunnel-e2e");

    const statusRes = await request(app.getHttpServer()).get("/admin/remote/tunnel/status").set("Authorization", `Bearer ${adminToken}`);
    expect(statusRes.body.enabled).toBe(false);
  });
});

describe("full enable -> disable cycle: verified teardown (R8) and event shapes (R9)", () => {
  it("enable provisions + starts the connector + persists state; disable REALLY tears down (DNS + tunnel + connector) and clears state", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });

    const enableRes = await request(app.getHttpServer())
      .post("/admin/remote/tunnel/enable")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ hostname: "media.example.com" });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.enabled).toBe(true);
    expect(enableRes.body.hostname).toBe("media.example.com");

    expect(cfCallLog).toEqual(
      expect.arrayContaining([
        "POST /client/v4/accounts/acct-1/cfd_tunnel",
        "GET /client/v4/accounts/acct-1/cfd_tunnel/tunnel-e2e/token",
        "PUT /client/v4/accounts/acct-1/cfd_tunnel/tunnel-e2e/configurations",
        "GET /client/v4/zones",
        "POST /client/v4/zones/zone-1/dns_records",
      ]),
    );

    const connectorStateAfterEnable = connectorManager.getTestState();
    expect(connectorStateAfterEnable.startCalls).toBe(1);
    expect(connectorStateAfterEnable.startedWith).toEqual({ tunnelId: "tunnel-e2e", hostname: "media.example.com", credential: "opaque-run-token" });

    // A second enable while already enabled is a self-conflict, not
    // silently accepted.
    const secondEnable = await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
    expect(secondEnable.status).toBe(409);

    cfCallLog = [];
    const disableRes = await request(app.getHttpServer()).post("/admin/remote/tunnel/disable").set("Authorization", `Bearer ${adminToken}`);
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.enabled).toBe(false);
    expect(disableRes.body.hostname).toBeNull();

    expect(cfCallLog).toContain("DELETE /client/v4/zones/zone-1/dns_records/record-e2e");
    expect(cfCallLog).toContain("DELETE /client/v4/accounts/acct-1/cfd_tunnel/tunnel-e2e");
    expect(connectorManager.getTestState().stopCalls).toBeGreaterThanOrEqual(1);

    // Idempotent: disabling again is a true no-op, no new Cloudflare calls.
    cfCallLog = [];
    const secondDisable = await request(app.getHttpServer()).post("/admin/remote/tunnel/disable").set("Authorization", `Bearer ${adminToken}`);
    expect(secondDisable.status).toBe(200);
    expect(cfCallLog).toEqual([]);
  });

  it("events: remote.enabled (no path field, frozen Wave-0 shape) + remote.path.changed(newPath=tunnel) on enable; remote.disabled + remote.path.changed(newPath=none) on disable; NO secrets in any payload", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
    await request(app.getHttpServer()).post("/admin/remote/tunnel/disable").set("Authorization", `Bearer ${adminToken}`);

    const events = await readUnprocessedEvents(dbProvider.db, 1000);
    const enabled = events.filter((e) => e.type === "remote.enabled");
    const disabled = events.filter((e) => e.type === "remote.disabled");
    const pathChanges = events.filter((e) => e.type === "remote.path.changed");

    expect(enabled.length).toBeGreaterThanOrEqual(1);
    expect(disabled.length).toBeGreaterThanOrEqual(1);
    for (const e of enabled) expect(Object.keys(e.payload as object)).toEqual(["enabledAtMs"]);
    for (const e of disabled) expect(Object.keys(e.payload as object)).toEqual(["disabledAtMs"]);

    expect(pathChanges.some((e) => (e.payload as { newPath?: string }).newPath === "tunnel" && (e.payload as { previousPath?: string }).previousPath === "none")).toBe(true);
    expect(pathChanges.some((e) => (e.payload as { newPath?: string }).newPath === "none" && (e.payload as { previousPath?: string }).previousPath === "tunnel")).toBe(true);

    for (const e of [...enabled, ...disabled, ...pathChanges]) {
      const json = JSON.stringify(e.payload);
      expect(json).not.toMatch(/good-token|opaque-run-token|token|secret|credential/i);
    }
  });
});

describe("getRemoteTunnelLogs", () => {
  it("delegates to ConnectorManager.logsTail, bounded 1-500 default 200", async () => {
    const res = await request(app.getHttpServer()).get("/admin/remote/tunnel/logs").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lines: [] });
    const calls = connectorManager.getTestState().logsTailCalls;
    expect(calls[calls.length - 1]).toBe(200);

    const clamped = await request(app.getHttpServer()).get("/admin/remote/tunnel/logs?lines=9999").set("Authorization", `Bearer ${adminToken}`);
    expect(clamped.status).toBe(200);
    const clampedCalls = connectorManager.getTestState().logsTailCalls;
    expect(clampedCalls[clampedCalls.length - 1]).toBe(500);
  });
});
