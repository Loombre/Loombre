// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/admin-settings.e2e.spec.ts
//
// STATE.md Addendum A, decision A6 (lane S2): HTTP-level proof for the
// admin settings surface this lane wires — GET /admin/settings, GET
// /admin/settings/schema, PUT /admin/settings/{key}, PUT/DELETE
// /admin/provider-keys/{provider}. The underlying rules (check ordering,
// precedence math, redaction) are already proven directly against
// SettingsService/ProviderKeysService in settings.service.spec.ts and
// provider-keys.service.spec.ts (lane S1) — this file proves the WIRE-UP:
// routing, status codes, response shapes, and the two env-pin fixtures
// (rateLimit.login / LOOMBRE_TVDB_API_KEY) that only make sense to exercise
// against a real booted app whose SettingsService.bootstrap() actually ran
// against a real environment.
//
// Env pins are set BEFORE app.init() (SettingsService's cache is seeded at
// OnApplicationBootstrap and only refreshed by a later reload() — see
// settings.service.ts's header) so the whole file shares one pinned
// environment: LOOMBRE_RATE_LOGIN=50 (a 'ui' key with an envVar) and
// LOOMBRE_TVDB_API_KEY (a provider key) are both pinned for every test below
// — happy-path mutation tests below deliberately avoid touching
// rateLimit.login / the tvdb provider so they don't collide with the
// dedicated 409/env-source assertions.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed).

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { SettingsService } from "../src/settings/settings.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
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

let app: INestApplication;
let adminToken: string;
let casualToken: string;
let dataDir: string;

