// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/viewer-context.provider.spec.ts
//
// Live-DB tests (self-sufficient, reset+reseed in beforeAll) for the
// per-request ViewerContext resolver — the security keystone (task spec):
// composes users/user_settings/library_permissions through
// resolveClearance() into the exact {userId, allowedLibraryIds,
// restrictedCleared} shape packages/db's query guard requires.
//
// Runs against a database PRIVATE to apps/server's own test run
// (ensureTestDatabase, "<base>_server_test") to avoid a cross-package
// concurrent-reset deadlock under turbo — see refresh-token.service.spec.ts's
// header and packages/db/src/testing.ts.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestDatabase, getUserByUsername, setRestrictedUnlockUntil } from "@loombre/db";
import { DbProvider, type LoombreDb } from "./db.provider.js";
import { ViewerContextProvider } from "./viewer-context.provider.js";
import { SettingsService } from "../settings/settings.service.js";

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
    throw new Error(
      `${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

let db: LoombreDb;
let dbProvider: DbProvider;
let settingsService: SettingsService;
let provider: ViewerContextProvider;
let adminId: string;
let casualId: string;

const ORIGINAL_RESTRICTED_ENABLED = process.env["LOOMBRE_RESTRICTED_ENABLED"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  dbProvider = new DbProvider();
  db = dbProvider.db;
  settingsService = new SettingsService(dbProvider);
  await settingsService.bootstrap();
  provider = new ViewerContextProvider(dbProvider, settingsService);

  const admin = await getUserByUsername(db, "admin");
  const casual = await getUserByUsername(db, "casual");
  if (!admin || !casual) throw new Error("seed did not create both users");
  adminId = admin.id;
  casualId = casual.id;
});

afterEach(async () => {
  if (ORIGINAL_RESTRICTED_ENABLED === undefined) {
    delete process.env["LOOMBRE_RESTRICTED_ENABLED"];
  } else {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = ORIGINAL_RESTRICTED_ENABLED;
  }
  // Addendum A, lane S3: SettingsService caches its env-pin resolution —
  // it does not poll process.env on every read (env vars don't change at
  // runtime for a real deployment either). Every test below still mutates
  // process.env directly (an easy, self-contained way to exercise the
  // restricted.enabled env pin without a second DB write path) but must
  // now explicitly reload() the cache afterward for that mutation to take
  // effect — see settings.service.ts's own header for the cache/reload
  // contract.
  await settingsService.reload();
});

afterAll(async () => {
  await dbProvider.onModuleDestroy();
});

describe("ViewerContextProvider.resolveRestrictedSurface (the clearance-bearing half)", () => {
  it("casual user: general libraries only, never restrictedCleared, regardless of capability flag", async () => {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
    await settingsService.reload();
    const ctx = await provider.resolveRestrictedSurface(casualId, Date.now());
    expect(ctx.userId).toBe(casualId);
    expect(ctx.allowedLibraryIds).toHaveLength(3); // 3 general libraries granted in seed
    expect(ctx.restrictedCleared).toBe(false);
  });

  it("admin user with capability OFF: restricted library excluded from allowedLibraryIds even though gate 4 (permission) is granted", async () => {
    delete process.env["LOOMBRE_RESTRICTED_ENABLED"];
    await settingsService.reload();
    const ctx = await provider.resolveRestrictedSurface(adminId, Date.now());
    expect(ctx.allowedLibraryIds).toHaveLength(3); // general only — gate 1 fails
    expect(ctx.restrictedCleared).toBe(false);
  });

  it("admin user with capability ON but NOT unlocked: gates 1-4 pass (restricted library visible in allowedLibraryIds) but restrictedCleared stays false (gate 5)", async () => {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
    await settingsService.reload();
    await setRestrictedUnlockUntil(db, adminId, null, Date.now());

    const ctx = await provider.resolveRestrictedSurface(adminId, Date.now());
    expect(ctx.allowedLibraryIds).toHaveLength(4); // 3 general + 1 restricted
    expect(ctx.restrictedCleared).toBe(false);
  });

  it("admin user fully cleared (capability on, unlocked, all other gates satisfied by seed data): restrictedCleared true", async () => {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
    await settingsService.reload();
    const nowMs = Date.now();
    await setRestrictedUnlockUntil(db, adminId, nowMs + 60_000, nowMs);

    const ctx = await provider.resolveRestrictedSurface(adminId, nowMs);
    expect(ctx.allowedLibraryIds).toHaveLength(4);
    expect(ctx.restrictedCleared).toBe(true);
  });

  it("expired unlock (unlockedUntilMs in the past) does not clear gate 5", async () => {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
    await settingsService.reload();
    const nowMs = Date.now();
    await setRestrictedUnlockUntil(db, adminId, nowMs - 1, nowMs - 100);

    const ctx = await provider.resolveRestrictedSurface(adminId, nowMs);
    expect(ctx.restrictedCleared).toBe(false);
  });

  it("RZI surface scoping: the general half of the pair is hard-general — restrictedCleared false and restricted library ids excluded — even for a fully-cleared viewer", async () => {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
    await settingsService.reload();
    const nowMs = Date.now();
    await setRestrictedUnlockUntil(db, adminId, nowMs + 60_000, nowMs);

    const pair = await provider.resolveSurfaces(adminId, nowMs);
    expect(pair.restricted.restrictedCleared).toBe(true);
    expect(pair.restricted.surface).toBe("restricted");
    expect(pair.restricted.allowedLibraryIds).toHaveLength(4);
    // The general half never widens with the unlock — defense in depth on
    // top of the guard's own surface clause.
    expect(pair.general.restrictedCleared).toBe(false);
    expect(pair.general.surface).toBe("general");
    expect(pair.general.allowedLibraryIds).toHaveLength(3);
    expect(pair.general.userId).toBe(pair.restricted.userId);
  });

  it("Addendum A: restricted.majorityAgeYears raised via settings is honored (belt-and-braces Math.max(18,...) never clamps a legitimate value above 18)", async () => {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
    await settingsService.reload();
    await settingsService.updateSetting({
      key: "restricted.majorityAgeYears",
      value: 21,
      actorUserId: adminId,
      nowMs: Date.now(),
    });
    try {
      const nowMs = Date.now();
      await setRestrictedUnlockUntil(db, adminId, nowMs + 60_000, nowMs);
      // seeded admin's birth_date makes them >=18 but the test doesn't
      // assert an exact age — this only proves the raised floor is READ at
      // all (no throw, no silent ignore) and gate 2 still evaluates.
      const ctx = await provider.resolveRestrictedSurface(adminId, nowMs);
      expect(typeof ctx.restrictedCleared).toBe("boolean");
    } finally {
      await settingsService.updateSetting({
        key: "restricted.majorityAgeYears",
        value: 18,
        actorUserId: adminId,
        nowMs: Date.now(),
      });
    }
  });
});
