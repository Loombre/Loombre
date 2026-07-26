// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/plugins/admin-plugins.e2e.spec.ts
//
// Lane W5's HTTP-level exit proof for the admin Plugins surface —
// packages/contract/openapi.yaml's "Admin: plugins" section, wired by
// apps/server/src/plugins/admin-plugins.controller.ts around Lane W2's
// services. Mirrors apps/server/test/admin-settings.e2e.spec.ts's
// conventions exactly (own ensureTestDatabase suffix, real NestFactory-
// booted AppModule, supertest against app.getHttpServer(), file0600 keyring
// backend under a throwaway data dir) plus
// apps/server/test/plugins/plugin-registration.e2e.spec.ts's live-plugin
// technique (spawning examples/lpp-reference-provider and
// examples/lpp-discord-notifier as real child processes on ephemeral
// ports, and a tiny in-test stub server for the scope-expansion/refresh/
// reapprove flow a static reference plugin's manifest can't exercise).
//
// Covers: full registration against a real metadata-provider plugin
// (health check runs for real); an event-subscriber plugin's secret config
// field + a proper eventTypeGrants SUBSET; preview of a manifest with an
// unknown capability type -> 422 carrying the C2 message; casual (403) and
// live-demoted-admin (403) rejection; distinctive-value scans proving the
// HMAC secret and a distinctive config secret value appear in NO GET
// response (the secret never round-trips at all — config strips it before
// storage) and the HMAC appears only in the two once-responses
// (register/rotate-hmac); the refresh -> scope-change auto-disable ->
// reapprove flow.

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
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

// ---------------------------------------------------------------------------
// spawn a reference plugin (packages/plugin-protocol/test/integration.spec.ts's
// / apps/server/test/plugins/plugin-registration.e2e.spec.ts's own
// technique, reused verbatim)
// ---------------------------------------------------------------------------

interface SpawnedServer {
  child: ChildProcessByStdio<null, Readable, Readable>;
  baseUrl: string;
  stop: () => Promise<void>;
}