const ORIGINAL_RATE_LOGIN = process.env["LOOMBRE_RATE_LOGIN"];
const ORIGINAL_TVDB_KEY = process.env["LOOMBRE_TVDB_API_KEY"];
const ORIGINAL_TMDB_KEY = process.env["LOOMBRE_TMDB_API_KEY"];
const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_settings_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "admin-settings-test-secret-not-for-production";

  // file0600 (deterministic, side-effect-free — writes under a throwaway
  // data dir instead of touching a real OS credential store), same
  // established convention as provider-keys.service.spec.ts.
  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-admin-settings-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;
  delete process.env["LOOMBRE_TMDB_API_KEY"];

  // Env pins, set BEFORE app.init() so SettingsService's boot-time
  // bootstrap() resolves them as active — see this file's header.
  process.env["LOOMBRE_RATE_LOGIN"] = "50";
  process.env["LOOMBRE_TVDB_API_KEY"] = "env-supplied-tvdb-key";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-settings-test-admin",
    deviceProfile: buildDeviceProfile("admin-settings-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "admin-settings-test-casual",
    deviceProfile: buildDeviceProfile("admin-settings-test-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_RATE_LOGIN === undefined) delete process.env["LOOMBRE_RATE_LOGIN"];
  else process.env["LOOMBRE_RATE_LOGIN"] = ORIGINAL_RATE_LOGIN;
  if (ORIGINAL_TVDB_KEY === undefined) delete process.env["LOOMBRE_TVDB_API_KEY"];
  else process.env["LOOMBRE_TVDB_API_KEY"] = ORIGINAL_TVDB_KEY;
  if (ORIGINAL_TMDB_KEY === undefined) delete process.env["LOOMBRE_TMDB_API_KEY"];
  else process.env["LOOMBRE_TMDB_API_KEY"] = ORIGINAL_TMDB_KEY;
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

/** Small per-caller HTTP helper (same shape as seeded-conformance.spec.ts's callerFor). */
function callerFor(token: string) {
  const server = () => app.getHttpServer();
  return {
    get: (url: string) => request(server()).get(url).set("Authorization", `Bearer ${token}`),
    put: (url: string, body?: unknown) => {
      const req = request(server()).put(url).set("Authorization", `Bearer ${token}`);
      return body === undefined ? req : req.send(body as Record<string, unknown>);
    },
    delete: (url: string) => request(server()).delete(url).set("Authorization", `Bearer ${token}`),
    post: (url: string, body?: unknown) => {
      const req = request(server()).post(url).set("Authorization", `Bearer ${token}`);
      return body === undefined ? req : req.send(body as Record<string, unknown>);
    },
    patch: (url: string, body?: unknown) => {
      const req = request(server()).patch(url).set("Authorization", `Bearer ${token}`);
      return body === undefined ? req : req.send(body as Record<string, unknown>);
    },
  };
}
function asAdmin() {
  return callerFor(adminToken);
}
function asCasual() {
  return callerFor(casualToken);
}

describe("GET /admin/settings", () => {
  it("403s for a non-admin (casual) token", async () => {
    const res = await asCasual().get("/admin/settings");
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("200s for admin: every registry key present once, restartPendingKeys empty at boot, providerKeys shaped and env-vs-keyring correct", async () => {
    const res = await asAdmin().get("/admin/settings");
    expect(res.status).toBe(200);

    const keys = res.body.settings.map((s: { key: string }) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("restricted.majorityAgeYears");
    expect(keys).toContain("database.url"); // env-only entries are included, read-only

    const majorityAge = res.body.settings.find((s: { key: string }) => s.key === "restricted.majorityAgeYears");
    expect(majorityAge).toMatchObject({ value: 18, source: "default", requiresRestart: false, locked: false });

    // The env pin set in beforeAll is reflected immediately (boot-time
    // resolution, no mutation needed to observe it).
    const rateLogin = res.body.settings.find((s: { key: string }) => s.key === "rateLimit.login");
    expect(rateLogin).toMatchObject({ value: 50, source: "environment", locked: true, lockedBy: "LOOMBRE_RATE_LOGIN" });

    expect(res.body.providerKeys).toEqual(
      expect.arrayContaining([
        { provider: "tmdb", set: false, source: null },
        { provider: "tvdb", set: true, source: "env" },
      ]),
    );
  });

  it("F1: database.url's EFFECTIVE VALUE is masked — the connection string's password never appears on the wire", async () => {
    // Security review F1 (the headline finding): this endpoint used to
    // serve database.url's raw effective value, credential and all
    // ({"key":"database.url","value":"postgres://loombre:SUPERSECRETPASSWORD@..."}
    // in the review's PoC). Temporarily swaps in a distinctive password
    // purely for SettingsService's env-pin RESOLUTION of this one entry —
    // reload() re-reads process.env but never reconnects DbProvider's
    // already-open pool (apps/server/src/common/db.provider.ts constructs
    // its connection once, from the env at construction time), so this is
    // safe against the real DB backing every other assertion in this file.
    const settingsService = app.get(SettingsService);
    const originalDatabaseUrl = process.env["DATABASE_URL"];
    const distinctivePassword = `SUPERSECRET-${Date.now()}`;
    process.env["DATABASE_URL"] = `postgres://loombre:${distinctivePassword}@localhost:5442/does-not-need-to-connect`;
    try {
      await settingsService.reload();

      const res = await asAdmin().get("/admin/settings");
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(distinctivePassword);

      const dbEntry = res.body.settings.find((s: { key: string }) => s.key === "database.url");
      expect(dbEntry.value).toBe("postgres://loombre:***@localhost:5442/does-not-need-to-connect");
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = originalDatabaseUrl;
      await settingsService.reload();
    }
  });
});

describe("GET /admin/settings/schema", () => {
  it("403s for a non-admin (casual) token", async () => {
    const res = await asCasual().get("/admin/settings/schema");
    expect(res.status).toBe(403);
  });

  it("F1: database.url's registry DEFAULT is masked — never the raw credential, on this endpoint either", async () => {
    const res = await asAdmin().get("/admin/settings/schema");
    expect(res.status).toBe(200);
    const dbEntry = res.body.entries.find((e: { key: string }) => e.key === "database.url");
    expect(dbEntry.default).toBe("postgres://loombre:***@localhost:5442/loombre");
    expect(JSON.stringify(res.body)).not.toMatch(/loombre:loombre@/);
  });

  it("200s for admin: registry projection with category/description/scope/valueSchema/default, env-only and locked entries correctly flagged", async () => {
    const res = await asAdmin().get("/admin/settings/schema");
    expect(res.status).toBe(200);

    const entry = res.body.entries.find((e: { key: string }) => e.key === "transcode.maxSimultaneousTranscodes");
    expect(entry).toMatchObject({
      category: "transcode",
      scope: "ui",
      requiresRestart: false,
      envVar: "LOOMBRE_MAX_TRANSCODES",
      default: 2,
      locked: false,
    });
    expect(entry.valueSchema).toBeTypeOf("object");
    expect(entry.description.length).toBeGreaterThan(0);

    const envOnlyEntry = res.body.entries.find((e: { key: string }) => e.key === "database.url");
    expect(envOnlyEntry).toMatchObject({ scope: "env-only", envVar: "DATABASE_URL" });

    // Mirrors GET /admin/settings's locked projection for the SAME
    // env-pinned key, per AdminSettingSchemaEntry's own doc comment.
    const rateLoginEntry = res.body.entries.find((e: { key: string }) => e.key === "rateLimit.login");
    expect(rateLoginEntry).toMatchObject({ locked: true, lockedBy: "LOOMBRE_RATE_LOGIN" });

    // Schema carries no live value and no provider-key statuses at all.
    expect(entry.value).toBeUndefined();
    expect(res.body.providerKeys).toBeUndefined();
  });
});

describe("GET /admin/settings and GET /admin/settings/schema — F1c: live isAdmin re-verify (A10, promoted from claim-based requireAdmin)", () => {
  it("both GETs succeed while still admin, then both 403 the same (stale-claim) token after demotion", async () => {
    // Mirrors PUT /admin/settings/{key}'s own "live isAdmin re-verify"
    // test below — before F1c, these two GETs were gated by the WEAKER
    // req.user.isAdmin JWT claim alone, so a just-demoted admin's still-live
    // access token could keep reading database.url's effective value (the
    // Postgres password) for up to the token's remaining lifetime.
    const email = `admin-settings-get-demote-${Date.now()}@example.invalid`;
    const create = await asAdmin().post("/users", {
      username: `settings_get_demote_${Date.now()}`,
      email,
      password: "demote-me-password",
      isAdmin: true,
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const demotedUserId: string = create.body.id;

    const login = await request(app.getHttpServer()).post("/auth/login").send({
      email,
      password: "demote-me-password",
      deviceName: "admin-settings-get-demote-test",
      deviceProfile: buildDeviceProfile("admin-settings-get-demote-test"),
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const demotedToken: string = login.body.accessToken;
    const demoted = callerFor(demotedToken);

    // Sanity: while still admin, both GETs succeed.
    const settingsBefore = await demoted.get("/admin/settings");
    expect(settingsBefore.status, JSON.stringify(settingsBefore.body)).toBe(200);
    const schemaBefore = await demoted.get("/admin/settings/schema");
    expect(schemaBefore.status, JSON.stringify(schemaBefore.body)).toBe(200);

    // Demote via the seed admin's OWN token — the demoted user's access
    // token claim still says isAdmin:true (same <=15-min window as the PUT
    // test below), but assertLiveAdmin() never trusts that claim.
    const demote = await asAdmin().patch(`/users/${demotedUserId}`, { isAdmin: false });
    expect(demote.status, JSON.stringify(demote.body)).toBe(200);

    const settingsAfter = await demoted.get("/admin/settings");
    expect(settingsAfter.status).toBe(403);
    expect(settingsAfter.headers["content-type"]).toMatch(/^application\/problem\+json/);

    const schemaAfter = await demoted.get("/admin/settings/schema");
    expect(schemaAfter.status).toBe(403);
    expect(schemaAfter.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });
});

// V1-004 (audit fafa47f, Fix Wave 4 lane FW4-B): openapi.yaml declares 204
// for DELETE /users/{id} ("Deleted"); the handler had no @HttpCode and fell
// through to Nest's default 200. Before this, only the 404-against-a-
// nonexistent-id case existed (security-hardening.e2e.spec.ts /
// conformance.spec.ts's PLACEHOLDER_UUID walk) — the real success path had
// no coverage, so nothing caught the drift.
describe("DELETE /users/{id} (V1-004 regression)", () => {
  it("deletes a real user and answers 204 with no body; the user is gone afterward", async () => {
    const create = await asAdmin().post("/users", {
      username: `delete_me_${Date.now()}`,
      email: `delete-me-${Date.now()}@example.invalid`,
      password: "delete-me-password",
      isAdmin: false,
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const userId: string = create.body.id;

    const del = await asAdmin().delete(`/users/${userId}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    expect(del.text).toBe("");

    const getAfter = await asAdmin().get(`/users/${userId}`);
    expect(getAfter.status).toBe(404);
  });
});

describe("PUT /admin/settings/{key}", () => {
  it("403s for a non-admin (casual) token", async () => {
    const res = await asCasual().put("/admin/settings/images.avifQuality", { value: 60 });
    expect(res.status).toBe(403);
  });

  it("happy path: updates a ui-editable, no-restart key; echoes source:'database' + restartPending:false; visible on the next GET", async () => {
    const res = await asAdmin().put("/admin/settings/images.avifQuality", { value: 65 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ key: "images.avifQuality", value: 65, source: "database", requiresRestart: false, restartPending: false });

    const get = await asAdmin().get("/admin/settings");
    const entry = get.body.settings.find((s: { key: string }) => s.key === "images.avifQuality");
    expect(entry).toMatchObject({ value: 65, source: "database" });
  });

  it("scanner.concurrency is HOT after lane S3's migration: no restart-pending anywhere on the wire (A5)", async () => {
    // This test originally asserted requiresRestart:true/restartPending:
    // true — written against lane S1's conservative registry, before lane
    // S3's hot-reload migration flipped every remaining UI-editable key to
    // requiresRestart:false (the better end state: nothing left needs a
    // reboot). The wire shape is still exercised end-to-end here; the
    // restartPending:TRUE machinery is proven at the service level with a
    // synthetic registry entry (settings.service.spec.ts, the documented
    // test seam) since no real key can trigger it anymore.
    const res = await asAdmin().put("/admin/settings/scanner.concurrency", { value: 6 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ key: "scanner.concurrency", value: 6, source: "database", requiresRestart: false, restartPending: false });

    const get = await asAdmin().get("/admin/settings");
    expect(get.body.restartPendingKeys).toEqual([]);

    // Revert so later tests in this file see the default again — keeps
    // this file's tests order-independent on this shared axis.
    const revert = await asAdmin().put("/admin/settings/scanner.concurrency", { value: 2 });
    expect(revert.status).toBe(200);
  });

  it("404s on an unknown key", async () => {
    const res = await asAdmin().put("/admin/settings/not.a.real.key", { value: 1 });
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("404s on a scope:'env-only' key (never writable through this surface)", async () => {
    const res = await asAdmin().put("/admin/settings/database.url", { value: "postgres://x" });
    expect(res.status).toBe(404);
  });

  it("422s a schema-invalid value", async () => {
    const res = await asAdmin().put("/admin/settings/transcode.maxSimultaneousTranscodes", { value: -1 });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("422s restricted.majorityAgeYears below 18 (D13/A3 floor), surfaced cleanly at the wire", async () => {
    const res = await asAdmin().put("/admin/settings/restricted.majorityAgeYears", { value: 17 });
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain("18");
  });

  it("409s a write against an active env pin, leaving the submitted value discarded", async () => {
    const res = await asAdmin().put("/admin/settings/rateLimit.login", { value: 15 });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.detail).toContain("LOOMBRE_RATE_LOGIN");

    // The pin still wins on the next read — the submission never applied.
    const get = await asAdmin().get("/admin/settings");
    const entry = get.body.settings.find((s: { key: string }) => s.key === "rateLimit.login");
    expect(entry.value).toBe(50);
  });

  describe("live isAdmin re-verify (A10): a freshly-demoted admin is rejected mid-token-lifetime", () => {
    it("succeeds while still admin, then 403s the same (stale-claim) token after demotion", async () => {
      const email = `admin-settings-demote-${Date.now()}@example.invalid`;
      const create = await asAdmin().post("/users", {
        username: `settings_demote_${Date.now()}`,
        email,
        password: "demote-me-password",
        isAdmin: true,
      });
      expect(create.status, JSON.stringify(create.body)).toBe(201);
      const demotedUserId: string = create.body.id;

      const login = await request(app.getHttpServer()).post("/auth/login").send({
        email,
        password: "demote-me-password",
        deviceName: "admin-settings-demote-test",
        deviceProfile: buildDeviceProfile("admin-settings-demote-test"),
      });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      const demotedToken: string = login.body.accessToken;
      const demoted = callerFor(demotedToken);

      // Sanity: while still admin, the mutation succeeds.
      const before = await demoted.put("/admin/settings/security.loginAnomalyLogEnabled", { value: false });
      expect(before.status, JSON.stringify(before.body)).toBe(200);

      // Demote via the seed admin's OWN token — simulates "inside the
      // <=15-min JWT window" (the demoted user's access-token claim still
      // says isAdmin:true, but requireLiveAdmin never trusts that claim).
      const demote = await asAdmin().patch(`/users/${demotedUserId}`, { isAdmin: false });
      expect(demote.status, JSON.stringify(demote.body)).toBe(200);

      const after = await demoted.put("/admin/settings/security.loginAnomalyLogEnabled", { value: true });
      expect(after.status).toBe(403);
    });
  });
});

describe("PUT/DELETE /admin/provider-keys/{provider}", () => {
  it("403s for a non-admin (casual) token on both PUT and DELETE", async () => {
    const put = await asCasual().put("/admin/provider-keys/tmdb", { key: "x" });
    expect(put.status).toBe(403);
    const del = await asCasual().delete("/admin/provider-keys/tmdb");
    expect(del.status).toBe(403);
  });

  it("404s an unknown provider name for admin", async () => {
    const res = await asAdmin().put("/admin/provider-keys/spotify", { key: "x" });
    expect(res.status).toBe(404);
  });

  it("422s an empty/whitespace-only key", async () => {
    const res = await asAdmin().put("/admin/provider-keys/tmdb", { key: "   " });
    expect(res.status).toBe(422);
  });

  it("set/clear happy path: 204 with no body, GET /admin/settings reflects set:true/source:'keyring'/lastSetMs then set:false, the raw key is never echoed anywhere on the wire", async () => {
    const rawKey = "e2e-super-secret-tmdb-key-never-returned";
    const beforeMs = Date.now();
    const set = await asAdmin().put("/admin/provider-keys/tmdb", { key: rawKey });
    expect(set.status).toBe(204);
    expect(set.text).toBe("");
    expect(JSON.stringify(set.body ?? {})).not.toContain(rawKey);

    const afterSet = await asAdmin().get("/admin/settings");
    expect(afterSet.status).toBe(200);
    expect(JSON.stringify(afterSet.body)).not.toContain(rawKey);
    const tmdbStatus = afterSet.body.providerKeys.find((p: { provider: string }) => p.provider === "tmdb");
    expect(tmdbStatus.set).toBe(true);
    expect(tmdbStatus.source).toBe("keyring");
    expect(tmdbStatus.lastSetMs).toBeGreaterThanOrEqual(beforeMs);

    const clear = await asAdmin().delete("/admin/provider-keys/tmdb");
    expect(clear.status).toBe(204);
    expect(clear.text).toBe("");

    const afterClear = await asAdmin().get("/admin/settings");
    const tmdbAfterClear = afterClear.body.providerKeys.find((p: { provider: string }) => p.provider === "tmdb");
    expect(tmdbAfterClear).toEqual({ provider: "tmdb", set: false, source: null });
  });

  it("an env-sourced provider key (tvdb, pinned in beforeAll) reports source:'env' with no lastSetMs, and GET never returns the env value either", async () => {
    const res = await asAdmin().get("/admin/settings");
    const tvdbStatus = res.body.providerKeys.find((p: { provider: string }) => p.provider === "tvdb");
    expect(tvdbStatus).toEqual({ provider: "tvdb", set: true, source: "env" });
    expect(JSON.stringify(res.body)).not.toContain("env-supplied-tvdb-key");
  });

  it("F11a: PUT against an env-sourced provider key (tvdb, pinned in beforeAll) 409s instead of silently writing an inert keyring value", async () => {
    const res = await asAdmin().put("/admin/provider-keys/tvdb", { key: "an-attempted-keyring-override" });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.detail).toContain("LOOMBRE_TVDB_API_KEY");

    // The env pin still wins on the next read — the submission never took,
    // and status stays exactly what it was (still source:'env', no
    // lastSetMs — never flipped to keyring by the rejected write).
    const get = await asAdmin().get("/admin/settings");
    const tvdbStatus = get.body.providerKeys.find((p: { provider: string }) => p.provider === "tvdb");
    expect(tvdbStatus).toEqual({ provider: "tvdb", set: true, source: "env" });
  });
});
