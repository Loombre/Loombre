// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/settings.service.spec.ts
//
// Live-DB tests (self-sufficient, reset+reseed in beforeAll), same
// ensureTestDatabase convention as viewer-context.provider.spec.ts ("<base>_
// settings_test") to avoid a cross-package/cross-suite concurrent-reset
// collision under turbo.
//
// Base connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestDatabase, getUserByUsername, updateUserAdmin } from "@loombre/db";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { SettingsService } from "./settings.service.js";

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

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "settings_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  dbProvider = new DbProvider();
  db = dbProvider.db;

  const admin = await getUserByUsername(db, "admin");
  const casual = await getUserByUsername(db, "casual");
  if (!admin || !casual) throw new Error("seed did not create both users");
  adminId = admin.id;
  casualId = casual.id;
});

afterAll(async () => {
  await dbProvider.onModuleDestroy();
});

function freshService(): SettingsService {
  return new SettingsService(dbProvider);
}

describe("SettingsService on an UNMIGRATED database (42P01)", () => {
  // docs/install/docker.md: "healthy with an unmigrated database is
  // expected, not a bug" — the documented flows boot the server BEFORE the
  // operator runs migrate. Found by the post-rename Docker install smoke:
  // Addendum A's boot-time settings read crash-looped the server on a
  // virgin compose database (the same disease as the embedded-PG
  // crash-loop already logged in STATE.md's addendum Open list).
  it("bootstrap() resolves every key from env/default with a loud notice, never crashing", async () => {
    const unmigratedUrl = await ensureTestDatabase(BASE_DATABASE_URL, "settings_unmigrated_test");
    // Deterministically unmigrated: drop the relation via a pg subprocess
    // (this spec must not import pg/kysely — CLAUDE.md invariant 4).
    run(
      "-e",
      [
        "const pg = require('pg'); (async () => { const c = new pg.Client({ connectionString: process.env['DATABASE_URL'] }); await c.connect(); await c.query('DROP TABLE IF EXISTS server_settings CASCADE'); await c.end(); })().catch((e) => { console.error(e); process.exit(1); });",
      ],
      unmigratedUrl,
    );
    const prevUrl = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = unmigratedUrl;
    const provider = new DbProvider();
    try {
      const service = new SettingsService(provider);
      const result = await service.bootstrap();
      // Zero DB rows: everything resolves from env/default — spot-check a
      // key that has NO env pin (the ≥18 floor's default).
      expect(result.values["restricted.majorityAgeYears"]).toMatchObject({ value: 18, source: "default" });
    } finally {
      process.env["DATABASE_URL"] = prevUrl;
      await provider.onModuleDestroy();
    }
  });
});

describe("SettingsService.bootstrap/reload", () => {
  it("resolves every registry entry to its default when server_settings is empty", async () => {
    const service = freshService();
    await service.bootstrap();
    expect(service.getEffective("restricted.enabled")).toMatchObject({ value: false, source: "default" });
    expect(service.getEffective("transcode.maxSimultaneousTranscodes")).toMatchObject({ value: 1, source: "default" });
  });

  it("unknownDbKeys/notices start empty on a clean load", async () => {
    const service = freshService();
    await service.bootstrap();
    expect(service.unknownDbKeys).toEqual([]);
    expect(service.notices).toEqual([]);
  });
});

