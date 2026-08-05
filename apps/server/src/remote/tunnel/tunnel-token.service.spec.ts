// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/tunnel-token.service.spec.ts
//
// Live-DB tests, mirrors apps/server/src/settings/mail-credentials.service.
// spec.ts's own convention exactly (file0600 backend forced, throwaway
// LOOMBRE_DATA_DIR — never touches a real OS credential store). R11: uses a
// FAKE TunnelProvider (never CloudflareTunnelProvider, never the live
// Cloudflare API) — this suite is about token custody/lifecycle, not the
// provider's own HTTP behavior (cloudflare-tunnel-provider.spec.ts covers
// that).
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestDatabase, getUserByUsername, readUnprocessedEvents } from "@loombre/db";
import { DbProvider, type LoombreDb } from "../../common/db.provider.js";
import { TunnelTokenService } from "./tunnel-token.service.js";
import { TunnelProvider, type TunnelTokenValidation } from "./tunnel-provider.js";
import type {
  DeprovisionTunnelInput,
  DnsRouteInput,
  DnsRouteResult,
  ProvisionTunnelInput,
  ProvisionTunnelResult,
  RemoveDnsRouteInput,
} from "./tunnel-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../../packages/db");

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

/** A controllable fake — every real test double this repo's own similar
 *  suites use (FakeTriggers in server-power.e2e.spec.ts) is a plain class
 *  with mutable fields the test flips, not a mocking library. */
class FakeTunnelProvider implements TunnelProvider {
  nextValidation: TunnelTokenValidation = { valid: true, scopes: [], accountId: "acct-1", missingScopes: [], detail: null };
  validateCalls: string[] = [];

  async validateToken(token: string): Promise<TunnelTokenValidation> {
    this.validateCalls.push(token);
    return this.nextValidation;
  }
  async provisionTunnel(_input: ProvisionTunnelInput): Promise<ProvisionTunnelResult> {
    throw new Error("not used by this suite");
  }
  async deprovisionTunnel(_input: DeprovisionTunnelInput): Promise<void> {
    throw new Error("not used by this suite");
  }
  async createDnsRoute(_input: DnsRouteInput): Promise<DnsRouteResult> {
    throw new Error("not used by this suite");
  }
  async removeDnsRoute(_input: RemoveDnsRouteInput): Promise<void> {
    throw new Error("not used by this suite");
  }
}

let db: LoombreDb;
let dbProvider: DbProvider;
let adminId: string;
let casualId: string;
let dataDir: string;

const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "tunnel_token_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-tunnel-token-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;

  dbProvider = new DbProvider();
  db = dbProvider.db;

  const admin = await getUserByUsername(db, "admin");
  const casual = await getUserByUsername(db, "casual");
  if (!admin || !casual) throw new Error("seed did not create both users");
  adminId = admin.id;
  casualId = casual.id;
});

beforeEach(async () => {
  // All tests in this file share ONE keyring key (fixed dataDir, set once
  // in beforeAll) — clear it before every test so each one starts from a
  // genuinely unconfigured state, independent of test order.
  await new TunnelTokenService(dbProvider, new FakeTunnelProvider()).clearToken({ actorUserId: adminId, nowMs: Date.now() });
});

afterEach(() => {
  // Nothing to reset process.env-wise for this suite (no env-pin branch —
  // see this service's own header on why not).
});

