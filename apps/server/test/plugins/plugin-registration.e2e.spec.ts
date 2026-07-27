// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/plugins/plugin-registration.e2e.spec.ts
//
// Lane W2 exit-proof suite. Exercises the real PluginRegistrationService/
// PluginLifecycleService/PluginHealthService against a real reset+reseeded
// Postgres database (own ensureTestDatabase suffix, per this package's
// established live-DB test convention — see apps/server/src/settings/
// provider-keys.service.spec.ts's header for the exact pattern this file
// follows: `new DbProvider()` directly, no NestJS Testing module, no HTTP
// layer — W5 owns the controllers) and real child-process/local-HTTP-server
// counterparties:
//
//   - happy path: examples/lpp-reference-provider, spawned on an EPHEMERAL
//     port (packages/plugin-protocol/test/integration.spec.ts's own spawn
//     technique, reused verbatim).
//   - malformed manifest / unknown-capability-type / oversized manifest:
//     tiny throwaway node:http stub servers built in-test.
//   - SSRF proof: every stub/reference server in this file binds to
//     127.0.0.1 (the only address a portable test can reliably bind AND
//     that is ALSO one of LD5's explicitly disallowed ranges — loopback).
//     Registering against it WITHOUT lan_allowlist is rejected; WITH
//     lan_allowlist:['127.0.0.1'] it proceeds. The full private-range
//     CLASSIFICATION matrix (10/8, 172.16/12, 192.168/16, link-local, ULA,
//     multicast, broadcast, unspecified, IPv6 equivalents) is already
//     proven exhaustively at the packages/plugin-host unit level
//     (test/ssrf.spec.ts's isDisallowedAddress table) — binding a real test
//     server to an arbitrary 192.168.x address is not portable across dev
//     machines/CI runners, so this file proves the SERVICE-LAYER
//     "registers only via lan_allowlist" behavior against loopback instead
//     of re-deriving the classification matrix a second time.
//   - breaker auto-disable after 5 timeouts: a stub that never responds,
//     driven directly through PluginHealthService.runHealthCheck with a
//     short manifestTimeoutMs override (the production default is 10s;
//     registerPlugin itself is not used for this scenario — see that
//     describe block's own comment for why).

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ensureTestDatabase, getPluginById, getUserByUsername, insertPluginAndEmit, listPlugins } from "@loombre/db";
import { fetchPluginManifest } from "@loombre/plugin-host";
import { DbProvider } from "../../src/common/db.provider.js";
import { PluginHealthService } from "../../src/plugins/plugin-health.service.js";
import { PluginHealthSchedulerService } from "../../src/plugins/plugin-health-scheduler.service.js";
import { PluginLifecycleService } from "../../src/plugins/plugin-lifecycle.service.js";
import { PluginRegistrationService } from "../../src/plugins/plugin-registration.service.js";
import { computeManifestDigest } from "../../src/plugins/manifest-digest.js";

// C-2 fix wave: registerPlugin/reapprovePlugin now require a manifestDigest
// pinning them to whatever manifest a prior POST /admin/plugins/preview
// (mirrored here by directly fetching+hashing) actually saw. Computed FRESH
// at each call site — some tests below use a MUTABLE stub server whose
// manifest content changes mid-test, so this must never be hoisted/cached
// across a manifest mutation.
async function digestFor(baseUrl: string, lanAllowlist: string[] = []): Promise<string> {
  const result = await fetchPluginManifest(baseUrl, { lanAllowlist });
  if (!result.ok) throw new Error(`test helper: could not fetch manifest at ${baseUrl} to compute its digest`);
  return computeManifestDigest(result.manifest);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = join(__dirname, "../../../../packages/db");
const REPO_ROOT = join(__dirname, "../../../..");
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

// ---------------------------------------------------------------------------
// spawn the reference provider (packages/plugin-protocol/test/integration.spec.ts's
// own technique, reused verbatim)
// ---------------------------------------------------------------------------

interface SpawnedServer {
  child: ChildProcessByStdio<null, Readable, Readable>;
  baseUrl: string;
  stop: () => Promise<void>;
}

function spawnReferenceProvider(): Promise<SpawnedServer> {
  const scriptPath = join(REPO_ROOT, "examples", "lpp-reference-provider", "server.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: dirname(scriptPath),
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
          stop: () => new Promise<void>((res) => { child.once("exit", () => res()); child.kill(); }),
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    child.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
    child.on("exit", (code) => {
      if (!settled) { settled = true; reject(new Error(`reference provider exited before listening (code ${code}): ${stderrChunks.join("")}`)); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error(`reference provider did not print LISTENING within 5000ms: ${stderrChunks.join("")}`)); }
    }, 5000);
  });
}

