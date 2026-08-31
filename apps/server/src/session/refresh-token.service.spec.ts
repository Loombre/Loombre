// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/refresh-token.service.spec.ts
//
// Live-DB tests (self-sufficient: resets + reseeds in beforeAll, matching
// packages/db/test/leak.spec.ts's pattern) for rotation-on-every-use and
// reuse (token-theft) detection — the task spec's headline auth behaviors.
//
// Runs against a database PRIVATE to apps/server's own test run
// (ensureTestDatabase, "<base>_server_test") rather than the shared
// DATABASE_URL directly: turbo parallelizes independent packages' `test`
// tasks (e.g. @loombre/jobs and @loombre/server both depend on @loombre/db but
// not on each other), and two packages concurrently running
// `packages/db/scripts/migrate.mjs reset` (DROP SCHEMA public CASCADE + replay) against
// the SAME database can Postgres-deadlock — discovered while wiring this
// wave's tests into `pnpm gate`. See packages/db/src/testing.ts.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDevice, ensureTestDatabase, findRefreshTokenByHash, getUserByUsername } from "@loombre/db";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { RefreshTokenService } from "./refresh-token.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/db lives two levels up from apps/server/src/session.
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
let service: RefreshTokenService;
let adminId: string;

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  dbProvider = new DbProvider();
  db = dbProvider.db;
  service = new RefreshTokenService();

  const admin = await getUserByUsername(db, "admin");
  if (!admin) throw new Error("seed did not create the admin user");
  adminId = admin.id;
});

afterAll(async () => {
  await dbProvider.onModuleDestroy();
});

describe("RefreshTokenService", () => {
  it("issue() returns an opaque token distinct from its stored hash, with a 30-day TTL", async () => {
    const device = await createDevice(db, {
      userId: adminId,
      name: "issue-test-device",
      platform: "web",
      profile: {},
      nowMs: 1_000,
    });

    const issued = await service.issue(db, adminId, device.id, 1_000);
    expect(issued.refreshToken).toBeTruthy();
    expect(issued.expiresAtMs).toBe(1_000 + 30 * 24 * 60 * 60 * 1000);
    expect(issued.row.token_hash).not.toBe(issued.refreshToken);

    const hash = service.hashToken(issued.refreshToken);
    const row = await findRefreshTokenByHash(db, hash);
    expect(row?.id).toBe(issued.row.id);
  });

  it("rotate(): a valid presented token rotates to a new token and revokes the old one", async () => {
    const device = await createDevice(db, {
      userId: adminId,
      name: "rotate-test-device",
      platform: "web",
      profile: {},
      nowMs: 2_000,
    });
    const issued = await service.issue(db, adminId, device.id, 2_000);

    const result = await service.rotate(db, issued.refreshToken, 3_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok rotate result");
    expect(result.userId).toBe(adminId);
    expect(result.deviceId).toBe(device.id);
    expect(result.issued.refreshToken).not.toBe(issued.refreshToken);

    const oldRow = await findRefreshTokenByHash(db, service.hashToken(issued.refreshToken));
    expect(oldRow?.revoked_at_ms).toBe(3_000);

    const newRow = await findRefreshTokenByHash(db, service.hashToken(result.issued.refreshToken));
    expect(newRow?.rotated_from).toBe(issued.row.id);
    expect(newRow?.revoked_at_ms).toBeNull();
  });

  it("rotate(): reusing an already-rotated token is a theft signal — revokes the whole chain and reports 'reused'", async () => {
    const device = await createDevice(db, {
      userId: adminId,
      name: "theft-test-device",
      platform: "web",
      profile: {},
      nowMs: 4_000,
    });
    const issued = await service.issue(db, adminId, device.id, 4_000);
    const firstRotation = await service.rotate(db, issued.refreshToken, 5_000);
    if (!firstRotation.ok) throw new Error("expected first rotation to succeed");

    // Attacker (or a lost race) replays the ORIGINAL token, which is now revoked.
    const reuse = await service.rotate(db, issued.refreshToken, 6_000);
    expect(reuse).toEqual({ ok: false, reason: "reused" });

    // Theft response must have revoked the legitimate rotated-forward token too.
    const legitimateTipRow = await findRefreshTokenByHash(
      db,
      service.hashToken(firstRotation.issued.refreshToken),
    );
    expect(legitimateTipRow?.revoked_at_ms).toBe(6_000);
  });

  it("rotate(): an unknown token is 'invalid'", async () => {
    const result = await service.rotate(db, "not-a-real-token", 7_000);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("rotate(): an expired-but-not-yet-rotated token is 'expired', without nuking the chain", async () => {
    const device = await createDevice(db, {
      userId: adminId,
      name: "expiry-test-device",
      platform: "web",
      profile: {},
      nowMs: 8_000,
    });
    const issued = await service.issue(db, adminId, device.id, 8_000);

    const farFuture = issued.expiresAtMs + 1;
    const result = await service.rotate(db, issued.refreshToken, farFuture);
    expect(result).toEqual({ ok: false, reason: "expired" });

    // Still not revoked — expiry alone isn't a theft signal.
    const row = await findRefreshTokenByHash(db, service.hashToken(issued.refreshToken));
    expect(row?.revoked_at_ms).toBeNull();
  });

  it("logout(): revokes every active token for that (user, device) pair", async () => {
    const device = await createDevice(db, {
      userId: adminId,
      name: "logout-test-device",
      platform: "web",
      profile: {},
      nowMs: 9_000,
    });
    const issued = await service.issue(db, adminId, device.id, 9_000);

    const count = await service.logout(db, adminId, device.id, 10_000);
    expect(count).toBe(1);

    const row = await findRefreshTokenByHash(db, service.hashToken(issued.refreshToken));
    expect(row?.revoked_at_ms).toBe(10_000);
  });
});
