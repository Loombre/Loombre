// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/plugins/admin-library-provider-chain.e2e.spec.ts
//
// Lane W5b's HTTP-level exit proof for GET/PUT
// /admin/libraries/{id}/provider-chain (packages/contract/openapi.yaml) —
// apps/server/src/plugins/admin-library-provider-chain.{controller,service}.ts
// around Lane W3's packages/db/src/query/library-provider-chains.ts. Mirrors
// apps/server/test/plugins/admin-plugins.e2e.spec.ts's conventions (own
// ensureTestDatabase suffix, real NestFactory-booted AppModule, supertest,
// spawning examples/lpp-reference-provider as a real child process, plus a
// tiny in-test stub LPP server for the RESTRICTED-scope registration a
// static reference plugin can't produce).
//
// Covers: chain round-trip (isDefault:true with zero rows -> customized
// after a PUT -> isDefault:true again after clearing), C5 STRICT
// scope-violation 422 BOTH directions (each naming both content classes in
// `detail`), unknown builtin name 422, unknown plugin id 422, malformed
// entry shape 422, 404 for an unknown library on both GET and PUT.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
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

interface SpawnedServer {
  child: ChildProcessByStdio<null, Readable, Readable>;
  baseUrl: string;
  stop: () => Promise<void>;
}

function spawnExamplePlugin(exampleDir: string): Promise<SpawnedServer> {
  const scriptPath = path.join(REPO_ROOT, "examples", exampleDir, "server.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, PORT: "0" },
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

// A tiny in-test stub declaring a RESTRICTED-scope metadata-provider
// capability — no static example plugin in examples/ is restricted-scoped
// (both are general), and this is the only wire fact that matters for the
// C5 STRICT scope-violation tests below.
function startRestrictedStub(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const handler: RequestListener<typeof IncomingMessage, typeof ServerResponse> = (req, res) => {
    if (req.method === "GET" && req.url === "/lpp/manifest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "stub-restricted-provider",
          version: "0.1.0",
          protocolVersion: 1,
          capabilities: [
            {
              type: "metadata-provider",
              mediaKinds: ["movie"],
              contentClass: "restricted",
              endpoints: { search: "/lpp/provider/search", details: "/lpp/provider/details", images: "/lpp/provider/images" },
            },
          ],
          configSchema: { type: "object", properties: {}, additionalProperties: false },
          description: "a throwaway restricted-scope test stub",
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
        close: () => new Promise<void>((resolve2) => server.close(() => resolve2())),
      });
    });
  });
}

let app: INestApplication;
let adminToken: string;
let referenceProvider: SpawnedServer;
let restrictedStub: { baseUrl: string; close: () => Promise<void> };
let generalPluginId: string;
let restrictedPluginId: string;
let generalLibraryId: string;
let restrictedLibraryId: string;

