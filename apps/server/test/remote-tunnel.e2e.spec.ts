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
 * Nest has already resolved a live instance).
 *
 * T2 update (RG7): ConnectorManager is now bound to the REAL
 * CloudflaredConnectorManager (remote.module.ts) — this suite exercises it
 * through a REAL, unprivileged child process, never a mock. `app.get(
 * ConnectorManager).setTestDeps({spawnFn: ...})` redirects the actual OS
 * exec target to `node apps/server/test/support/cloudflared-stub.mjs`
 * instead of a real `cloudflared` binary (cross-platform safe — no
 * shebang/chmod dependency) while everything else (args, env, signal
 * handling) stays production-real; `remote.cloudflaredPath` is pinned to
 * `process.execPath` via LOOMBRE_CLOUDFLARED_PATH so
 * resolveCloudflaredBinary's own real fs check passes too. `stubMode` is
 * mutable per-test (default 'healthy') and threaded through as
 * CLOUDFLARED_STUB_MODE on the spawned child's env.
 *
 * RemoteActivePathReader (WG2, RG15 integration unification): NO LONGER a
 * no-op — this suite now runs against the REAL RemoteActivePathResolverService
 * (apps/server/src/remote/remote-active-path.service.ts), the canonical
 * cross-subsystem resolver. The cross-path 409 test below proves it by
 * writing remote_wireguard_state.enabled=true DIRECTLY via @loombre/db's
 * enableRemoteWireguardAndEmit (bypassing RemoteWireguardService/
 * packages/wg-native entirely — no native library needed for this suite to
 * prove the WIRING, only for WG's own loopback-handshake suite to prove
 * the listener itself), so the resolver's live DB read genuinely observes
 * WireGuard as active.
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
 *  - enable 409s when a DIFFERENT path is active (a REAL
 *    remote_wireguard_state.enabled=true row, the canonical resolver) and
 *    when Tunnel itself is already enabled.
 *  - A full enable -> disable cycle: teardown REALLY calls
 *    removeDnsRoute + deprovisionTunnel (fixture call-log assertions) and
 *    REALLY stops the connector's real child process, matching R8
 *    "verified teardown".
 *  - Events: remote.enabled/remote.path.changed/remote.disabled all
 *    emitted with the frozen Wave-0 payload shapes (no `path` field on
 *    remote.enabled itself — remote.path.changed's `newPath`/
 *    `previousPath` carries that, see remote-tunnel.service.ts's header)
 *    and NO secrets in any payload (R9).
 *  - T2/RG7: enable spawns the REAL stub connector and getRemoteTunnelStatus
 *    surfaces its real health (starting -> running once the stub's
 *    readiness line lands); getRemoteTunnelLogs surfaces its real stdout/
 *    stderr; a crashing stub connector is auto-restarted with backoff and
 *    the status reflects 'degraded'; disable stops the real child process.
 */
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
import { ensureTestDatabase, readUnprocessedEvents, enableRemoteWireguardAndEmit, disableRemoteWireguardAndEmit, getUserByUsername } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { DbProvider } from "../src/common/db.provider.js";
import { TunnelProvider } from "../src/remote/tunnel/tunnel-provider.js";
import { CloudflareTunnelProvider } from "../src/remote/tunnel/cloudflare-tunnel-provider.js";
import { ConnectorManager } from "../src/remote/tunnel/connector-manager.js";
import type { CloudflaredConnectorManager, SpawnFn } from "../src/remote/tunnel/cloudflared-connector-manager.js";
import { RemoteTunnelBootResumerService } from "../src/remote/tunnel/remote-tunnel-boot-resumer.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";
const STUB_SCRIPT_PATH = path.join(__dirname, "support", "cloudflared-stub.mjs");

/** Redirects the REAL spawn target at the Node stub script (see this
 *  file's header) — production args/env/stdio/detached all pass through
 *  unchanged, only the executable itself is swapped, and CLOUDFLARED_STUB_MODE
 *  is layered onto the child's env so the stub knows which behavior to emulate. */
function makeStubSpawnFn(getMode: () => string): SpawnFn {
  return ((_cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    const env = { ...(opts["env"] as Record<string, string | undefined>), CLOUDFLARED_STUB_MODE: getMode() };
    return nodeSpawn(process.execPath, [STUB_SCRIPT_PATH, ...args], { ...opts, env }) as ChildProcess;
  }) as unknown as SpawnFn;
}

/** Polls a condition until true or a timeout — used to wait for the real
 *  stub child process's async stderr output to be observed by the
 *  connector manager (readiness/crash/restart are all genuinely async
 *  against a real OS process here, unlike the fake-child unit spec). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!predicate()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

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
let adminUserId: string;
let casualToken: string;
let cfProvider: CloudflareTunnelProvider;
let connectorManager: CloudflaredConnectorManager;
let dbProvider: DbProvider;
let dataDir: string;
/** Mode the stub connector process boots into for the CURRENT test —
 *  reset to 'healthy' in beforeEach; individual tests override it before
 *  calling enable. */
let stubMode = "healthy";

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
  // A REAL per-run OS temp dir (mkdtempSync), never a hardcoded POSIX
  // "/tmp/..." path — the sibling remote-wireguard-loopback.e2e's exact
  // pattern. On Windows the file0600 backend hardens the tunnel token with an
  // owner-only icacls DACL and FAIL-CLOSES if it can't; a "/tmp/..." path
  // there resolves to a location icacls rejects, 500ing every token-dependent
  // op (9 cascading failures). os.tmpdir() is NTFS + DACL-able on every OS.
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-remote-tunnel-e2e-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;
  // T2/RG7: pins remote.cloudflaredPath to the real `node` executable
  // (guaranteed present + executable on every platform, including
  // Windows CI) — resolveCloudflaredBinary's own real fs check passes,
  // and the stub spawnFn wrapper below redirects the ACTUAL exec target
  // to the Node stub script regardless of this value.
  process.env["LOOMBRE_CLOUDFLARED_PATH"] = process.execPath;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  cfProvider = app.get(TunnelProvider) as CloudflareTunnelProvider;
  connectorManager = app.get(ConnectorManager) as CloudflaredConnectorManager;
  dbProvider = app.get(DbProvider);

  cfProvider.setTestDeps({ fetchImpl: fakeCfFetch, dnsLookup: async () => [{ address: "104.16.132.229", family: 4 }] });
  connectorManager.setTestDeps({ spawnFn: makeStubSpawnFn(() => stubMode), stopGraceTimeoutMs: 500 });

  adminToken = await loginAs("admin", "loombre-seed-admin");
  casualToken = await loginAs("casual", "loombre-seed-casual");
  const admin = await getUserByUsername(dbProvider.db, "admin");
  if (!admin) throw new Error("seed did not create the admin user");
  adminUserId = admin.id;
});

