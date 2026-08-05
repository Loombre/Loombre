// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/posture/remote-posture.service.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7, S1 lane). Live-DB tests (same
// self-sufficient reset+reseed convention as settings.service.spec.ts,
// same ensureTestDatabase suffix pattern) for the IMPURE wiring this
// service adds on top of the already-fully-unit-tested pure grading
// functions (./checks/*.spec.ts): applicability per active path, and that
// each check reads the RIGHT live input (DB rows, effective settings, a
// real TLS certificate) rather than merely being individually correct in
// isolation.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestDatabase, createInviteAndEmit, resetUserPasswordAndEmit, createUserAdmin, getUserByUsername } from "@loombre/db";
import { applicableChecks, type PostureActivePath } from "@loombre/shared";
import { DbProvider, type LoombreDb } from "../../common/db.provider.js";
import { createFakeSettingsService } from "../../common/test-support/fake-settings-service.js";
import { generateSelfSignedCert } from "../../tls/test-support/self-signed-cert.js";
import { RemotePostureService } from "./remote-posture.service.js";
import type { ConnectorHealthReaderService } from "./connector-health.reader.js";
import type { WireguardStatusReaderService } from "./wireguard-status.reader.js";
import type { RemoteActivePathReaderService } from "./active-path.reader.js";

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

function fakeReader<T>(value: T): { read: () => Promise<T> } {
  return { read: async () => value };
}

let db: LoombreDb;
let dbProvider: DbProvider;
let adminId: string;

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "remote_posture_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  dbProvider = new DbProvider();
  db = dbProvider.db;

  const admin = await getUserByUsername(db, "admin");
  if (!admin) throw new Error("seed did not create the admin user");
  adminId = admin.id;
});

afterAll(async () => {
  await dbProvider.onModuleDestroy();
});

// Only ever clears the TLS-prefixed env vars THIS file's own tests set —
// deliberately NOT a full process.env snapshot/restore, which would also
// clobber DATABASE_URL (beforeAll reassigns it to the isolated test DB
// AFTER module load, so a naive "restore to module-load snapshot" would
// silently point every later test in this file back at the wrong database).
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("LOOMBRE_TLS_") || key === "LOOMBRE_ACME_TOS_AGREED") delete process.env[key];
  }
});

function buildService(opts: {
  settingsDbRows?: { key: string; value: unknown }[];
  connectorHealth?: string;
  wireguardStatus?: { enabled: boolean; listening: boolean } | undefined;
  activePath?: PostureActivePath;
} = {}): RemotePostureService {
  const { service: settingsService } = createFakeSettingsService({ dbRows: opts.settingsDbRows ?? [] });
  return new RemotePostureService(
    dbProvider,
    settingsService,
    fakeReader(opts.connectorHealth ?? "unknown") as unknown as ConnectorHealthReaderService,
    fakeReader(opts.wireguardStatus) as unknown as WireguardStatusReaderService,
    fakeReader(opts.activePath ?? "none") as unknown as RemoteActivePathReaderService,
  );
}

describe("RemotePostureService.evaluate — applicability matrix (checks appear/disappear per active path)", () => {
  it("path 'none' yields an empty, inactive card", async () => {
    const service = buildService();
    const { card } = await service.evaluate("none");
    expect(card.active).toBe(false);
    expect(card.checks).toEqual([]);
  });

  const paths: Exclude<PostureActivePath, "none">[] = ["remote", "tunnel", "direct"];
  for (const path of paths) {
    it(`path '${path}' surfaces exactly applicableChecks('${path}') — universal four plus the one path-specific check`, async () => {
      const service = buildService({ connectorHealth: "running", wireguardStatus: { enabled: true, listening: true } });
      const { card } = await service.evaluate(path);
      const expectedKeys = [...applicableChecks(path)].sort();
      const actualKeys = card.checks.map((c) => c.checkKey).sort();
      expect(actualKeys).toEqual(expectedKeys);
      expect(card.active).toBe(true);
    });
  }

  it("resolveActivePath delegates to the injected RemoteActivePathReaderService seam", async () => {
    const service = buildService({ activePath: "tunnel" });
    expect(await service.resolveActivePath()).toBe("tunnel");
  });
});

