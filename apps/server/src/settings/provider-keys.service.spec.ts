// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/provider-keys.service.spec.ts
//
// Live-DB tests (self-sufficient, reset+reseed in beforeAll), same
// ensureTestDatabase convention as settings.service.spec.ts. Forces
// LOOMBRE_SECRET_BACKEND=file0600 for the whole suite (packages/secrets/
// test/native-keyring.spec.ts's own established convention) so this NEVER
// touches a real OS credential store — file0600 is deterministic and
// side-effect-free (writes under a throwaway LOOMBRE_DATA_DIR instead).
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestDatabase, getUserByUsername, readUnprocessedEvents } from "@loombre/db";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { ProviderKeysService } from "./provider-keys.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");

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

let db: LoombreDb;
let dbProvider: DbProvider;
let adminId: string;
let casualId: string;
let dataDir: string;

const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];
const ORIGINAL_TMDB_KEY = process.env["LOOMBRE_TMDB_API_KEY"];
const ORIGINAL_TVDB_KEY = process.env["LOOMBRE_TVDB_API_KEY"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "provider_keys_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-provider-keys-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;
  delete process.env["LOOMBRE_TMDB_API_KEY"];
  delete process.env["LOOMBRE_TVDB_API_KEY"];

  dbProvider = new DbProvider();
  db = dbProvider.db;

  const admin = await getUserByUsername(db, "admin");
  const casual = await getUserByUsername(db, "casual");
  if (!admin || !casual) throw new Error("seed did not create both users");
  adminId = admin.id;
  casualId = casual.id;
});

afterEach(() => {
  if (ORIGINAL_TMDB_KEY === undefined) delete process.env["LOOMBRE_TMDB_API_KEY"];
  else process.env["LOOMBRE_TMDB_API_KEY"] = ORIGINAL_TMDB_KEY;
});

afterAll(async () => {
  await dbProvider.onModuleDestroy();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
  if (ORIGINAL_TVDB_KEY === undefined) delete process.env["LOOMBRE_TVDB_API_KEY"];
  else process.env["LOOMBRE_TVDB_API_KEY"] = ORIGINAL_TVDB_KEY;
});

function freshService(): ProviderKeysService {
  return new ProviderKeysService(dbProvider);
}

describe("ProviderKeysService.providerKeyStatus", () => {
  it("reports set:false, source:null when nothing is configured", async () => {
    const service = freshService();
    await expect(service.providerKeyStatus("tvdb")).resolves.toEqual({ provider: "tvdb", set: false, source: null });
  });

  it("env var wins and is reported as source:'env' with no lastSetMs (A8 precedence)", async () => {
    process.env["LOOMBRE_TMDB_API_KEY"] = "env-supplied-key";
    const service = freshService();
    const status = await service.providerKeyStatus("tmdb");
    expect(status).toEqual({ provider: "tmdb", set: true, source: "env" });
  });
});

describe("ProviderKeysService.setProviderKey / clearProviderKey", () => {
  it("set() stores an envelope with setAtMs, status reports source:'keyring' + lastSetMs, and the value is never present in the returned status", async () => {
    const service = freshService();
    const nowMs = Date.now();
    const status = await service.setProviderKey({ provider: "tvdb", key: "  a-real-secret-key  ", actorUserId: adminId, nowMs });

    expect(status).toEqual({ provider: "tvdb", set: true, source: "keyring", lastSetMs: nowMs });
    expect(JSON.stringify(status)).not.toContain("a-real-secret-key");
  });

  it("clear() removes the stored key; status reverts to set:false", async () => {
    const service = freshService();
    await service.setProviderKey({ provider: "tvdb", key: "another-key", actorUserId: adminId, nowMs: Date.now() });
    expect((await service.providerKeyStatus("tvdb")).set).toBe(true);

    await service.clearProviderKey({ provider: "tvdb", actorUserId: adminId, nowMs: Date.now() });
    expect(await service.providerKeyStatus("tvdb")).toEqual({ provider: "tvdb", set: false, source: null });
  });

  it("rejects an empty key with 422", async () => {
    const service = freshService();
    await expect(
      service.setProviderKey({ provider: "tvdb", key: "   ", actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("F11a: rejects a PUT with 409 while the provider's env var is set, instead of silently writing an inert keyring value", async () => {
    process.env["LOOMBRE_TMDB_API_KEY"] = "env-supplied-key";
    const service = freshService();
    await expect(
      service.setProviderKey({ provider: "tmdb", key: "an-attempted-override", actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 409 });

    // Nothing was written to the keyring underneath the pin — status is
    // still exactly what the env var reports, not a keyring value racing
    // it (there's nothing to race: the write never happened).
    const status = await service.providerKeyStatus("tmdb");
    expect(status).toEqual({ provider: "tmdb", set: true, source: "env" });
  });

  it("404s an unknown provider name", async () => {
    const service = freshService();
    await expect(
      service.setProviderKey({ provider: "not-a-provider", key: "x", actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("403s a non-admin actor on both set and clear (A10 applies to provider keys too)", async () => {
    const service = freshService();
    await expect(
      service.setProviderKey({ provider: "tvdb", key: "x", actorUserId: casualId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.clearProviderKey({ provider: "tvdb", actorUserId: casualId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("set/clear each emit a settings.updated outbox event with a redacted value, never the real key (A9)", async () => {
    const service = freshService();
    const nowMs = Date.now();
    await service.setProviderKey({ provider: "tmdb", key: "super-secret-value", actorUserId: adminId, nowMs });

    // readUnprocessedEvents (packages/db's public barrel, UNGUARDED-by-
    // design outbox drain read — see that function's own doc comment) is
    // used here instead of a raw `pg`/`kysely` import: dependency-cruiser's
    // "no-raw-db-driver-outside-packages-db" rule forbids those anywhere
    // under apps/server EXCEPT apps/server/test/ (the excluded top-level
    // test dir) — this file is colocated under src/settings/ instead, so it
    // stays inside that fence like every other apps/server/src/**/*.spec.ts.
    const events = await readUnprocessedEvents(db, 500);
    const settingsEvents = events.filter(
      (e) => e.type === "settings.updated" && (e.payload as Record<string, unknown>)["key"] === "providerKey.tmdb",
    );
    expect(settingsEvents).toHaveLength(1);
    expect(settingsEvents[0]!.payload).toMatchObject({ key: "providerKey.tmdb", oldValue: "[redacted]", newValue: "[redacted]" });
    expect(JSON.stringify(settingsEvents[0]!.payload)).not.toContain("super-secret-value");
  });
});

describe("ProviderKeysService.allProviderKeyStatuses", () => {
  it("returns one entry per known provider", async () => {
    const service = freshService();
    const statuses = await service.allProviderKeyStatuses();
    expect(statuses.map((s) => s.provider).sort()).toEqual(["tmdb", "tvdb"]);
  });
});