beforeAll(async () => {
  process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
  process.env["LOOMBRE_JWT_SECRET"] = "admin-library-provider-chain-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_library_provider_chain_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-library-provider-chain-test-admin",
    deviceProfile: buildDeviceProfile("admin-library-provider-chain-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  [referenceProvider, restrictedStub] = await Promise.all([spawnExamplePlugin("lpp-reference-provider"), startRestrictedStub()]);

  const generalPreview = await request(app.getHttpServer())
    .post("/admin/plugins/preview")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ url: referenceProvider.baseUrl, lanAllowlist: ["127.0.0.1"] });
  expect(generalPreview.status, JSON.stringify(generalPreview.body)).toBe(200);

  const registerGeneral = await request(app.getHttpServer())
    .post("/admin/plugins")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: {},
      lanAllowlist: ["127.0.0.1"],
      manifestDigest: generalPreview.body.manifestDigest,
    });
  expect(registerGeneral.status, JSON.stringify(registerGeneral.body)).toBe(201);
  generalPluginId = registerGeneral.body.plugin.id;
  expect(registerGeneral.body.plugin.contentClass).toBe("general");

  const restrictedPreview = await request(app.getHttpServer())
    .post("/admin/plugins/preview")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ url: restrictedStub.baseUrl, lanAllowlist: ["127.0.0.1"] });
  expect(restrictedPreview.status, JSON.stringify(restrictedPreview.body)).toBe(200);

  const registerRestricted = await request(app.getHttpServer())
    .post("/admin/plugins")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      url: restrictedStub.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: {},
      lanAllowlist: ["127.0.0.1"],
      manifestDigest: restrictedPreview.body.manifestDigest,
    });
  expect(registerRestricted.status, JSON.stringify(registerRestricted.body)).toBe(201);
  restrictedPluginId = registerRestricted.body.plugin.id;
  expect(registerRestricted.body.plugin.contentClass).toBe("restricted");

  const createGeneralLib = await request(app.getHttpServer())
    .post("/libraries")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "W5b Chain General", mediaKind: "movie", paths: ["/data/w5b-chain-general"] });
  expect(createGeneralLib.status, JSON.stringify(createGeneralLib.body)).toBe(201);
  generalLibraryId = createGeneralLib.body.id;

  const createRestrictedLib = await request(app.getHttpServer())
    .post("/libraries")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "W5b Chain Restricted", mediaKind: "movie", paths: ["/data/w5b-chain-restricted"], contentClass: "restricted" });
  expect(createRestrictedLib.status, JSON.stringify(createRestrictedLib.body)).toBe(201);
  restrictedLibraryId = createRestrictedLib.body.id;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([referenceProvider?.stop(), restrictedStub?.close()]);
});

function asAdmin() {
  const server = () => app.getHttpServer();
  return {
    get: (url: string) => request(server()).get(url).set("Authorization", `Bearer ${adminToken}`),
    put: (url: string, body: unknown) => request(server()).put(url).set("Authorization", `Bearer ${adminToken}`).send(body as Record<string, unknown>),
  };
}