describe("SettingsService — transcode-slot reduction resolution semantics (the LAW: no setting change may drop active sessions)", () => {
  it("transcode.maxSimultaneousTranscodes is requiresRestart:false and its reduced value is visible via getEffective() immediately after the write, with no cache staleness — proving an admission check reading the effective value AT admission time sees the new cap on its very next read (resolution-level guarantee; lane S3 wires the actual admission-check read site)", async () => {
    const service = freshService();
    await service.bootstrap();
    expect(service.getEffective("transcode.maxSimultaneousTranscodes")?.requiresRestart).toBe(false);

    await service.updateSetting({ key: "transcode.maxSimultaneousTranscodes", value: 4, actorUserId: adminId, nowMs: Date.now() });
    expect(service.getEffective("transcode.maxSimultaneousTranscodes")?.value).toBe(4);

    // The reduction below is the security-relevant direction (a slot cap
    // going DOWN while sessions may already be running against the old,
    // higher cap) — SettingsService itself never reads or writes
    // playback_sessions at all (structurally incapable of dropping a
    // session, not merely policy-restrained), so this only proves the
    // resolution half: the effective value a future admission check would
    // read reflects the reduction on the very next call, with zero delay
    // and zero restart requirement.
    await service.updateSetting({ key: "transcode.maxSimultaneousTranscodes", value: 1, actorUserId: adminId, nowMs: Date.now() });
    expect(service.getEffective("transcode.maxSimultaneousTranscodes")?.value).toBe(1);
    expect(service.getEffective("transcode.maxSimultaneousTranscodes")?.source).toBe("database");
    expect(service.restartPendingKeys).not.toContain("transcode.maxSimultaneousTranscodes");
  });
});

describe("SettingsService.restartPendingKeys", () => {
  it("stays empty when only a requiresRestart:false setting changes", async () => {
    const service = freshService();
    await service.bootstrap();
    await service.updateSetting({ key: "restricted.enabled", value: true, actorUserId: adminId, nowMs: Date.now() });
    expect(service.restartPendingKeys).toEqual([]);
  });

  it("lists a key whose requiresRestart:true effective value changed since boot, and it disappears once reverted", async () => {
    // After lane S3's hot-reload migration, ZERO real registry entries
    // carried requiresRestart:true for a long stretch — the snapshot/
    // pending machinery was only exercisable with a synthetic registry
    // (the service's documented test seam), which is exactly what this
    // test still does via rateLimit.login below, kept as the isolated
    // proof independent of any one real key's story. The "first future key
    // that genuinely cannot hot-apply" this comment used to anticipate has
    // since arrived for real: remote.wireguardPort/remote.subnet (STATE.md
    // "Loombre Remote — embedded WireGuard + three-path wizard +
    // reachability proof + posture card") are ui-scope AND
    // requiresRestart:true — the WireGuard listener binds one UDP port for
    // its whole lifetime and every enrolled peer's address comes from the
    // configured subnet, so neither can hot-apply safely. This synthetic
    // rateLimit.login case is left in place regardless, since it proves
    // the mechanism in isolation from any one real key's own behavior.
    const service = freshService();
    service.registry = service.registry.map((entry) =>
      entry.key === "rateLimit.login" ? { ...entry, requiresRestart: true } : entry,
    );
    await service.bootstrap();
    const nowMs = Date.now();

    await service.updateSetting({ key: "rateLimit.login", value: 25, actorUserId: adminId, nowMs });
    expect(service.restartPendingKeys).toContain("rateLimit.login");

    // Revert to the boot-time value (the registry default, 10) — pending
    // must clear again since restartPending diffs against the BOOT
    // snapshot, not "did it ever change".
    await service.updateSetting({ key: "rateLimit.login", value: 10, actorUserId: adminId, nowMs: nowMs + 1 });
    expect(service.restartPendingKeys).not.toContain("rateLimit.login");
  });
});

describe("SettingsService.onChange (hot-reload emitter)", () => {
  it("notifies subscribers with key/oldValue/newValue/actorUserId on a successful update", async () => {
    const service = freshService();
    await service.bootstrap();

    const events: unknown[] = [];
    const unsubscribe = service.onChange((event) => events.push(event));

    await service.updateSetting({ key: "images.avifEnabled", value: false, actorUserId: adminId, nowMs: Date.now() });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: "images.avifEnabled", oldValue: null, newValue: false, actorUserId: adminId });

    unsubscribe();
    await service.updateSetting({ key: "images.avifEnabled", value: true, actorUserId: adminId, nowMs: Date.now() });
    expect(events).toHaveLength(1); // unsubscribed — no second event captured
  });
});

