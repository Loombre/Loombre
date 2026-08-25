// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/admin-fix-match.e2e.spec.ts
//
// HTTP-level regression test for Fix Match (Phosphor retheme Wave 2, Lane
// L2): GET /admin/libraries/{id}/unmatched, POST /admin/items/{id}/
// match-search, POST /admin/items/{id}/apply-match. No worker runs in this
// suite — both POST endpoints only prove the ENQUEUE half (a real jobs
// ledger row of the right type/status); the worker-side consumers
// (metadata-search / metadata's forceRef branch) have their own live-DB
// integration coverage in apps/worker/test/metadata/.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed), same
// convention as libraries.e2e.spec.ts.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase, getUserByUsername, insertPluginAndEmit, setPluginEnabledAndEmit } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

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
let databaseUrl: string;
let rawDb: ReturnType<typeof createDb>;
let adminToken: string;
let moviesLibraryId: string;
let harborLightsItemId: string;
let episodeItemId: string; // not an enrichable type
// api-validation-F11 fixtures: one enabled + one disabled LPP plugin, so
// `lpp:<pluginId>` can be exercised in both states.
let enabledPluginId: string;
let disabledPluginId: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "admin-fix-match-e2e-test-secret-not-for-production";

  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_fix_match_e2e_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-fix-match-e2e",
    deviceProfile: buildDeviceProfile("admin-fix-match-e2e"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const libraries = await request(app.getHttpServer())
    .get("/libraries?limit=200")
    .set("Authorization", `Bearer ${adminToken}`);
  moviesLibraryId = libraries.body.items.find((l: { name: string }) => l.name === "Movies").id;

  const movies = await request(app.getHttpServer())
    .get(`/movies?library=${moviesLibraryId}&limit=200`)
    .set("Authorization", `Bearer ${adminToken}`);
  harborLightsItemId = movies.body.items.find((m: { title: string }) => m.title === "Harbor Lights").id;

  const series = await request(app.getHttpServer()).get("/series?limit=1").set("Authorization", `Bearer ${adminToken}`);
  const seriesId: string = series.body.items[0].id;
  const seasons = await request(app.getHttpServer())
    .get(`/series/${seriesId}/seasons`)
    .set("Authorization", `Bearer ${adminToken}`);
  const seasonId: string = seasons.body.items[0].id;
  const episodes = await request(app.getHttpServer())
    .get(`/seasons/${seasonId}/episodes`)
    .set("Authorization", `Bearer ${adminToken}`);
  episodeItemId = episodes.body.items[0].id;

  // api-validation-F11: raw handle for the "no job row was enqueued"
  // assertions + the two plugin fixtures.
  rawDb = createDb(databaseUrl);
  const admin = await getUserByUsername(rawDb, "admin");
  const adminId: string = admin!.id;
  const nowMs = Date.now();
  const manifest = { name: "fix-match-e2e", version: "0.1.0", protocolVersion: 1, capabilities: [{ type: "metadata-provider" }] };

  enabledPluginId = "018f6f1e-0000-7000-8000-00000000f110";
  await insertPluginAndEmit(rawDb, {
    id: enabledPluginId,
    name: "fix-match-e2e-enabled",
    baseUrl: "http://127.0.0.1:59991",
    version: "0.1.0",
    protocolVersion: 1,
    contentClass: "general",
    grantedCapabilityTypes: ["metadata-provider"],
    eventTypes: [],
    lanAllowlist: ["127.0.0.1"],
    manifest,
    config: {},
    actorUserId: adminId,
    nowMs,
  });

  disabledPluginId = "018f6f1e-0000-7000-8000-00000000f111";
  await insertPluginAndEmit(rawDb, {
    id: disabledPluginId,
    name: "fix-match-e2e-disabled",
    baseUrl: "http://127.0.0.1:59992",
    version: "0.1.0",
    protocolVersion: 1,
    contentClass: "general",
    grantedCapabilityTypes: ["metadata-provider"],
    eventTypes: [],
    lanAllowlist: ["127.0.0.1"],
    manifest,
    config: {},
    actorUserId: adminId,
    nowMs,
  });
  await setPluginEnabledAndEmit(rawDb, { pluginId: disabledPluginId, enabled: false, reason: "admin", actorUserId: adminId, nowMs });
}, 30_000);

afterAll(async () => {
  await app.close();
  await rawDb?.destroy();
});