afterAll(async () => {
  // T2: guarantees no real stub connector child process outlives this
  // suite, regardless of which test ran last or whether its own body/
  // beforeEach cleanup already covered it — stop() is idempotent-safe on
  // an already-stopped manager.
  await connectorManager.stop();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  cfCallLog = [];
  resetCfFixturesToHappyPath();
  stubMode = "healthy";
  // Clear any token/enabled state a prior test left behind — disable FIRST
  // (T2: while the prior test's token, if any, is still stored — disable()
  // requires a stored token to verify teardown when currently enabled;
  // clearing it first would make a leftover-enabled state un-disableable,
  // 422ing forever and bleeding a real stub connector process into every
  // later test), THEN clear the token via clearRemoteTunnelToken (also
  // proves clear itself works, every test).
  await request(app.getHttpServer()).post("/admin/remote/tunnel/disable").set("Authorization", `Bearer ${adminToken}`);
  await request(app.getHttpServer()).delete("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`);
  // WireGuard, too (WG2: the cross-path 409 test below flips this DIRECTLY
  // via @loombre/db, bypassing RemoteWireguardService/packages/wg-native —
  // idempotent no-op when already disabled, safe to call unconditionally).
  await disableRemoteWireguardAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs: Date.now() });
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

  it("409 when a DIFFERENT remote-access path is already active (RG15) — a REAL remote_wireguard_state.enabled=true row, read by the canonical resolver", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    await enableRemoteWireguardAndEmit(dbProvider.db, { serverPublicKey: "remote-tunnel-e2e-cross-path-key", actorUserId: adminUserId, nowMs: Date.now() });
    try {
      const res = await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
      expect(res.status).toBe(409);
    } finally {
      await disableRemoteWireguardAndEmit(dbProvider.db, { actorUserId: adminUserId, nowMs: Date.now() });
    }
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

// T2/RG7: positioned HERE deliberately — BEFORE any describe block that
// successfully enables the Tunnel path. This suite shares ONE
// CloudflaredConnectorManager instance (and its log ring buffer) across
// the WHOLE file, same as every real server process would; the ring
// buffer is never cleared by stop() (by design — logsTail is a history,
// not a per-session view), so "empty before the connector has ever run"
// is only a valid assertion while that is still literally true for this
// suite's shared instance. Every describe block ABOVE this one only
// reaches validation/409/422 failures that never call
// connectorManager.start() (checked: empty hostname, no token, wrong
// active path, name collision, zone-not-found+rollback) — none populate
// the ring buffer, so this ordering is correct, not accidental.
describe("getRemoteTunnelLogs — before the connector has ever run", () => {
  it("is empty", async () => {
    const res = await request(app.getHttpServer()).get("/admin/remote/tunnel/logs").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lines: [] });
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

    // T2/RG7: enable() really started the stub connector as a REAL child
    // process — wait for its readiness line to land (async, real stdout/
    // stderr streaming), then confirm getRemoteTunnelStatus surfaces the
    // real health through mapConnectorStateToContract (healthy -> "running").
    await waitFor(() => connectorManager.health().state === "healthy");
    const statusAfterEnable = await request(app.getHttpServer()).get("/admin/remote/tunnel/status").set("Authorization", `Bearer ${adminToken}`);
    expect(statusAfterEnable.body.connectorState).toBe("running");
    expect(statusAfterEnable.body.backoffMs).toBeNull();
    expect(statusAfterEnable.body.lastErrorMessage).toBeNull();

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
    // disable() REALLY stopped the real stub connector process (R8
    // "verified teardown") — disableRemoteTunnel awaits connectorManager.
    // stop() before writing the disabled state, so this is already true by
    // the time the HTTP response above returned; no waitFor needed.
    expect(connectorManager.health().state).toBe("stopped");

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
  it("surfaces the REAL stub connector's stderr, and honors the lines param (1-500, default 200)", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
    await waitFor(() => connectorManager.health().state === "healthy");

    const res = await request(app.getHttpServer()).get("/admin/remote/tunnel/logs").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.lines.length).toBeGreaterThan(0);
    expect(res.body.lines.some((line: string) => line.includes("Registered tunnel connection"))).toBe(true);

    const clamped = await request(app.getHttpServer()).get("/admin/remote/tunnel/logs?lines=1").set("Authorization", `Bearer ${adminToken}`);
    expect(clamped.status).toBe(200);
    expect(clamped.body.lines.length).toBe(1);
  });
});