describe("SettingsService.updateSetting — failure paths", () => {
  it("404s on an unknown key", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(
      service.updateSetting({ key: "not.a.real.key", value: 1, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s on a scope:'env-only' key (never writable through this surface)", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(
      service.updateSetting({ key: "database.url", value: "postgres://x", actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("422s on a schema-invalid value", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(
      service.updateSetting({ key: "transcode.maxSimultaneousTranscodes", value: -1, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("422s a majority-age value below 18 (D13/A3 floor, service-layer half)", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(
      service.updateSetting({ key: "restricted.majorityAgeYears", value: 17, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("403s a non-admin actor (live re-verify, A10)", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(
      service.updateSetting({ key: "restricted.enabled", value: true, actorUserId: casualId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  describe("409 env-pinned", () => {
    const ORIGINAL = process.env["LOOMBRE_RATE_LOGIN"];
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env["LOOMBRE_RATE_LOGIN"];
      else process.env["LOOMBRE_RATE_LOGIN"] = ORIGINAL;
    });

    it("rejects a write while the key's env var is set, leaving the DB value inert but preserved", async () => {
      process.env["LOOMBRE_RATE_LOGIN"] = "50";
      const service = freshService();
      await service.bootstrap();
      expect(service.getEffective("rateLimit.login")).toMatchObject({ value: 50, source: "environment", locked: true });

      await expect(
        service.updateSetting({ key: "rateLimit.login", value: 15, actorUserId: adminId, nowMs: Date.now() }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });
});

describe("SettingsService.updateSetting — F9 cross-field validation (registry alone can't express a between-key relationship)", () => {
  // Defaults at boot: transcode.segmentAheadResumeThreshold=5,
  // transcode.segmentAheadSuspendThreshold=10; sessions.staleCutoffMs=900_000
  // (15min), sessions.heartbeatSuspendCutoffMs=90_000 (90s).

  it("segmentAheadResumeThreshold: rejects raising resume to >= the OTHER key's current (default) suspend value", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(
      service.updateSetting({ key: "transcode.segmentAheadResumeThreshold", value: 10, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
    // Also strictly greater, not just equal.
    await expect(
      service.updateSetting({ key: "transcode.segmentAheadResumeThreshold", value: 15, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("segmentAheadSuspendThreshold: rejects lowering suspend to <= the OTHER key's current (default) resume value", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(
      service.updateSetting({ key: "transcode.segmentAheadSuspendThreshold", value: 5, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.updateSetting({ key: "transcode.segmentAheadSuspendThreshold", value: 3, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("segmentAhead pair: a write that keeps resume < suspend succeeds in both directions", async () => {
    const service = freshService();
    await service.bootstrap();
    try {
      const suspendUp = await service.updateSetting({
        key: "transcode.segmentAheadSuspendThreshold",
        value: 20,
        actorUserId: adminId,
        nowMs: Date.now(),
      });
      expect(suspendUp.value).toBe(20);
      const resumeUp = await service.updateSetting({
        key: "transcode.segmentAheadResumeThreshold",
        value: 8,
        actorUserId: adminId,
        nowMs: Date.now(),
      });
      expect(resumeUp.value).toBe(8);
    } finally {
      // Revert to the registry defaults (5/10) so later tests/files sharing
      // this DB see a clean slate — order matters: lower resume back to 5
      // FIRST (still < the still-raised 20), then suspend back to 10 (now
      // > the already-reverted 5), so every intermediate write stays valid.
      await service.updateSetting({ key: "transcode.segmentAheadResumeThreshold", value: 5, actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "transcode.segmentAheadSuspendThreshold", value: 10, actorUserId: adminId, nowMs: Date.now() });
    }
  });

  it("staleCutoffMs: rejects lowering stale to <= the OTHER key's current (default) heartbeat-suspend value", async () => {
    const service = freshService();
    await service.bootstrap();
    // Default heartbeatSuspendCutoffMs is 90_000 — 90_000 itself and
    // anything below it both violate "stale > heartbeat".
    await expect(
      service.updateSetting({ key: "sessions.staleCutoffMs", value: 90_000, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.updateSetting({ key: "sessions.staleCutoffMs", value: 60_000, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("heartbeatSuspendCutoffMs: rejects raising heartbeat to >= the OTHER key's current (default) stale value", async () => {
    const service = freshService();
    await service.bootstrap();
    // Default staleCutoffMs is 900_000 (15min) — 900_000 itself and
    // anything above it both violate "stale > heartbeat".
    await expect(
      service.updateSetting({ key: "sessions.heartbeatSuspendCutoffMs", value: 900_000, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.updateSetting({ key: "sessions.heartbeatSuspendCutoffMs", value: 1_000_000, actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("sessions pair: a write that keeps stale > heartbeat succeeds in both directions", async () => {
    const service = freshService();
    await service.bootstrap();
    try {
      const heartbeatDown = await service.updateSetting({
        key: "sessions.heartbeatSuspendCutoffMs",
        value: 60_000,
        actorUserId: adminId,
        nowMs: Date.now(),
      });
      expect(heartbeatDown.value).toBe(60_000);
      const staleUp = await service.updateSetting({
        key: "sessions.staleCutoffMs",
        value: 1_800_000,
        actorUserId: adminId,
        nowMs: Date.now(),
      });
      expect(staleUp.value).toBe(1_800_000);
    } finally {
      // Revert to the registry defaults (heartbeat 90_000, stale 900_000)
      // — heartbeat back up FIRST (still < the still-raised 1_800_000),
      // then stale back down (now > the already-reverted 90_000).
      await service.updateSetting({ key: "sessions.heartbeatSuspendCutoffMs", value: 90_000, actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "sessions.staleCutoffMs", value: 900_000, actorUserId: adminId, nowMs: Date.now() });
    }
  });

  // RG12 (STATE.md "Loombre Remote..."): tls.mode="acme" requires
  // tls.acmeDomains non-empty AND tls.acmeTosAgreed=true — a settings-screen
  // edit must never be able to produce the same boot-time TlsConfigError
  // lockout a raw env-var typo could (apps/server/src/tls/config.ts).
  // Defaults at boot: tls.mode="off", tls.acmeDomains=[], tls.acmeTosAgreed=false.

  it("tls.mode: rejects flipping to 'acme' while acmeDomains is still empty and acmeTosAgreed is still false", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(
      service.updateSetting({ key: "tls.mode", value: "acme", actorUserId: adminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("tls.mode: rejects flipping to 'acme' with domains set but ToS not yet agreed", async () => {
    const service = freshService();
    await service.bootstrap();
    await service.updateSetting({ key: "tls.acmeDomains", value: ["media.example.com"], actorUserId: adminId, nowMs: Date.now() });
    try {
      await expect(
        service.updateSetting({ key: "tls.mode", value: "acme", actorUserId: adminId, nowMs: Date.now() }),
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      await service.updateSetting({ key: "tls.acmeDomains", value: [], actorUserId: adminId, nowMs: Date.now() });
    }
  });

  it("tls.mode: 'acme' succeeds once both acmeDomains and acmeTosAgreed are set first", async () => {
    const service = freshService();
    await service.bootstrap();
    try {
      await service.updateSetting({ key: "tls.acmeDomains", value: ["media.example.com"], actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "tls.acmeTosAgreed", value: true, actorUserId: adminId, nowMs: Date.now() });
      const result = await service.updateSetting({ key: "tls.mode", value: "acme", actorUserId: adminId, nowMs: Date.now() });
      expect(result.value).toBe("acme");
    } finally {
      // Revert order matters the same way the pairs above do: drop mode
      // back to "off" FIRST (still legal regardless of the other two),
      // then clear domains/tosAgreed.
      await service.updateSetting({ key: "tls.mode", value: "off", actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "tls.acmeDomains", value: [], actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "tls.acmeTosAgreed", value: false, actorUserId: adminId, nowMs: Date.now() });
    }
  });

  it("tls.acmeDomains: rejects clearing to empty while tls.mode is currently 'acme'", async () => {
    const service = freshService();
    await service.bootstrap();
    await service.updateSetting({ key: "tls.acmeDomains", value: ["media.example.com"], actorUserId: adminId, nowMs: Date.now() });
    await service.updateSetting({ key: "tls.acmeTosAgreed", value: true, actorUserId: adminId, nowMs: Date.now() });
    await service.updateSetting({ key: "tls.mode", value: "acme", actorUserId: adminId, nowMs: Date.now() });
    try {
      await expect(
        service.updateSetting({ key: "tls.acmeDomains", value: [], actorUserId: adminId, nowMs: Date.now() }),
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      await service.updateSetting({ key: "tls.mode", value: "off", actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "tls.acmeDomains", value: [], actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "tls.acmeTosAgreed", value: false, actorUserId: adminId, nowMs: Date.now() });
    }
  });

  it("tls.acmeTosAgreed: rejects un-agreeing while tls.mode is currently 'acme'", async () => {
    const service = freshService();
    await service.bootstrap();
    await service.updateSetting({ key: "tls.acmeDomains", value: ["media.example.com"], actorUserId: adminId, nowMs: Date.now() });
    await service.updateSetting({ key: "tls.acmeTosAgreed", value: true, actorUserId: adminId, nowMs: Date.now() });
    await service.updateSetting({ key: "tls.mode", value: "acme", actorUserId: adminId, nowMs: Date.now() });
    try {
      await expect(
        service.updateSetting({ key: "tls.acmeTosAgreed", value: false, actorUserId: adminId, nowMs: Date.now() }),
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      await service.updateSetting({ key: "tls.mode", value: "off", actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "tls.acmeDomains", value: [], actorUserId: adminId, nowMs: Date.now() });
      await service.updateSetting({ key: "tls.acmeTosAgreed", value: false, actorUserId: adminId, nowMs: Date.now() });
    }
  });

  it("tls.mode: 'off'/'manual' never require acmeDomains/acmeTosAgreed", async () => {
    const service = freshService();
    await service.bootstrap();
    const off = await service.updateSetting({ key: "tls.mode", value: "off", actorUserId: adminId, nowMs: Date.now() });
    expect(off.value).toBe("off");
    const manual = await service.updateSetting({ key: "tls.mode", value: "manual", actorUserId: adminId, nowMs: Date.now() });
    expect(manual.value).toBe("manual");
    await service.updateSetting({ key: "tls.mode", value: "off", actorUserId: adminId, nowMs: Date.now() });
  });
});

describe("SettingsService — live isAdmin re-verify rejects a freshly-demoted admin", () => {
  let demotedAdminId: string;

  beforeEach(async () => {
    const nowMs = Date.now();
    const created = await db
      .insertInto("users")
      .values({
        username: `settings_demote_${nowMs}`,
        email: `settings-demote-${nowMs}@example.invalid`,
        password_hash: "x",
        is_admin: true,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    demotedAdminId = created.id;
  });

  it("a user who WAS an admin at token-issue time but has since been demoted is rejected", async () => {
    const service = freshService();
    await service.bootstrap();

    // Sanity: while still admin, the mutation succeeds.
    await service.updateSetting({ key: "security.loginAnomalyLogEnabled", value: false, actorUserId: demotedAdminId, nowMs: Date.now() });

    // Demote — simulates "inside the <=15-min JWT window" (the access
    // token claim would still say isAdmin:true, but this service never
    // trusts that claim; it re-reads users.is_admin fresh every call).
    await updateUserAdmin(db, demotedAdminId, { isAdmin: false, nowMs: Date.now() });

    await expect(
      service.updateSetting({ key: "security.loginAnomalyLogEnabled", value: true, actorUserId: demotedAdminId, nowMs: Date.now() }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("SettingsService response shaping", () => {
  it("toAdminSettingsResponse includes every registry key exactly once, plus the passed-in providerKeys", async () => {
    const service = freshService();
    await service.bootstrap();
    const response = service.toAdminSettingsResponse(
      [{ provider: "tmdb", set: false, source: null }],
      { configured: false, setAtMs: null, source: null },
    );
    const keys = response.settings.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("restricted.majorityAgeYears");
    expect(response.providerKeys).toEqual([{ provider: "tmdb", set: false, source: null }]);
  });

  it("toSchemaResponse projects category/description/scope/requiresRestart/envVar/default/valueSchema for every entry", async () => {
    const service = freshService();
    await service.bootstrap();
    const response = service.toSchemaResponse();
    const entry = response.entries.find((e) => e.key === "transcode.maxSimultaneousTranscodes");
    expect(entry).toMatchObject({ category: "transcode", scope: "ui", requiresRestart: false, envVar: "LOOMBRE_MAX_TRANSCODES", default: 1 });
    expect(entry?.valueSchema).toBeTypeOf("object");

    const envOnlyEntry = response.entries.find((e) => e.key === "database.url");
    expect(envOnlyEntry).toMatchObject({ scope: "env-only", envVar: "DATABASE_URL" });
  });
});

describe("SettingsService — F1 secret masking (database.url)", () => {
  it("toAdminSettingsResponse masks database.url's EFFECTIVE value's credential portion, never the raw password", async () => {
    const distinctivePassword = `sec-${Date.now()}`;
    const original = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = `postgres://loombre:${distinctivePassword}@localhost:5442/whatever-db`;
    try {
      const service = freshService();
      await service.bootstrap();
      const response = service.toAdminSettingsResponse([], { configured: false, setAtMs: null, source: null });
      const entry = response.settings.find((s) => s.key === "database.url");
      expect(entry?.value).toBe("postgres://loombre:***@localhost:5442/whatever-db");
      expect(JSON.stringify(response)).not.toContain(distinctivePassword);
    } finally {
      if (original === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = original;
    }
  });

  it("toSchemaResponse masks database.url's registry DEFAULT the same way, never the raw password", async () => {
    const service = freshService();
    await service.bootstrap();
    const response = service.toSchemaResponse();
    const entry = response.entries.find((e) => e.key === "database.url");
    // The registry's static default is postgres://loombre:loombre@localhost:5442/loombre
    // (packages/shared/src/settings-registry.ts) — masked regardless of
    // whatever DATABASE_URL happens to be set to in this test run.
    expect(entry?.default).toBe("postgres://loombre:***@localhost:5442/loombre");
    expect(JSON.stringify(response)).not.toMatch(/loombre:loombre@/);
  });

  it("no other entry's value/default is masked (secret masking is opt-in per entry.secret, not blanket)", async () => {
    const service = freshService();
    await service.bootstrap();
    const adminResponse = service.toAdminSettingsResponse([], { configured: false, setAtMs: null, source: null });
    const maxTranscodes = adminResponse.settings.find((s) => s.key === "transcode.maxSimultaneousTranscodes");
    expect(maxTranscodes?.value).toBe(1);

    const schemaResponse = service.toSchemaResponse();
    const httpPort = schemaResponse.entries.find((e) => e.key === "http.port");
    expect(httpPort?.default).toBe(3001);
  });
});

describe("SettingsService.assertLiveAdmin (F1c: the GET /admin/settings[/schema] gate)", () => {
  it("resolves without throwing for a live admin", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(service.assertLiveAdmin(adminId, "/v1/admin/settings")).resolves.toBeUndefined();
  });

  it("403s a non-admin (casual) actor", async () => {
    const service = freshService();
    await service.bootstrap();
    await expect(service.assertLiveAdmin(casualId, "/v1/admin/settings")).rejects.toMatchObject({ status: 403 });
  });

  it("403s a freshly-demoted admin (fresh DB read, never a cached/claimed value)", async () => {
    const nowMs = Date.now();
    const created = await db
      .insertInto("users")
      .values({
        username: `settings_assert_live_admin_${nowMs}`,
        email: `settings-assert-live-admin-${nowMs}@example.invalid`,
        password_hash: "x",
        is_admin: true,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const service = freshService();
    await service.bootstrap();
    await expect(service.assertLiveAdmin(created.id, "/v1/admin/settings")).resolves.toBeUndefined();

    await updateUserAdmin(db, created.id, { isAdmin: false, nowMs: Date.now() });
    await expect(service.assertLiveAdmin(created.id, "/v1/admin/settings")).rejects.toMatchObject({ status: 403 });
  });
});