// ---------------------------------------------------------------------------
// tiny throwaway stub servers
// ---------------------------------------------------------------------------

interface StubServer {
  baseUrl: string;
  host: string;
  close: () => Promise<void>;
}

async function startStub(handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>): Promise<StubServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const VALID_MANIFEST_BASE = {
  name: "stub-plugin",
  version: "0.1.0",
  protocolVersion: 1,
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  description: "a throwaway test stub",
  publisher: "Loombre-Test",
};

const METADATA_CAP = {
  type: "metadata-provider",
  mediaKinds: ["movie"],
  contentClass: "general",
  endpoints: { search: "/lpp/provider/search", details: "/lpp/provider/details", images: "/lpp/provider/images" },
};

// ---------------------------------------------------------------------------
// suite setup
// ---------------------------------------------------------------------------

let dbProvider: DbProvider;
let healthService: PluginHealthService;
let registrationService: PluginRegistrationService;
let lifecycleService: PluginLifecycleService;
let adminId: string;
let casualId: string;
let dataDir: string;

const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "plugin_registration_test");
  run(join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  // file0600 (deterministic, side-effect-free) — same established
  // convention as provider-keys.service.spec.ts.
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(join(tmpdir(), "loombre-plugin-registration-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;

  dbProvider = new DbProvider();
  healthService = new PluginHealthService(dbProvider);
  registrationService = new PluginRegistrationService(dbProvider, healthService);
  lifecycleService = new PluginLifecycleService(dbProvider, healthService);

  const admin = await getUserByUsername(dbProvider.db, "admin");
  const casual = await getUserByUsername(dbProvider.db, "casual");
  if (!admin || !casual) throw new Error("seed did not create both users");
  adminId = admin.id;
  casualId = casual.id;
}, 30_000);

afterAll(async () => {
  await dbProvider.onModuleDestroy();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

// ===========================================================================
// happy path (examples/lpp-reference-provider) + SSRF guard at the service layer
// ===========================================================================

describe("registerPlugin — happy path (examples/lpp-reference-provider)", () => {
  let provider: SpawnedServer;

  beforeAll(async () => {
    provider = await spawnReferenceProvider();
  }, 10_000);

  afterAll(async () => {
    await provider.stop();
  });

  it("SSRF guard: rejects the loopback baseUrl WITHOUT lan_allowlist (422)", async () => {
    await expect(
      registrationService.registerPlugin({
        baseUrl: provider.baseUrl,
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a non-admin actor (403), never even reaching the network", async () => {
    await expect(
      registrationService.registerPlugin({
        baseUrl: provider.baseUrl,
        lanAllowlist: ["127.0.0.1"],
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: casualId,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("registers with lan_allowlist:['127.0.0.1'], mints the HMAC once, commits enabled, and health becomes healthy", async () => {
    const beforeMs = Date.now();
    const manifestDigest = await digestFor(provider.baseUrl, ["127.0.0.1"]);
    const result = await registrationService.registerPlugin({
      baseUrl: provider.baseUrl,
      lanAllowlist: ["127.0.0.1"],
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      configValues: { fixturePrefix: "E2E Test" },
      actorUserId: adminId,
      manifestDigest,
    });

    expect(result.plugin.name).toBe("lpp-reference-provider");
    expect(result.plugin.base_url).toBe(provider.baseUrl);
    expect(result.plugin.enabled).toBe(true);
    expect(result.plugin.content_class).toBe("general");
    expect(result.plugin.granted_capability_types).toEqual(["metadata-provider"]);
    expect(result.plugin.approved_at_ms).toBeGreaterThanOrEqual(beforeMs);
    // LD1: the HMAC is a 256-bit value, hex-encoded (generateLppSigningSecret).
    expect(result.hmacSecret).toMatch(/^[0-9a-f]{64}$/);
    // LD7: the reference provider's canary search succeeds -> healthy.
    expect(result.plugin.health_state).toBe("healthy");
    expect(result.plugin.consecutive_failures).toBe(0);

    const fetched = await getPluginById(dbProvider.db, result.plugin.id);
    expect(fetched?.id).toBe(result.plugin.id);
  });

  it("rejects a duplicate registration at the same baseUrl (409 conflict)", async () => {
    await expect(
      registrationService.registerPlugin({
        baseUrl: provider.baseUrl,
        lanAllowlist: ["127.0.0.1"],
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ===========================================================================
// manifest failure modes — tiny throwaway stub servers
// ===========================================================================

describe("registerPlugin — manifest failure modes (throwaway stubs)", () => {
  const stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("unknown-capability-type: rejected with a message naming the unsupported type (C2), never silently ignored", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        return jsonResponse(res, 200, { ...VALID_MANIFEST_BASE, capabilities: [{ type: "future-capability", foo: "bar" }] });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    await expect(
      registrationService.registerPlugin({
        baseUrl: stub.baseUrl,
        lanAllowlist: [stub.host],
        grantedCapabilityTypes: ["future-capability"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
      }),
    ).rejects.toMatchObject({ status: 422, response: expect.objectContaining({ detail: expect.stringContaining("future-capability") }) });
  });

  it("malformed manifest (invalid JSON body): rejected as a validation failure, never crashes", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{ this is not valid json");
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    await expect(
      registrationService.registerPlugin({
        baseUrl: stub.baseUrl,
        lanAllowlist: [stub.host],
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("oversized manifest (> 256 KiB): rejected via the size cap, connection aborted rather than buffered", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        const oversized = { ...VALID_MANIFEST_BASE, capabilities: [METADATA_CAP], description: "x".repeat(300 * 1024) };
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(oversized));
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    await expect(
      registrationService.registerPlugin({
        baseUrl: stub.baseUrl,
        lanAllowlist: [stub.host],
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("a manifest requesting an eventType outside the published outbox taxonomy is rejected", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        return jsonResponse(res, 200, {
          ...VALID_MANIFEST_BASE,
          capabilities: [
            { type: "event-subscriber", eventTypes: ["not.a.real.event.type"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" },
          ],
        });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const manifestDigest = await digestFor(stub.baseUrl, [stub.host]);
    await expect(
      registrationService.registerPlugin({
        baseUrl: stub.baseUrl,
        lanAllowlist: [stub.host],
        grantedCapabilityTypes: ["event-subscriber"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
        manifestDigest,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  // H-4 fix wave: an ADMIN_ONLY event type (job.updated here — settings.updated
  // and the six plugin.* types are the other seven) requested by a manifest
  // is rejected exactly like an unpublished type — never grantable, per
  // the same "does not publish" 422 path M-8's sibling test above proves
  // for a made-up type name.
  it("H-4: a manifest requesting an ADMIN_ONLY event type (job.updated) is rejected — never grantable in v1", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        return jsonResponse(res, 200, {
          ...VALID_MANIFEST_BASE,
          capabilities: [{ type: "event-subscriber", eventTypes: ["job.updated"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" }],
        });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const manifestDigest = await digestFor(stub.baseUrl, [stub.host]);
    await expect(
      registrationService.registerPlugin({
        baseUrl: stub.baseUrl,
        lanAllowlist: [stub.host],
        grantedCapabilityTypes: ["event-subscriber"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
        manifestDigest,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("grantedCapabilityTypes wider than declared is rejected (capability set <= declared, LD6)", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        return jsonResponse(res, 200, { ...VALID_MANIFEST_BASE, capabilities: [METADATA_CAP] });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const manifestDigest = await digestFor(stub.baseUrl, [stub.host]);
    await expect(
      registrationService.registerPlugin({
        baseUrl: stub.baseUrl,
        lanAllowlist: [stub.host],
        grantedCapabilityTypes: ["metadata-provider", "event-subscriber"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
        manifestDigest,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ===========================================================================
// concurrent registration at the same baseUrl
// ===========================================================================

describe("registerPlugin — the losing side of a concurrent same-baseUrl registration", () => {
  const stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  // The pre-check and the insert are in different transactions with a
  // manifest fetch between them. Rather than race two real register() calls
  // (inherently flaky), the stub commits the COMPETING row from inside the
  // manifest request registerPlugin itself makes — i.e. exactly inside the
  // window — so the loser deterministically reaches the insert and fails on
  // plugins_base_url_unique. It must still surface the same 409 the
  // sequential duplicate produces, not an unmapped 500.
  it("still surfaces the same 409 when the row lands after its pre-check passed", async () => {
    let manifestFetches = 0;
    const stub = await startStub(async (req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        manifestFetches += 1;
        // Fetch 1 is digestFor's; fetch 2 is registerPlugin's own, which is
        // the one that has to happen after the pre-check.
        if (manifestFetches === 2) {
          await insertPluginAndEmit(dbProvider.db, {
            id: "018f6f1e-0000-7000-8000-0000000000e1",
            name: "race-winner-plugin",
            baseUrl: stub.baseUrl,
            version: "0.1.0",
            protocolVersion: 1,
            contentClass: "general",
            grantedCapabilityTypes: ["metadata-provider"],
            eventTypes: [],
            lanAllowlist: [stub.host],
            manifest: { ...VALID_MANIFEST_BASE, capabilities: [METADATA_CAP] },
            config: {},
            actorUserId: adminId,
            nowMs: Date.now(),
          });
        }
        return jsonResponse(res, 200, { ...VALID_MANIFEST_BASE, capabilities: [METADATA_CAP] });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const manifestDigest = await digestFor(stub.baseUrl, [stub.host]);
    await expect(
      registrationService.registerPlugin({
        baseUrl: stub.baseUrl,
        lanAllowlist: [stub.host],
        grantedCapabilityTypes: ["metadata-provider"],
        eventTypeGrants: [],
        configValues: {},
        actorUserId: adminId,
        manifestDigest,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ detail: expect.stringContaining("already registered") }),
    });

    // The winner's row is the only one, and the loser left nothing behind.
    const rows = await listPlugins(dbProvider.db);
    expect(rows.filter((r) => r.base_url === stub.baseUrl).map((r) => r.id)).toEqual([
      "018f6f1e-0000-7000-8000-0000000000e1",
    ]);
  }, 20_000);
});

// ===========================================================================
// LD9 distinctive-value scans
// ===========================================================================

describe("LD9: secrets never appear in the plugins row, manifest snapshot, or emitted events", () => {
  const stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("a distinctive secret config value is absent from every plugins column and every plugin.* event payload", async () => {
    const DISTINCTIVE_SECRET = `DISTINCTIVE-SECRET-${Date.now()}`;
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        return jsonResponse(res, 200, {
          ...VALID_MANIFEST_BASE,
          capabilities: [METADATA_CAP],
          configSchema: {
            type: "object",
            properties: { apiKey: { type: "string", description: "secret", secret: true } },
            required: ["apiKey"],
            additionalProperties: false,
          },
        });
      }
      if (req.method === "POST" && req.url === "/lpp/provider/search") {
        return jsonResponse(res, 200, { results: [] });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const manifestDigest = await digestFor(stub.baseUrl, [stub.host]);
    const result = await registrationService.registerPlugin({
      baseUrl: stub.baseUrl,
      lanAllowlist: [stub.host],
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      configValues: { apiKey: DISTINCTIVE_SECRET },
      actorUserId: adminId,
      manifestDigest,
    });

    // Never in the row (any column, including the manifest/config JSONB).
    expect(JSON.stringify(result.plugin)).not.toContain(DISTINCTIVE_SECRET);
    expect(JSON.stringify(result.plugin)).not.toContain(result.hmacSecret);
    const fetched = await getPluginById(dbProvider.db, result.plugin.id);
    expect(JSON.stringify(fetched)).not.toContain(DISTINCTIVE_SECRET);
    expect(JSON.stringify(fetched)).not.toContain(result.hmacSecret);

    // Never in the events table for this plugin.
    const events = await dbProvider.db
      .selectFrom("events")
      .selectAll()
      .where("type", "like", "plugin.%")
      .execute();
    const eventsJson = JSON.stringify(events);
    expect(eventsJson).not.toContain(DISTINCTIVE_SECRET);
    expect(eventsJson).not.toContain(result.hmacSecret);
    // Sanity: the pluginId itself SHOULD appear (proves this isn't a
    // vacuously-true "the events table is just empty" assertion).
    expect(eventsJson).toContain(result.plugin.id);
  });
});

// ===========================================================================
// scope-expansion -> auto-disable -> re-approve (LD6)
// ===========================================================================

describe("refreshPlugin / reapprovePlugin — scope-expansion auto-disable (LD6)", () => {
  const stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("a broadened mediaKinds on re-fetch auto-disables (reason='scope-change'); reapprovePlugin re-enables with the new grant", async () => {
    let mediaKinds = ["movie"];
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        return jsonResponse(res, 200, {
          ...VALID_MANIFEST_BASE,
          capabilities: [{ ...METADATA_CAP, mediaKinds }],
        });
      }
      if (req.method === "POST" && req.url === "/lpp/provider/search") {
        return jsonResponse(res, 200, { results: [] });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const registerDigest = await digestFor(stub.baseUrl, [stub.host]);
    const registered = await registrationService.registerPlugin({
      baseUrl: stub.baseUrl,
      lanAllowlist: [stub.host],
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      configValues: {},
      actorUserId: adminId,
      manifestDigest: registerDigest,
    });
    expect(registered.plugin.enabled).toBe(true);

    // Widen the live manifest — an expansion (LD6).
    mediaKinds = ["movie", "tv"];

    const refreshed = await registrationService.refreshPlugin(registered.plugin.id, adminId);
    expect(refreshed.expanded).toBe(true);
    expect(refreshed.reasons.some((r) => r.includes("mediaKinds broadened"))).toBe(true);
    expect(refreshed.plugin.enabled).toBe(false);
    expect(refreshed.plugin.disabled_reason).toBe("scope-change");

    // A plain re-enable is refused while awaiting re-approval.
    await expect(lifecycleService.setEnabled(registered.plugin.id, true, adminId)).rejects.toMatchObject({ status: 409 });

    // Manifest was widened above (mediaKinds = ["movie", "tv"]) — the digest
    // must be recomputed against the CURRENT stub state, never the
    // register-time one, or reapprovePlugin's own fresh fetch would 409.
    const reapproveDigest = await digestFor(stub.baseUrl, [stub.host]);
    const reapproved = await registrationService.reapprovePlugin(
      registered.plugin.id,
      { grantedCapabilityTypes: ["metadata-provider"], eventTypeGrants: [], manifestDigest: reapproveDigest },
      adminId,
    );
    expect(reapproved.enabled).toBe(true);
    expect(reapproved.disabled_reason).toBeNull();
  }, 15_000);

  it("a narrower diff (capability removed entirely) does NOT disable — grants shrink automatically", async () => {
    let includeEventSubscriber = true;
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        const capabilities = includeEventSubscriber
          ? [METADATA_CAP, { type: "event-subscriber", eventTypes: ["item.added"], delivery: { endpoint: "/lpp/events" }, contentClass: "general" }]
          : [METADATA_CAP];
        return jsonResponse(res, 200, { ...VALID_MANIFEST_BASE, capabilities });
      }
      if (req.method === "POST" && req.url === "/lpp/provider/search") {
        return jsonResponse(res, 200, { results: [] });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const manifestDigest = await digestFor(stub.baseUrl, [stub.host]);
    const registered = await registrationService.registerPlugin({
      baseUrl: stub.baseUrl,
      lanAllowlist: [stub.host],
      grantedCapabilityTypes: ["metadata-provider", "event-subscriber"],
      eventTypeGrants: ["item.added"],
      configValues: {},
      actorUserId: adminId,
      manifestDigest,
    });
    expect(registered.plugin.granted_capability_types.sort()).toEqual(["event-subscriber", "metadata-provider"]);

    includeEventSubscriber = false;
    const refreshed = await registrationService.refreshPlugin(registered.plugin.id, adminId);
    expect(refreshed.expanded).toBe(false);
    expect(refreshed.plugin.enabled).toBe(true);
    expect(refreshed.plugin.granted_capability_types).toEqual(["metadata-provider"]);
  }, 15_000);
});

// ===========================================================================
// breaker auto-disable after 5 consecutive timeouts (LD8)
// ===========================================================================

describe("PluginHealthService — breaker auto-disable after 5 consecutive timeouts (LD8)", () => {
  // registerPlugin is NOT used here: it performs its own manifest fetch
  // PLUS an immediate post-registration health check (a second manifest
  // fetch), and neither call site accepts a short timeout override —
  // against a server that never responds AT ALL, that would mean waiting
  // out the real 10s production default twice just to get a row into a
  // state this test can drive further. Instead the row is inserted
  // directly (mirroring the registration service's own DB call exactly)
  // and PluginHealthService.runHealthCheck is driven directly with a short
  // manifestTimeoutMs — this is still the REAL health/breaker code path
  // (packages/plugin-host's callPlugin/PluginCircuitBreaker), only the
  // REGISTRATION half of the mission's "breaker auto-disable after 5
  // timeouts" scenario is bypassed as pure test-speed plumbing.
  const stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("5 consecutive timed-out health checks trip the breaker and auto-disable (reason='breaker')", async () => {
    const stub = await startStub(() => {
      // Never respond — every request just hangs.
    });
    stubs.push(stub);

    const nowMs = Date.now();
    const { plugin } = await insertPluginAndEmit(dbProvider.db, {
      id: "018f6f1e-0000-7000-8000-0000000000d1",
      name: "hung-stub-plugin",
      baseUrl: stub.baseUrl,
      version: "0.1.0",
      protocolVersion: 1,
      contentClass: "general",
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypes: [],
      lanAllowlist: [stub.host],
      manifest: { ...VALID_MANIFEST_BASE, capabilities: [METADATA_CAP] },
      config: {},
      actorUserId: adminId,
      nowMs,
    });
    expect(plugin.enabled).toBe(true);

    let lastRow = plugin;
    for (let i = 0; i < 5; i++) {
      lastRow = await healthService.runHealthCheck(plugin.id, nowMs + i, { manifestTimeoutMs: 150 });
    }

    expect(lastRow.enabled).toBe(false);
    expect(lastRow.disabled_reason).toBe("breaker");
    expect(lastRow.health_state).toBe("unhealthy");
    expect(lastRow.consecutive_failures).toBe(5);
    expect(healthService.getBreaker(plugin.id).snapshot().state).toBe("open");

    // Manual re-enable resets the breaker/failure count (LD8) — but this
    // plugin was disabled for 'breaker', which setEnabled DOES allow
    // re-enabling from (unlike 'scope-change').
    const reenabled = await lifecycleService.setEnabled(plugin.id, true, adminId);
    expect(reenabled.enabled).toBe(true);
    expect(healthService.getBreaker(plugin.id).snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  }, 20_000);
});

// ===========================================================================
// M-8 fix wave: PluginHealthSchedulerService — periodic health re-check
// ===========================================================================

describe("PluginHealthSchedulerService (M-8 fix wave: periodic health re-check)", () => {
  const stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("runSweep() checks every ENABLED plugin and skips DISABLED ones", async () => {
    const healthyStub = await startStub((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/lpp/manifest") {
        return jsonResponse(res, 200, { ...VALID_MANIFEST_BASE, name: "scheduler-healthy", capabilities: [METADATA_CAP] });
      }
      if (req.method === "POST" && url.pathname === "/lpp/provider/search") {
        return jsonResponse(res, 200, { results: [] });
      }
      return jsonResponse(res, 404, { type: "about:blank", title: "Not Found", status: 404 });
    });
    stubs.push(healthyStub);

    let disabledStubHits = 0;
    const disabledStub = await startStub((_req, res) => {
      disabledStubHits += 1;
      jsonResponse(res, 200, { ...VALID_MANIFEST_BASE, name: "scheduler-disabled", capabilities: [METADATA_CAP] });
    });
    stubs.push(disabledStub);

    const nowMs = Date.now();
    const { plugin: enabledPlugin } = await insertPluginAndEmit(dbProvider.db, {
      id: "018f6f1e-0000-7000-8000-0000000005c1",
      name: "scheduler-healthy",
      baseUrl: healthyStub.baseUrl,
      version: "0.1.0",
      protocolVersion: 1,
      contentClass: "general",
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypes: [],
      lanAllowlist: [healthyStub.host],
      manifest: { ...VALID_MANIFEST_BASE, name: "scheduler-healthy", capabilities: [METADATA_CAP] },
      config: {},
      actorUserId: adminId,
      nowMs,
    });
    expect(enabledPlugin.enabled).toBe(true);
    expect(enabledPlugin.last_health_check_ms).toBeNull(); // never checked yet — proves the sweep, not registration, is what checks it below

    const { plugin: disabledPluginRow } = await insertPluginAndEmit(dbProvider.db, {
      id: "018f6f1e-0000-7000-8000-0000000005c2",
      name: "scheduler-disabled",
      baseUrl: disabledStub.baseUrl,
      version: "0.1.0",
      protocolVersion: 1,
      contentClass: "general",
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypes: [],
      lanAllowlist: [disabledStub.host],
      manifest: { ...VALID_MANIFEST_BASE, name: "scheduler-disabled", capabilities: [METADATA_CAP] },
      config: {},
      actorUserId: adminId,
      nowMs,
    });
    await lifecycleService.setEnabled(disabledPluginRow.id, false, adminId, nowMs);

    const scheduler = new PluginHealthSchedulerService(dbProvider, healthService);
    await scheduler.runSweep();

    const enabledAfter = await getPluginById(dbProvider.db, enabledPlugin.id);
    expect(enabledAfter?.health_state).toBe("healthy");
    expect(enabledAfter?.last_health_check_ms).not.toBeNull();

    // The disabled plugin's stub was NEVER contacted — the sweep filters
    // to enabled plugins only, before ever calling runHealthCheck.
    expect(disabledStubHits).toBe(0);
    const disabledAfter = await getPluginById(dbProvider.db, disabledPluginRow.id);
    expect(disabledAfter?.last_health_check_ms).toBeNull();
  }, 20_000);

  it("runSweep() is safe to call concurrently (overlap guard — a slow tick never runs twice at once)", async () => {
    const scheduler = new PluginHealthSchedulerService(dbProvider, healthService);
    await expect(Promise.all([scheduler.runSweep(), scheduler.runSweep(), scheduler.runSweep()])).resolves.toBeDefined();
  }, 20_000);
});

// ===========================================================================
// lifecycle: HMAC rotation, config update, removal
// ===========================================================================

describe("PluginLifecycleService", () => {
  const stubs: StubServer[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("rotateHmac returns a fresh value each time, distinct from the original mint", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        return jsonResponse(res, 200, { ...VALID_MANIFEST_BASE, capabilities: [METADATA_CAP] });
      }
      if (req.method === "POST" && req.url === "/lpp/provider/search") {
        return jsonResponse(res, 200, { results: [] });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const manifestDigest = await digestFor(stub.baseUrl, [stub.host]);
    const registered = await registrationService.registerPlugin({
      baseUrl: stub.baseUrl,
      lanAllowlist: [stub.host],
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      configValues: {},
      actorUserId: adminId,
      manifestDigest,
    });

    const rotated = await lifecycleService.rotateHmac(registered.plugin.id, adminId);
    expect(rotated).not.toBe(registered.hmacSecret);
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);

    const rotatedAgain = await lifecycleService.rotateHmac(registered.plugin.id, adminId);
    expect(rotatedAgain).not.toBe(rotated);
  }, 15_000);

  it("removePlugin deletes the row and cascades plugin_event_grants — the id no longer resolves", async () => {
    const stub = await startStub((req, res) => {
      if (req.method === "GET" && req.url === "/lpp/manifest") {
        return jsonResponse(res, 200, { ...VALID_MANIFEST_BASE, capabilities: [METADATA_CAP] });
      }
      if (req.method === "POST" && req.url === "/lpp/provider/search") {
        return jsonResponse(res, 200, { results: [] });
      }
      jsonResponse(res, 404, {});
    });
    stubs.push(stub);

    const manifestDigest = await digestFor(stub.baseUrl, [stub.host]);
    const registered = await registrationService.registerPlugin({
      baseUrl: stub.baseUrl,
      lanAllowlist: [stub.host],
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      configValues: {},
      actorUserId: adminId,
      manifestDigest,
    });

    const before = await listPlugins(dbProvider.db);
    expect(before.some((p) => p.id === registered.plugin.id)).toBe(true);

    await lifecycleService.removePlugin(registered.plugin.id, adminId);

    const fetched = await getPluginById(dbProvider.db, registered.plugin.id);
    expect(fetched).toBeUndefined();
  }, 15_000);
});