describe("RemotePostureService.evaluate — staleAccounts wiring (live DB)", () => {
  it("reads pass on the freshly seeded DB — admin/casual both have a seeded device row (runs before this file's own stale fixtures exist)", async () => {
    const { card } = await buildService().evaluate("remote");
    expect(card.checks.find((c) => c.checkKey === "staleAccounts")!.grade).toBe("pass");
  });

  it("reflects a real never-logged-in account seeded directly in the DB", async () => {
    await createUserAdmin(db, {
      username: `posture-stale-${Date.now()}`,
      email: null,
      passwordHash: "not-a-real-hash",
      isAdmin: false,
      maxContentRating: null,
      nowMs: Date.now(),
    });

    const { card } = await buildService().evaluate("remote");
    expect(card.checks.find((c) => c.checkKey === "staleAccounts")!.grade).toBe("warn");
  });

  it("clears once the account is no longer stale (must_change_password reset)", async () => {
    const user = await createUserAdmin(db, {
      username: `posture-temp-${Date.now()}`,
      email: null,
      passwordHash: "not-a-real-hash",
      isAdmin: false,
      maxContentRating: null,
      nowMs: Date.now(),
    });
    await resetUserPasswordAndEmit(db, {
      userId: user.id,
      username: user.username,
      passwordHash: "temp-hash",
      actor: "admin",
      actorUserId: adminId,
      nowMs: Date.now(),
    });
    const withStale = await buildService().evaluate("remote");
    expect(withStale.card.checks.find((c) => c.checkKey === "staleAccounts")!.grade).toBe("warn");
  });
});

describe("RemotePostureService.evaluate — inviteLinksReachable wiring (live DB)", () => {
  it("flips from pass to info once a pending invite exists", async () => {
    await createInviteAndEmit(db, {
      createdByUserId: adminId,
      tokenHash: `wiring-test-${Date.now()}`,
      usernamePreset: null,
      displayNamePreset: null,
      email: null,
      libraryIds: [],
      expiresAtMs: Date.now() + 72 * 60 * 60 * 1000,
      nowMs: Date.now(),
    });
    const { card } = await buildService().evaluate("remote");
    expect(card.checks.find((c) => c.checkKey === "inviteLinksReachable")!.grade).toBe("info");
  });
});

describe("RemotePostureService.evaluate — rateLimitersActive / publicUrlCoherence wiring (settings keys)", () => {
  it("reads the exact rateLimit.probe/login/refresh/unlock keys (registry defaults -> pass)", async () => {
    const { card } = await buildService().evaluate("remote");
    expect(card.checks.find((c) => c.checkKey === "rateLimitersActive")!.grade).toBe("pass");
  });

  it("publicUrlCoherence (tunnel): reads network.publicUrl + remote.tunnelHostname by their exact registry keys", async () => {
    const service = buildService({
      settingsDbRows: [
        { key: "network.publicUrl", value: "https://tunnel.example.com" },
        { key: "remote.tunnelHostname", value: "tunnel.example.com" },
      ],
      connectorHealth: "running",
    });
    const { card } = await service.evaluate("tunnel");
    expect(card.checks.find((c) => c.checkKey === "publicUrlCoherence")!.grade).toBe("pass");
  });

  it("publicUrlCoherence (tunnel): mismatched publicUrl fails", async () => {
    const service = buildService({
      settingsDbRows: [
        { key: "network.publicUrl", value: "https://wrong.example.com" },
        { key: "remote.tunnelHostname", value: "tunnel.example.com" },
      ],
      connectorHealth: "running",
    });
    const { card } = await service.evaluate("tunnel");
    expect(card.checks.find((c) => c.checkKey === "publicUrlCoherence")!.grade).toBe("fail");
  });
});