describe("T2/RG7 — real connector crash -> backoff -> auto-restart, surfaced through the API", () => {
  it("a crashing connector reports 'degraded' with a non-null backoffMs, then auto-recovers to 'running'", async () => {
    stubMode = "crash"; // the stub exits 1 shortly after spawning (CLOUDFLARED_STUB_CRASH_AFTER_MS, default 20ms)
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });

    await waitFor(() => connectorManager.health().state === "backoff");
    const statusDuringBackoff = await request(app.getHttpServer()).get("/admin/remote/tunnel/status").set("Authorization", `Bearer ${adminToken}`);
    expect(statusDuringBackoff.body.connectorState).toBe("degraded");
    expect(typeof statusDuringBackoff.body.backoffMs).toBe("number");
    expect(statusDuringBackoff.body.lastErrorMessage).toContain("exited unexpectedly");

    // Switch the stub to healthy mode for the NEXT restart attempt (full
    // jitter caps this well under a few seconds at restartCount=1) —
    // auto-restart recovers without any admin action.
    stubMode = "healthy";
    await waitFor(() => connectorManager.health().state === "healthy", 10_000);
    const statusAfterRecovery = await request(app.getHttpServer()).get("/admin/remote/tunnel/status").set("Authorization", `Bearer ${adminToken}`);
    expect(statusAfterRecovery.body.connectorState).toBe("running");
    expect(statusAfterRecovery.body.backoffMs).toBeNull();
  });

  // WG3 (STATE.md, R4/RG7 gap closure — T2's own report: "tunnel.connector.
  // state event unwired by anyone"). Same crash -> backoff -> healthy
  // sequence as the test above, this time asserting the ADMIN-ONLY outbox
  // event TunnelConnectorStateEventService now emits on every REAL
  // transition (subscribed via ConnectorManager.onStateChange at boot),
  // in CONTRACT vocabulary (mapConnectorStateToContract — same translation
  // getRemoteTunnelStatus's own connectorState field already uses).
  it("emits tunnel.connector.state through the outbox on EVERY real transition, in order, contract-vocabulary, no secrets", async () => {
    const startMarker = Date.now(); // beforeEach's own disable() already settled the connector to 'stopped' before this
    stubMode = "crash";
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });

    await waitFor(() => connectorManager.health().state === "backoff");
    stubMode = "healthy";
    await waitFor(() => connectorManager.health().state === "healthy", 10_000);

    // TunnelConnectorStateEventService writes the event ASYNCHRONOUSLY off
    // the onStateChange callback (`void this.emit(change)` — deliberately
    // fire-and-forget, per that file's own header: a slow/failing outbox
    // write must never block the connector's own state machine) — so the
    // in-memory health() flip above can observably precede the LAST
    // event's own commit by a beat. Poll for the DB to catch up rather
    // than assuming it already has, same posture as every other real-
    // async wait in this file (waitFor itself).
    let events: Awaited<ReturnType<typeof readUnprocessedEvents>> = [];
    let connectorEvents: Array<{ previousState: string; newState: string; changedAtMs: number }> = [];
    const deadline = Date.now() + 5_000;
    do {
      events = await readUnprocessedEvents(dbProvider.db, 5000);
      connectorEvents = events
        .filter((e) => e.type === "tunnel.connector.state")
        .map((e) => e.payload as { previousState: string; newState: string; changedAtMs: number })
        .filter((p) => p.changedAtMs >= startMarker);
      if (connectorEvents.length >= 4) break;
      await new Promise((r) => setTimeout(r, 20));
    } while (Date.now() < deadline);

    // stopped->starting (enable spawns the child) -> starting->degraded
    // (the stub crashes, backoff scheduled) -> degraded->starting (the
    // scheduled restart attempt) -> starting->running (the stub's
    // readiness line, now in 'healthy' mode).
    expect(connectorEvents.map((e) => `${e.previousState}->${e.newState}`)).toEqual([
      "stopped->starting",
      "starting->degraded",
      "degraded->starting",
      "starting->running",
    ]);
    for (const e of connectorEvents) expect(typeof e.changedAtMs).toBe("number");

    const rawEvents = events.filter((e) => e.type === "tunnel.connector.state" && (e.payload as { changedAtMs: number }).changedAtMs >= startMarker);
    for (const e of rawEvents) {
      expect(e.actor_user_id).toBeNull(); // system-generated — no admin actor (ACTOR_FIELD_MAP maps this type to [])
      // R9: exhaustively three fields, no secrets. Key ORDER not asserted
      // — Postgres JSONB round-tripping doesn't preserve insertion order.
      expect(Object.keys(e.payload as object).sort()).toEqual(["changedAtMs", "newState", "previousState"]);
      expect(JSON.stringify(e.payload)).not.toMatch(/good-token|token|secret|credential/i);
    }
  });
});