describe("GET /admin/libraries/{id}/unmatched (Phosphor retheme Wave 2, Lane L2)", () => {
  it("lists a seeded movie with no provider_ids row, shaped per contract", async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/libraries/${moviesLibraryId}/unmatched`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = res.body.items.find((r: { itemId: string }) => r.itemId === harborLightsItemId);
    expect(row).toBeDefined();
    expect(row.itemType).toBe("movie");
    expect(row.title).toBe("Harbor Lights");
    expect(typeof row.filePath).toBe("string");
    expect(res.body).toHaveProperty("nextCursor");
  });

  it("404s for a library that does not exist", async () => {
    const res = await request(app.getHttpServer())
      .get("/admin/libraries/11111111-1111-4111-8111-111111111111/unmatched")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/items/{id}/match-search (Phosphor retheme Wave 2, Lane L2)", () => {
  it("enqueues a real 'metadata-search' job and returns its id", async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/items/${harborLightsItemId}/match-search`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(typeof res.body.jobId).toBe("string");

    const job = await request(app.getHttpServer())
      .get(`/admin/jobs/${res.body.jobId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(job.status).toBe(200);
    expect(job.body.type).toBe("metadata-search");
    expect(["queued", "active"]).toContain(job.body.status);
  });

  it("404s for an item that is not an enrichable type (episode)", async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/items/${episodeItemId}/match-search`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("404s for an item that does not exist", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/items/11111111-1111-4111-8111-111111111111/match-search")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/items/{id}/apply-match (Phosphor retheme Wave 2, Lane L2)", () => {
  it("enqueues a real 'metadata' job carrying forceRef, and returns its id", async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/items/${harborLightsItemId}/apply-match`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ provider: "tmdb", externalId: "603" });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(typeof res.body.jobId).toBe("string");

    const job = await request(app.getHttpServer())
      .get(`/admin/jobs/${res.body.jobId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(job.status).toBe(200);
    expect(job.body.type).toBe("metadata");
    expect(["queued", "active"]).toContain(job.body.status);
  });

  it("422s a real item with a missing provider field", async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/items/${harborLightsItemId}/apply-match`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ externalId: "603" });
    expect(res.status).toBe(422);
  });

  it("404s before body validation for an item that does not exist", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/items/11111111-1111-4111-8111-111111111111/apply-match")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────
// api-validation-F11: provider is validated against the REAL resolvable
// set (built-in ProviderRegistry names + `lpp:<pluginId>` for a plugin
// that EXISTS and is ENABLED). Before this, ANY string was accepted with
// a 202 and the resulting 'metadata' job completed as a silent no-op
// (apps/worker/src/metadata/consumer.ts:140-142 — `registry.get(name)`
// misses, logs "not registered or disabled", skips), so the admin got a
// success signal for a request that could never do anything.
// ──────────────────────────────────────────────────────────────────────
describe("POST /admin/items/{id}/apply-match — provider validation (api-validation-F11)", () => {
  async function countMetadataJobsForHarborLights(): Promise<number> {
    const row = await rawDb
      .selectFrom("jobs")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("type", "=", "metadata")
      .where("subject_item_id", "=", harborLightsItemId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async function applyMatch(provider: string) {
    return request(app.getHttpServer())
      .post(`/admin/items/${harborLightsItemId}/apply-match`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ provider, externalId: "603" });
  }

  it.each(["bogus-provider", "TMDB", "tmdb ", "lpp", "not-a-provider"])(
    "422s an unresolvable provider %j, names the field, and enqueues NO job",
    async (provider) => {
      const before = await countMetadataJobsForHarborLights();
      const res = await applyMatch(provider);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.type).toBe("urn:loombre:problem:validation");
      expect(res.body.detail).toContain("provider");
      expect(await countMetadataJobsForHarborLights()).toBe(before);
    },
  );

  it.each(["tmdb", "tvdb", "musicbrainz", "stash"])("still 202s built-in provider %j", async (provider) => {
    const before = await countMetadataJobsForHarborLights();
    const res = await applyMatch(provider);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(typeof res.body.jobId).toBe("string");
    expect(await countMetadataJobsForHarborLights()).toBe(before + 1);
  });

  it("202s an lpp:<pluginId> whose plugin exists and is enabled", async () => {
    const before = await countMetadataJobsForHarborLights();
    const res = await applyMatch(`lpp:${enabledPluginId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(await countMetadataJobsForHarborLights()).toBe(before + 1);
  });

  it("422s an lpp:<pluginId> whose plugin is DISABLED", async () => {
    const before = await countMetadataJobsForHarborLights();
    const res = await applyMatch(`lpp:${disabledPluginId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.detail).toContain("provider");
    expect(await countMetadataJobsForHarborLights()).toBe(before);
  });

  it("422s an lpp:<pluginId> that does not exist", async () => {
    const before = await countMetadataJobsForHarborLights();
    const res = await applyMatch("lpp:11111111-1111-4111-8111-111111111111");
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await countMetadataJobsForHarborLights()).toBe(before);
  });

  // A non-UUID plugin id must never reach the `plugins.id uuid` column —
  // Postgres's implicit cast would throw and surface as a bare 500 (the
  // exact failure mode require-uuid-param.ts exists to prevent).
  it.each(["lpp:", "lpp:not-a-uuid", "lpp:../../etc/passwd"])(
    "422s the malformed plugin ref %j (never a 500)",
    async (provider) => {
      const before = await countMetadataJobsForHarborLights();
      const res = await applyMatch(provider);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await countMetadataJobsForHarborLights()).toBe(before);
    },
  );

  it("checks the item's existence BEFORE the provider — 404 still wins over 422", async () => {
    const res = await request(app.getHttpServer())
      .post("/admin/items/11111111-1111-4111-8111-111111111111/apply-match")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ provider: "bogus-provider", externalId: "603" });
    expect(res.status).toBe(404);
  });
});