describe("RemotePostureService.evaluate — tlsValidity wiring (real TLS config + a real certificate)", () => {
  it("mode 'off' (no LOOMBRE_TLS_MODE set) -> info, the honest ceiling for TLS Loombre never terminates", async () => {
    delete process.env["LOOMBRE_TLS_MODE"];
    const { card } = await buildService().evaluate("direct");
    expect(card.checks.find((c) => c.checkKey === "tlsValidity")!.grade).toBe("info");
  });

  // generateSelfSignedCert's fixture is always a real ~1-day-validity
  // certificate (test-support/self-signed-cert.ts's own fixed -days 1) —
  // squarely inside gradeTlsValidity's default 14-day warn window, so the
  // REAL end-to-end read+parse pipeline against a genuinely valid
  // certificate honestly reads `warn` here (not `pass`) — this is the
  // pipeline working correctly, not a weaker assertion; ./checks/
  // tls-validity.spec.ts already exercises the `pass` branch directly
  // against a fixture far enough from expiry.
  it("mode 'manual', a REAL currently-valid certificate on disk, evaluated 'now' -> warn (inside the 14-day window) — exercises the actual read+parse path, not just the pure grader", async () => {
    const fixture = generateSelfSignedCert("loombre-posture-test.invalid");
    const dir = mkdtempSync(path.join(tmpdir(), "loombre-posture-tls-"));
    const certPath = path.join(dir, "cert.pem");
    const keyPath = path.join(dir, "key.pem");
    writeFileSync(certPath, fixture.cert);
    writeFileSync(keyPath, fixture.key);
    try {
      process.env["LOOMBRE_TLS_MODE"] = "manual";
      process.env["LOOMBRE_TLS_CERT_PATH"] = certPath;
      process.env["LOOMBRE_TLS_KEY_PATH"] = keyPath;
      const { card } = await buildService().evaluate("direct");
      expect(card.checks.find((c) => c.checkKey === "tlsValidity")!.grade).toBe("warn");
    } finally {
      fixture.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the SAME real certificate, evaluated against a far-future 'now' -> fail (the expiry math runs against a REAL parsed certificate, not a fixture number)", async () => {
    const fixture = generateSelfSignedCert("loombre-posture-test.invalid");
    const dir = mkdtempSync(path.join(tmpdir(), "loombre-posture-tls-"));
    const certPath = path.join(dir, "cert.pem");
    const keyPath = path.join(dir, "key.pem");
    writeFileSync(certPath, fixture.cert);
    writeFileSync(keyPath, fixture.key);
    try {
      process.env["LOOMBRE_TLS_MODE"] = "manual";
      process.env["LOOMBRE_TLS_CERT_PATH"] = certPath;
      process.env["LOOMBRE_TLS_KEY_PATH"] = keyPath;
      const farFutureMs = Date.now() + 4000 * 24 * 60 * 60 * 1000;
      const { card } = await buildService().evaluate("direct", farFutureMs);
      expect(card.checks.find((c) => c.checkKey === "tlsValidity")!.grade).toBe("fail");
    } finally {
      fixture.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mode 'manual' but the certificate file does not exist on disk -> fail, WITHOUT taking down the rest of the card", async () => {
    process.env["LOOMBRE_TLS_MODE"] = "manual";
    process.env["LOOMBRE_TLS_CERT_PATH"] = path.join(tmpdir(), "loombre-posture-does-not-exist-cert.pem");
    process.env["LOOMBRE_TLS_KEY_PATH"] = path.join(tmpdir(), "loombre-posture-does-not-exist-key.pem");
    // loadTlsConfig itself throws TlsConfigError here (config.ts's own
    // eager existence check for manual-mode paths) — evalTlsValidity
    // catches that and degrades to `fail` rather than letting it reject
    // the whole evaluate() Promise.all and take every OTHER check down
    // with it. Assert BOTH: tlsValidity itself reads fail, and a sibling
    // check (rateLimitersActive) still evaluated normally in the same call.
    const { card } = await buildService().evaluate("direct");
    expect(card.checks.find((c) => c.checkKey === "tlsValidity")!.grade).toBe("fail");
    expect(card.checks.find((c) => c.checkKey === "rateLimitersActive")!.grade).toBe("pass");
  });
});