function spawnExamplePlugin(exampleDir: string, extraEnv: Record<string, string> = {}): Promise<SpawnedServer> {
  const scriptPath = path.join(REPO_ROOT, "examples", exampleDir, "server.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, PORT: "0", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let settled = false;
    const stderrChunks: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const match = /LISTENING (\d+)/.exec(stdoutBuffer);
      if (match && !settled) {
        settled = true;
        resolve({
          child,
          baseUrl: `http://127.0.0.1:${match[1]}`,
          stop: () =>
            new Promise<void>((res) => {
              child.once("exit", () => res());
              child.kill();
            }),
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`${exampleDir} exited before listening (code ${code}): ${stderrChunks.join("")}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`${exampleDir} did not print LISTENING within 5000ms: ${stderrChunks.join("")}`));
      }
    }, 5000);
  });
}

// ---------------------------------------------------------------------------
// a tiny mutable stub server — for the refresh/scope-expansion/reapprove
// flow a static reference plugin's fixed manifest can't exercise
// ---------------------------------------------------------------------------

interface StubServer {
  baseUrl: string;
  setMediaKinds: (kinds: string[]) => void;
  close: () => Promise<void>;
}

function startMutableStub(): Promise<StubServer> {
  let mediaKinds = ["movie"];
  const handler: RequestListener<typeof IncomingMessage, typeof ServerResponse> = (req, res) => {
    if (req.method === "GET" && req.url === "/lpp/manifest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "stub-scope-plugin",
          version: "0.1.0",
          protocolVersion: 1,
          capabilities: [
            {
              type: "metadata-provider",
              mediaKinds,
              contentClass: "general",
              endpoints: { search: "/lpp/provider/search", details: "/lpp/provider/details", images: "/lpp/provider/images" },
            },
          ],
          configSchema: { type: "object", properties: {}, additionalProperties: false },
          description: "a throwaway mutable test stub",
          publisher: "Loombre-Test",
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/lpp/provider/search") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "about:blank", title: "Not Found", status: 404 }));
  };
  const server: Server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        setMediaKinds: (kinds) => {
          mediaKinds = kinds;
        },
        close: () => new Promise<void>((resolve2) => server.close(() => resolve2())),
      });
    });
  });
}

function startUnknownCapabilityStub(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const handler: RequestListener<typeof IncomingMessage, typeof ServerResponse> = (req, res) => {
    if (req.method === "GET" && req.url === "/lpp/manifest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "stub-unknown-capability-plugin",
          version: "0.1.0",
          protocolVersion: 1,
          capabilities: [{ type: "subtitle-provider", somethingElse: true }],
          configSchema: { type: "object", properties: {}, additionalProperties: false },
          description: "declares a capability type this Loombre has never heard of",
          publisher: "Loombre-Test",
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "about:blank", title: "Not Found", status: 404 }));
  };
  const server: Server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve2) => server.close(() => resolve2())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// suite setup
// ---------------------------------------------------------------------------

let app: INestApplication;
let adminToken: string;
let casualToken: string;
let dataDir: string;
let referenceProvider: SpawnedServer;
let discordNotifier: SpawnedServer;

const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_plugins_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "admin-plugins-test-secret-not-for-production";

  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-admin-plugins-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-plugins-test-admin",
    deviceProfile: buildDeviceProfile("admin-plugins-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "admin-plugins-test-casual",
    deviceProfile: buildDeviceProfile("admin-plugins-test-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;

  [referenceProvider, discordNotifier] = await Promise.all([
    spawnExamplePlugin("lpp-reference-provider"),
    spawnExamplePlugin("lpp-discord-notifier", { LOOMBRE_LPP_SIGNING_SECRET: "operational-webhook-secret-unrelated-to-registration" }),
  ]);
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([referenceProvider?.stop(), discordNotifier?.stop()]);
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

/** Same shape as admin-settings.e2e.spec.ts's own callerFor. */
function callerFor(token: string) {
  const server = () => app.getHttpServer();
  return {
    get: (url: string) => request(server()).get(url).set("Authorization", `Bearer ${token}`),
    put: (url: string, body?: unknown) => request(server()).put(url).set("Authorization", `Bearer ${token}`).send(body as Record<string, unknown>),
    post: (url: string, body?: unknown) => {
      const req = request(server()).post(url).set("Authorization", `Bearer ${token}`);
      return body === undefined ? req : req.send(body as Record<string, unknown>);
    },
    delete: (url: string) => request(server()).delete(url).set("Authorization", `Bearer ${token}`),
    patch: (url: string, body?: unknown) => request(server()).patch(url).set("Authorization", `Bearer ${token}`).send(body as Record<string, unknown>),
  };
}
function asAdmin() {
  return callerFor(adminToken);
}
function asCasual() {
  return callerFor(casualToken);
}

/** C-2 fix wave: registerPlugin/reapprovePlugin now require a manifestDigest
 *  pinning them to whatever manifest a prior POST /admin/plugins/preview
 *  actually saw. Calls preview against the exact url/lanAllowlist the
 *  register/reapprove call is about to use, right before it (so a MUTABLE
 *  stub's current-at-call-time manifest is what gets hashed — never a
 *  stale/hoisted value). */
async function previewManifestDigest(url: string, lanAllowlist?: string[]): Promise<string> {
  const preview = await asAdmin().post("/admin/plugins/preview", { url, lanAllowlist });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  return preview.body.manifestDigest;
}

// Tracks every plugin id registered by a test, cleaned up afterEach so
// suites don't interfere with each other via base_url's UNIQUE constraint
// or list-length assumptions.
const registeredPluginIds: string[] = [];
afterEach(async () => {
  while (registeredPluginIds.length > 0) {
    const id = registeredPluginIds.pop()!;
    await asAdmin().delete(`/admin/plugins/${id}`);
  }
});

describe("POST /admin/plugins/preview", () => {
  it("403s for a non-admin (casual) token", async () => {
    const res = await asCasual().post("/admin/plugins/preview", { url: referenceProvider.baseUrl });
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("200s with a full capability/config/scope summary, and persists nothing", async () => {
    const res = await asAdmin().post("/admin/plugins/preview", { url: referenceProvider.baseUrl, lanAllowlist: ["127.0.0.1"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.name).toBe("lpp-reference-provider");
    expect(res.body.publisher).toBe("Loombre");
    expect(res.body.capabilities).toHaveLength(1);
    expect(res.body.capabilities[0]).toMatchObject({ type: "metadata-provider", mediaKinds: ["movie", "tv", "music"], contentClass: "general" });
    expect(res.body.configSchema.properties.fixturePrefix).toMatchObject({ type: "string" });
    expect(res.body.requestedEventTypes).toEqual([]);

    const list = await asAdmin().get("/admin/plugins");
    expect(list.body.items).toEqual([]);
  });

  it("SSRF-rejected URL (loopback, no lanAllowlist) -> 422", async () => {
    const res = await asAdmin().post("/admin/plugins/preview", { url: referenceProvider.baseUrl });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("unknown capability type -> 422 carrying the C2 'this Loombre doesn't support ... yet' message", async () => {
    const stub = await startUnknownCapabilityStub();
    try {
      const res = await asAdmin().post("/admin/plugins/preview", { url: stub.baseUrl, lanAllowlist: ["127.0.0.1"] });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.detail).toMatch(/this Loombre doesn't support capability type 'subtitle-provider' yet/);
    } finally {
      await stub.close();
    }
  });
});

describe("POST /admin/plugins — registration (examples/lpp-reference-provider)", () => {
  it("registers, mints an HMAC returned exactly once, and runs a real health check", async () => {
    const manifestDigest = await previewManifestDigest(referenceProvider.baseUrl, ["127.0.0.1"]);
    const res = await asAdmin().post("/admin/plugins", {
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: { fixturePrefix: "W5 Test Fixture" },
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    registeredPluginIds.push(res.body.plugin.id);

    expect(typeof res.body.hmacSecret).toBe("string");
    expect(res.body.hmacSecret.length).toBeGreaterThan(16);
    expect(res.body.plugin.name).toBe("lpp-reference-provider");
    expect(res.body.plugin.enabled).toBe(true);
    expect(res.body.plugin.contentClass).toBe("general");
    expect(res.body.plugin.grantedCapabilityTypes).toEqual(["metadata-provider"]);
    expect(res.body.plugin.config).toEqual({ fixturePrefix: "W5 Test Fixture" });
    expect(res.body.plugin.healthState).toBe("healthy");
    expect(res.body.plugin.eventGrants).toEqual([]);

    const get = await asAdmin().get(`/admin/plugins/${res.body.plugin.id}`);
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    expect(get.body).toEqual(res.body.plugin);
    // The HMAC never round-trips again, anywhere.
    expect(JSON.stringify(get.body)).not.toContain(res.body.hmacSecret);

    const list = await asAdmin().get("/admin/plugins");
    expect(list.body.items.map((p: { id: string }) => p.id)).toContain(res.body.plugin.id);
    expect(JSON.stringify(list.body)).not.toContain(res.body.hmacSecret);
  });

  it("409s re-registering the same baseUrl", async () => {
    const firstDigest = await previewManifestDigest(referenceProvider.baseUrl, ["127.0.0.1"]);
    const first = await asAdmin().post("/admin/plugins", {
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: {},
      lanAllowlist: ["127.0.0.1"],
      manifestDigest: firstDigest,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    registeredPluginIds.push(first.body.plugin.id);

    // No digest needed here — the duplicate-baseUrl 409 fires BEFORE the
    // manifest fetch/digest check (existing-plugin lookup is the first
    // thing registerPlugin does after admin/URL validation).
    const second = await asAdmin().post("/admin/plugins", {
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: {},
      lanAllowlist: ["127.0.0.1"],
    });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });
});

describe("POST /admin/plugins — event-subscriber grants + secret config (examples/lpp-discord-notifier)", () => {
  const DISTINCTIVE_WEBHOOK = "https://distinctive-webhook-value-9f3c2a.example.invalid/hook";

  it("grants a SUBSET of requested eventTypes, and the secret config value never appears in any response", async () => {
    const manifestDigest = await previewManifestDigest(discordNotifier.baseUrl, ["127.0.0.1"]);
    const res = await asAdmin().post("/admin/plugins", {
      url: discordNotifier.baseUrl,
      grantedCapabilityTypes: ["event-subscriber"],
      eventTypeGrants: ["item.added"], // requested set is ["item.added", "playback.started"] — deliberately a strict subset
      config: { webhookUrl: DISTINCTIVE_WEBHOOK },
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const pluginId: string = res.body.plugin.id;
    registeredPluginIds.push(pluginId);

    expect(res.body.plugin.eventGrants.map((g: { eventType: string }) => g.eventType)).toEqual(["item.added"]);
    expect(res.body.plugin.config).toEqual({}); // webhookUrl is secret:true -> never lands in non-secret config
    expect(JSON.stringify(res.body)).not.toContain(DISTINCTIVE_WEBHOOK);

    const get = await asAdmin().get(`/admin/plugins/${pluginId}`);
    expect(JSON.stringify(get.body)).not.toContain(DISTINCTIVE_WEBHOOK);

    const list = await asAdmin().get("/admin/plugins");
    expect(JSON.stringify(list.body)).not.toContain(DISTINCTIVE_WEBHOOK);
  });

  it("PUT event-grants: widening within the requested set succeeds; a type outside it 422s", async () => {
    const manifestDigest = await previewManifestDigest(discordNotifier.baseUrl, ["127.0.0.1"]);
    const registered = await asAdmin().post("/admin/plugins", {
      url: discordNotifier.baseUrl,
      grantedCapabilityTypes: ["event-subscriber"],
      eventTypeGrants: ["item.added"],
      config: { webhookUrl: DISTINCTIVE_WEBHOOK },
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    const pluginId: string = registered.body.plugin.id;
    registeredPluginIds.push(pluginId);

    const widened = await asAdmin().put(`/admin/plugins/${pluginId}/event-grants`, {
      eventTypeGrants: ["item.added", "playback.started"],
    });
    expect(widened.status, JSON.stringify(widened.body)).toBe(200);
    expect(widened.body.eventGrants.map((g: { eventType: string }) => g.eventType).sort()).toEqual(["item.added", "playback.started"]);

    const invalid = await asAdmin().put(`/admin/plugins/${pluginId}/event-grants`, {
      eventTypeGrants: ["item.added", "some.unrequested.type"],
    });
    expect(invalid.status, JSON.stringify(invalid.body)).toBe(422);
  });
});

describe("PUT /admin/plugins/{id}/config", () => {
  it("updates non-secret config values, re-validated against the stored manifest's configSchema", async () => {
    const manifestDigest = await previewManifestDigest(referenceProvider.baseUrl, ["127.0.0.1"]);
    const registered = await asAdmin().post("/admin/plugins", {
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: { fixturePrefix: "Original" },
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
    const pluginId: string = registered.body.plugin.id;
    registeredPluginIds.push(pluginId);

    const updated = await asAdmin().put(`/admin/plugins/${pluginId}/config`, { config: { fixturePrefix: "Updated" } });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.config).toEqual({ fixturePrefix: "Updated" });
  });
});

describe("enable / disable", () => {
  it("disable -> disabledReason 'admin'; re-enable clears it", async () => {
    const manifestDigest = await previewManifestDigest(referenceProvider.baseUrl, ["127.0.0.1"]);
    const registered = await asAdmin().post("/admin/plugins", {
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: {},
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
    const pluginId: string = registered.body.plugin.id;
    registeredPluginIds.push(pluginId);

    const disabled = await asAdmin().post(`/admin/plugins/${pluginId}/disable`);
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body).toMatchObject({ enabled: false, disabledReason: "admin" });

    const enabled = await asAdmin().post(`/admin/plugins/${pluginId}/enable`);
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body).toMatchObject({ enabled: true, disabledReason: null });
  });
});

describe("POST /admin/plugins/{id}/rotate-hmac", () => {
  it("returns a fresh secret, distinct from registration's, exactly once", async () => {
    const manifestDigest = await previewManifestDigest(referenceProvider.baseUrl, ["127.0.0.1"]);
    const registered = await asAdmin().post("/admin/plugins", {
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: {},
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
    const pluginId: string = registered.body.plugin.id;
    const originalSecret: string = registered.body.hmacSecret;
    registeredPluginIds.push(pluginId);

    const rotated = await asAdmin().post(`/admin/plugins/${pluginId}/rotate-hmac`);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(typeof rotated.body.hmacSecret).toBe("string");
    expect(rotated.body.hmacSecret).not.toBe(originalSecret);

    const get = await asAdmin().get(`/admin/plugins/${pluginId}`);
    expect(JSON.stringify(get.body)).not.toContain(originalSecret);
    expect(JSON.stringify(get.body)).not.toContain(rotated.body.hmacSecret);

    const list = await asAdmin().get("/admin/plugins");
    expect(JSON.stringify(list.body)).not.toContain(originalSecret);
    expect(JSON.stringify(list.body)).not.toContain(rotated.body.hmacSecret);
  });
});

describe("DELETE /admin/plugins/{id}", () => {
  it("removes the row; a subsequent GET 404s", async () => {
    const manifestDigest = await previewManifestDigest(referenceProvider.baseUrl, ["127.0.0.1"]);
    const registered = await asAdmin().post("/admin/plugins", {
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: {},
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
    const pluginId: string = registered.body.plugin.id;

    const del = await asAdmin().delete(`/admin/plugins/${pluginId}`);
    expect(del.status).toBe(204);

    const get = await asAdmin().get(`/admin/plugins/${pluginId}`);
    expect(get.status).toBe(404);
  });
});

describe("refresh -> scope-change auto-disable -> reapprove (mutable stub)", () => {
  it("a non-expanding refresh updates the snapshot in place; an expanding one auto-disables until reapproveAdminPlugin", async () => {
    const stub = await startMutableStub();
    try {
      const registerDigest = await previewManifestDigest(stub.baseUrl, ["127.0.0.1"]);
      const registered = await asAdmin().post("/admin/plugins", {
        url: stub.baseUrl,
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypeGrants: [],
        config: {},
        lanAllowlist: ["127.0.0.1"],
        manifestDigest: registerDigest,
      });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const pluginId: string = registered.body.plugin.id;
      registeredPluginIds.push(pluginId);
      expect(registered.body.plugin.grantedCapabilityTypes).toEqual(["metadata-provider"]);

      // Non-expanding refresh: same manifest, nothing changed.
      const refreshedNoChange = await asAdmin().post(`/admin/plugins/${pluginId}/refresh`);
      expect(refreshedNoChange.status, JSON.stringify(refreshedNoChange.body)).toBe(200);
      expect(refreshedNoChange.body.expanded).toBe(false);
      expect(refreshedNoChange.body.plugin.enabled).toBe(true);

      // Expanding refresh: the stub now declares a broader mediaKinds set.
      stub.setMediaKinds(["movie", "tv"]);
      const refreshedExpanded = await asAdmin().post(`/admin/plugins/${pluginId}/refresh`);
      expect(refreshedExpanded.status, JSON.stringify(refreshedExpanded.body)).toBe(200);
      expect(refreshedExpanded.body.expanded).toBe(true);
      expect(refreshedExpanded.body.reasons.length).toBeGreaterThan(0);
      expect(refreshedExpanded.body.plugin.enabled).toBe(false);
      expect(refreshedExpanded.body.plugin.disabledReason).toBe("scope-change");

      // A plain enable is refused while awaiting re-approval.
      const plainEnable = await asAdmin().post(`/admin/plugins/${pluginId}/enable`);
      expect(plainEnable.status, JSON.stringify(plainEnable.body)).toBe(409);

      // mediaKinds was widened above (stub.setMediaKinds) — recompute against
      // the CURRENT stub state, never the register-time digest, or
      // reapprovePlugin's own fresh fetch would 409.
      const reapproveDigest = await previewManifestDigest(stub.baseUrl, ["127.0.0.1"]);
      const reapproved = await asAdmin().post(`/admin/plugins/${pluginId}/reapprove`, {
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypeGrants: [],
        manifestDigest: reapproveDigest,
      });
      expect(reapproved.status, JSON.stringify(reapproved.body)).toBe(200);
      expect(reapproved.body.enabled).toBe(true);
      expect(reapproved.body.disabledReason).toBeNull();
    } finally {
      await stub.close();
    }
  });
});

describe("live-demoted-admin re-verify (A10 pattern)", () => {
  it("succeeds while still admin, then 403s the same (stale-claim) token after demotion", async () => {
    const email = `admin-plugins-demote-${Date.now()}@example.invalid`;
    const create = await asAdmin().post("/users", {
      username: `plugins_demote_${Date.now()}`,
      email,
      password: "demote-me-password",
      isAdmin: true,
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const demotedUserId: string = create.body.id;

    const login = await request(app.getHttpServer()).post("/auth/login").send({
      email,
      password: "demote-me-password",
      deviceName: "admin-plugins-demote-test",
      deviceProfile: buildDeviceProfile("admin-plugins-demote-test"),
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const demoted = callerFor(login.body.accessToken);

    const before = await demoted.get("/admin/plugins");
    expect(before.status, JSON.stringify(before.body)).toBe(200);

    const demote = await asAdmin().patch(`/users/${demotedUserId}`, { isAdmin: false });
    expect(demote.status, JSON.stringify(demote.body)).toBe(200);

    const after = await demoted.get("/admin/plugins");
    expect(after.status).toBe(403);
    expect(after.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });
});