describe("GET /admin/libraries/{id}/provider-chain", () => {
  it("404s for an unknown library", async () => {
    const res = await asAdmin().get("/admin/libraries/11111111-1111-4111-8111-111111111111/provider-chain");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("isDefault:true + the legacy movie default chain for a library with zero rows", async () => {
    const res = await asAdmin().get(`/admin/libraries/${generalLibraryId}/provider-chain`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.libraryId).toBe(generalLibraryId);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.entries).toEqual([{ position: 0, providerKind: "builtin", builtinName: "tmdb", pluginId: null, plugin: null }]);
    // Stash SQLite metadata sync, K7: `stash` joined the known-builtin set
    // (KNOWN_BUILTIN_PROVIDER_NAMES) but is deliberately absent from
    // LEGACY_DEFAULT_PROVIDER_CHAIN — this endpoint's `entries` above stays
    // ["tmdb"]-only for a zero-row general library, unchanged.
    expect(res.body.builtinProviderNames.sort()).toEqual(["musicbrainz", "stash", "tmdb", "tvdb"]);
  });

  it("eligiblePlugins is filtered to the library's OWN contentClass", async () => {
    const generalRes = await asAdmin().get(`/admin/libraries/${generalLibraryId}/provider-chain`);
    expect(generalRes.body.eligiblePlugins.map((p: { id: string }) => p.id)).toContain(generalPluginId);
    expect(generalRes.body.eligiblePlugins.map((p: { id: string }) => p.id)).not.toContain(restrictedPluginId);

    const restrictedRes = await asAdmin().get(`/admin/libraries/${restrictedLibraryId}/provider-chain`);
    expect(restrictedRes.body.eligiblePlugins.map((p: { id: string }) => p.id)).toContain(restrictedPluginId);
    expect(restrictedRes.body.eligiblePlugins.map((p: { id: string }) => p.id)).not.toContain(generalPluginId);
  });
});

describe("PUT /admin/libraries/{id}/provider-chain", () => {
  it("404s for an unknown library, even with a bodyless/empty request", async () => {
    const res = await asAdmin().put("/admin/libraries/11111111-1111-4111-8111-111111111111/provider-chain", {});
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("round-trip: customizes the chain (isDefault flips to false), then clearing with [] reverts to isDefault:true", async () => {
    const put = await asAdmin().put(`/admin/libraries/${generalLibraryId}/provider-chain`, {
      entries: [
        { providerKind: "builtin", builtinName: "tmdb" },
        { providerKind: "plugin", pluginId: generalPluginId },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.isDefault).toBe(false);
    expect(put.body.entries).toHaveLength(2);
    expect(put.body.entries[0]).toMatchObject({ position: 0, providerKind: "builtin", builtinName: "tmdb", pluginId: null });
    expect(put.body.entries[1]).toMatchObject({ position: 1, providerKind: "plugin", pluginId: generalPluginId });
    expect(put.body.entries[1].plugin).toMatchObject({ id: generalPluginId, contentClass: "general" });

    const get = await asAdmin().get(`/admin/libraries/${generalLibraryId}/provider-chain`);
    expect(get.body).toEqual(put.body);

    const cleared = await asAdmin().put(`/admin/libraries/${generalLibraryId}/provider-chain`, { entries: [] });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.isDefault).toBe(true);
    expect(cleared.body.entries).toEqual([{ position: 0, providerKind: "builtin", builtinName: "tmdb", pluginId: null, plugin: null }]);
  });

  it("422s a malformed entry (plugin kind missing pluginId)", async () => {
    const res = await asAdmin().put(`/admin/libraries/${generalLibraryId}/provider-chain`, {
      entries: [{ providerKind: "plugin" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("422s an unknown builtin name", async () => {
    const res = await asAdmin().put(`/admin/libraries/${generalLibraryId}/provider-chain`, {
      entries: [{ providerKind: "builtin", builtinName: "not-a-real-provider" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.detail).toMatch(/unknown built-in provider/);
  });

  it("422s a pluginId that does not resolve to a registered plugin", async () => {
    const res = await asAdmin().put(`/admin/libraries/${generalLibraryId}/provider-chain`, {
      entries: [{ providerKind: "plugin", pluginId: "11111111-1111-4111-8111-111111111111" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.detail).toMatch(/does not exist/);
  });

  describe("C5 STRICT scope violation — 422 BOTH directions, both content classes named in `detail`", () => {
    it("a RESTRICTED-scoped plugin in a GENERAL library's chain", async () => {
      const res = await asAdmin().put(`/admin/libraries/${generalLibraryId}/provider-chain`, {
        entries: [{ providerKind: "plugin", pluginId: restrictedPluginId }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.detail).toMatch(/content_class="restricted"/);
      expect(res.body.detail).toMatch(/content_class="general"/);

      // Rejected wholesale — the library's chain is untouched.
      const get = await asAdmin().get(`/admin/libraries/${generalLibraryId}/provider-chain`);
      expect(get.body.isDefault).toBe(true);
    });

    it("a GENERAL-scoped plugin in a RESTRICTED library's chain (the STRICT direction)", async () => {
      const res = await asAdmin().put(`/admin/libraries/${restrictedLibraryId}/provider-chain`, {
        entries: [{ providerKind: "plugin", pluginId: generalPluginId }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.detail).toMatch(/content_class="general"/);
      expect(res.body.detail).toMatch(/content_class="restricted"/);
    });

    it("accepts a RESTRICTED-scoped plugin in a RESTRICTED library's chain", async () => {
      const res = await asAdmin().put(`/admin/libraries/${restrictedLibraryId}/provider-chain`, {
        entries: [{ providerKind: "plugin", pluginId: restrictedPluginId }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.isDefault).toBe(false);
    });
  });
});