afterAll(async () => {
  await dbProvider.onModuleDestroy();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

function freshService(provider: FakeTunnelProvider): TunnelTokenService {
  return new TunnelTokenService(dbProvider, provider);
}

describe("TunnelTokenService.status", () => {
  it("reports configured:false, setAtMs:null, scopesOk:null when nothing is configured", async () => {
    const service = freshService(new FakeTunnelProvider());
    await expect(service.status()).resolves.toEqual({ configured: false, setAtMs: null, scopesOk: null });
  });
});

describe("TunnelTokenService.setToken", () => {
  it("validates via the provider BEFORE storing, and never echoes the token back", async () => {
    const provider = new FakeTunnelProvider();
    const service = freshService(provider);
    const nowMs = Date.now();

    const result = await service.setToken({ token: "cf-token-value-xyz", actorUserId: adminId, nowMs });

    expect(result).toEqual({ valid: true, detail: null });
    expect(JSON.stringify(result)).not.toContain("cf-token-value-xyz");
    expect(provider.validateCalls).toEqual(["cf-token-value-xyz"]);

    const status = await service.status();
    expect(status).toEqual({ configured: true, setAtMs: nowMs, scopesOk: true });
    expect(JSON.stringify(status)).not.toContain("cf-token-value-xyz");
  });

  it("resolveStoredToken (internal-only) returns the raw value; no other method on this service ever does", async () => {
    const provider = new FakeTunnelProvider();
    const service = freshService(provider);
    await service.setToken({ token: "cf-token-internal", actorUserId: adminId, nowMs: Date.now() });
    await expect(service.resolveStoredToken()).resolves.toBe("cf-token-internal");
  });

  it("rejects an empty token WITHOUT calling the provider (no network call for obviously-empty input)", async () => {
    const provider = new FakeTunnelProvider();
    const service = freshService(provider);
    const result = await service.setToken({ token: "   ", actorUserId: adminId, nowMs: Date.now() });
    expect(result).toEqual({ valid: false, detail: "token must not be empty." });
    expect(provider.validateCalls).toEqual([]);
    await expect(service.status()).resolves.toEqual({ configured: false, setAtMs: null, scopesOk: null });
  });

  it("does NOT store an invalid/insufficiently-scoped token — rejects with the provider's detail, status stays unconfigured", async () => {
    const provider = new FakeTunnelProvider();
    provider.nextValidation = {
      valid: false,
      scopes: ["Account Settings: Read"],
      accountId: "acct-1",
      missingScopes: ["Cloudflare Tunnel: Edit", "Zone: DNS Edit"],
      detail: "This token is missing required permissions: Cloudflare Tunnel: Edit, Zone: DNS Edit.",
    };
    const service = freshService(provider);

    const result = await service.setToken({ token: "under-scoped-token", actorUserId: adminId, nowMs: Date.now() });
    expect(result.valid).toBe(false);
    expect(result.detail).toContain("Cloudflare Tunnel: Edit");
    expect(result.detail).toContain("Zone: DNS Edit");

    await expect(service.status()).resolves.toEqual({ configured: false, setAtMs: null, scopesOk: null });
    await expect(service.resolveStoredToken()).resolves.toBeNull();
  });

  it("403s a non-admin actor and never calls the provider", async () => {
    const provider = new FakeTunnelProvider();
    const service = freshService(provider);
    await expect(service.setToken({ token: "x", actorUserId: casualId, nowMs: Date.now() })).rejects.toMatchObject({ status: 403 });
    expect(provider.validateCalls).toEqual([]);
  });

  it("emits a redacted settings.updated event (key remote.tunnelToken) — never the token value", async () => {
    const provider = new FakeTunnelProvider();
    const service = freshService(provider);
    await service.setToken({ token: "cf-token-for-event-check", actorUserId: adminId, nowMs: Date.now() });

    const events = await readUnprocessedEvents(db, 500);
    const found = events.filter((e) => e.type === "settings.updated" && (e.payload as { key?: string }).key === "remote.tunnelToken");
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) {
      const payloadJson = JSON.stringify(e.payload);
      expect(payloadJson).not.toContain("cf-token-for-event-check");
      expect((e.payload as { oldValue: string }).oldValue).toBe("[redacted]");
      expect((e.payload as { newValue: string }).newValue).toBe("[redacted]");
    }
  });
});

describe("TunnelTokenService.clearToken", () => {
  it("removes the stored token; status reverts to unconfigured; resolveStoredToken returns null", async () => {
    const provider = new FakeTunnelProvider();
    const service = freshService(provider);
    await service.setToken({ token: "to-be-cleared", actorUserId: adminId, nowMs: Date.now() });
    expect((await service.status()).configured).toBe(true);

    await service.clearToken({ actorUserId: adminId, nowMs: Date.now() });
    await expect(service.status()).resolves.toEqual({ configured: false, setAtMs: null, scopesOk: null });
    await expect(service.resolveStoredToken()).resolves.toBeNull();
  });

  it("403s a non-admin actor", async () => {
    const provider = new FakeTunnelProvider();
    const service = freshService(provider);
    await expect(service.clearToken({ actorUserId: casualId, nowMs: Date.now() })).rejects.toMatchObject({ status: 403 });
  });
});