describe("T2/RG7 — connector resumes on boot if the tunnel state row says enabled", () => {
  it("a SECOND server boot (simulating a restart) resumes the real stub connector from remote_tunnel_state + the keyring credential", async () => {
    await request(app.getHttpServer()).post("/admin/remote/tunnel/token").set("Authorization", `Bearer ${adminToken}`).send({ token: "good-token" });
    await request(app.getHttpServer()).post("/admin/remote/tunnel/enable").set("Authorization", `Bearer ${adminToken}`).send({ hostname: "media.example.com" });
    await waitFor(() => connectorManager.health().state === "healthy");

    // A SECOND, independent Nest application against the SAME database +
    // secret backend/data dir (LOOMBRE_DATA_DIR/LOOMBRE_SECRET_BACKEND set
    // once in the outer beforeAll, shared by both processes here exactly
    // like a real restart shares the same on-disk state) — simulates a
    // real server restart while the Tunnel path was left enabled. Same
    // dual-boot-within-one-file pattern as remote-probes.e2e.spec.ts's own
    // `lowCapApp`.
    const app2 = await NestFactory.create(AppModule, { logger: false });
    await app2.init();
    const connectorManager2 = app2.get(ConnectorManager) as CloudflaredConnectorManager;
    connectorManager2.setTestDeps({ spawnFn: makeStubSpawnFn(() => stubMode) });
    // A freshly constructed manager, nothing resumed yet.
    expect(connectorManager2.health().state).toBe("stopped");

    try {
      // Test/ops seam (RemoteTunnelBootResumerService's own doc comment):
      // runs the one-shot resume immediately, bypassing the real 60s
      // REMOTE_TUNNEL_BOOT_RESUME_DELAY_MS startup delay.
      await app2.get(RemoteTunnelBootResumerService).resumeOnce();
      await waitFor(() => connectorManager2.health().state === "healthy");
      expect(connectorManager2.health().lastError).toBeNull();
      expect(connectorManager2.health().restartCount).toBe(0);

      // A second resumeOnce() call is a documented no-op (one-shot contract).
      await app2.get(RemoteTunnelBootResumerService).resumeOnce();
      expect(connectorManager2.health().restartCount).toBe(0);
    } finally {
      await connectorManager2.stop();
      await app2.close();
    }
  });

  it("does nothing when the tunnel state row is disabled (the common case — every other server boot)", async () => {
    // beforeEach already disabled + cleared the token — remote_tunnel_state
    // is enabled=false for this test, the default/common state.
    const app2 = await NestFactory.create(AppModule, { logger: false });
    await app2.init();
    const connectorManager2 = app2.get(ConnectorManager) as CloudflaredConnectorManager;
    connectorManager2.setTestDeps({ spawnFn: makeStubSpawnFn(() => stubMode) });

    try {
      await app2.get(RemoteTunnelBootResumerService).resumeOnce();
      // Give any (incorrect) resume attempt a moment to have shown up.
      await new Promise((r) => setTimeout(r, 100));
      expect(connectorManager2.health().state).toBe("stopped");
    } finally {
      await app2.close();
    }
  });
});
