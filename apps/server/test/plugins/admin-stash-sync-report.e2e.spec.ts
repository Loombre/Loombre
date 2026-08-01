// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/plugins/admin-stash-sync-report.e2e.spec.ts
//
// HTTP-level exit proof for GET /admin/libraries/{id}/stash-sync-report
// (packages/contract/openapi.yaml, STATE.md S8/K14, Stash SQLite metadata
// sync, Lane C sync engine) — apps/server/src/plugins/
// admin-stash-sync-report.{controller,service}.ts around
// packages/db/src/query/stash-sync-reports.ts. Mirrors
// admin-capabilities-crash-logs.e2e.spec.ts's lighter-weight convention
// (own ensureTestDatabase suffix, real NestFactory-booted AppModule,
// supertest, direct DB row seeding rather than spawning any child
// process).
//
// Covers: 403 for a non-admin token, 404 for an unknown library, the
// honest `{report: null}` envelope before any sync has ever run (with
// live-but-empty unmatched/stale lists), a real report round-trip after
// seeding a stash_sync_reports row, and unmatched/stale keyset pagination
// against stash_scene_links.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../../src/app.module.js";

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
let adminToken: string;
let casualToken: string;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "admin-stash-sync-report-test-secret-not-for-production";

  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_stash_sync_report_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-stash-sync-report-admin",
    deviceProfile: buildDeviceProfile("admin-stash-sync-report-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "admin-stash-sync-report-casual",
    deviceProfile: buildDeviceProfile("admin-stash-sync-report-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app.close();
});

async function makeRestrictedLibrary(name: string): Promise<string> {
  const db = createDb(databaseUrl);
  try {
    const now = Date.now();
    const row = await db
      .insertInto("libraries")
      .values({ name, media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row.id;
  } finally {
    await db.destroy();
  }
}

describe("GET /admin/libraries/{id}/stash-sync-report", () => {
  it("403s for a non-admin token", async () => {
    const libraryId = await makeRestrictedLibrary("stash-report-403-lib");
    const res = await request(app.getHttpServer())
      .get(`/admin/libraries/${libraryId}/stash-sync-report`)
      .set("Authorization", `Bearer ${casualToken}`);
    expect(res.status).toBe(403);
  });

  it("404s for an unknown library id", async () => {
    const res = await request(app.getHttpServer())
      .get("/admin/libraries/11111111-1111-4111-8111-111111111111/stash-sync-report")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("honest {report: null} envelope with live-but-empty scene/file lists before any sync has ever run", async () => {
    const libraryId = await makeRestrictedLibrary("stash-report-empty-lib");
    const res = await request(app.getHttpServer())
      .get(`/admin/libraries/${libraryId}/stash-sync-report`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      report: null,
      unmatchedScenes: { items: [], nextCursor: null },
      staleScenes: { items: [], nextCursor: null },
      // FX3 fix wave: unmatchedLoombreFiles is ALSO always-live (never
      // gated on a report existing), same posture as unmatchedScenes/
      // staleScenes above.
      unmatchedLoombreFiles: { items: [], nextCursor: null },
    });
  });

  it("real report round-trips, and live unmatched/stale scene lists reflect stash_scene_links directly", async () => {
    const libraryId = await makeRestrictedLibrary("stash-report-real-lib");
    const db = createDb(databaseUrl);
    try {
      const now = Date.now();
      const report = await db
        .insertInto("stash_sync_reports")
        .values({
          library_id: libraryId,
          job_id: "018f6f1e-0000-7000-8000-0000000000aa",
          mode: "full",
          status: "succeeded",
          matched_count: 5,
          updated_count: 2,
          unmatched_count: 1,
          stale_count: 1,
          skipped_count: 0,
          started_at_ms: now - 1000,
          finished_at_ms: now,
          // FX4 fix wave (migrations/0022, S2): this run's Stash connection
          // fell back to a snapshot copy.
          used_snapshot_fallback: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await db
        .insertInto("stash_scene_links")
        .values([
          {
            library_id: libraryId,
            stash_scene_id: "scene-unmatched-1",
            stash_path: "/stash/scene-unmatched-1.mp4",
            stash_oshash: null,
            stash_size_bytes: 100,
            stash_updated_at_ms: now,
            item_id: null,
            matched_by: null,
            stale: false,
            last_synced_at_ms: now,
          },
          {
            library_id: libraryId,
            stash_scene_id: "scene-stale-1",
            stash_path: "/stash/scene-stale-1.mp4",
            stash_oshash: null,
            stash_size_bytes: 200,
            stash_updated_at_ms: now,
            item_id: null,
            matched_by: null,
            stale: true,
            last_synced_at_ms: now,
          },
        ])
        .execute();

      const res = await request(app.getHttpServer())
        .get(`/admin/libraries/${libraryId}/stash-sync-report`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.report).toMatchObject({
        jobId: "018f6f1e-0000-7000-8000-0000000000aa",
        mode: "full",
        status: "succeeded",
        matchedCount: 5,
        updatedCount: 2,
        unmatchedCount: 1,
        staleCount: 1,
        skippedCount: 0,
        usedSnapshotFallback: true,
      });
      expect(res.body.report.finishedAtMs).toBe(report.finished_at_ms);
      // Both seeded rows have item_id: null, so BOTH are unmatched
      // (item_id IS NULL, S4) — scene-stale-1 is unmatched AND stale
      // simultaneously (a scene can be both at once; the two lists are
      // independent predicates, not mutually exclusive). Ordered by
      // stash_scene_id ASC: "scene-stale-1" < "scene-unmatched-1".
      expect(res.body.unmatchedScenes.items).toEqual([
        { stashSceneId: "scene-stale-1", stashPath: "/stash/scene-stale-1.mp4", stashUpdatedAtMs: now },
        { stashSceneId: "scene-unmatched-1", stashPath: "/stash/scene-unmatched-1.mp4", stashUpdatedAtMs: now },
      ]);
      expect(res.body.staleScenes.items).toEqual([{ stashSceneId: "scene-stale-1", stashPath: "/stash/scene-stale-1.mp4", stashUpdatedAtMs: now }]);
    } finally {
      await db.destroy();
    }
  });

  it("unmatchedScenes keyset pagination via unmatchedCursor", async () => {
    const libraryId = await makeRestrictedLibrary("stash-report-keyset-lib");
    const db = createDb(databaseUrl);
    try {
      const now = Date.now();
      await db
        .insertInto("stash_scene_links")
        .values(
          ["a1", "a2", "a3"].map((id) => ({
            library_id: libraryId,
            stash_scene_id: id,
            stash_path: `/stash/${id}.mp4`,
            stash_oshash: null,
            stash_size_bytes: 100,
            stash_updated_at_ms: now,
            item_id: null,
            matched_by: null,
            stale: false,
            last_synced_at_ms: now,
          })),
        )
        .execute();

      const page1 = await request(app.getHttpServer())
        .get(`/admin/libraries/${libraryId}/stash-sync-report`)
        .query({ limit: 2 })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(page1.status).toBe(200);
      expect(page1.body.unmatchedScenes.items.map((r: { stashSceneId: string }) => r.stashSceneId)).toEqual(["a1", "a2"]);
      expect(page1.body.unmatchedScenes.nextCursor).not.toBeNull();

      const page2 = await request(app.getHttpServer())
        .get(`/admin/libraries/${libraryId}/stash-sync-report`)
        .query({ limit: 2, unmatchedCursor: page1.body.unmatchedScenes.nextCursor })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(page2.status).toBe(200);
      expect(page2.body.unmatchedScenes.items.map((r: { stashSceneId: string }) => r.stashSceneId)).toEqual(["a3"]);
      expect(page2.body.unmatchedScenes.nextCursor).toBeNull();
    } finally {
      await db.destroy();
    }
  });

  it("FX3: unmatchedLoombreFiles — a library file without a link appears, and one with a link does not", async () => {
    const libraryId = await makeRestrictedLibrary("stash-report-unmatched-loombre-lib");
    const db = createDb(databaseUrl);
    try {
      const now = Date.now();

      const linkedItem = await db
        .insertInto("catalog_items")
        .values({ library_id: libraryId, item_type: "movie", title: "Linked Item", sort_title: "Linked Item", added_at_ms: now, updated_at_ms: now })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db.insertInto("media_files").values({ item_id: linkedItem.id, path: `/media/linked-${libraryId}.mp4`, size_bytes: 1000 }).execute();

      const unlinkedItem = await db
        .insertInto("catalog_items")
        .values({ library_id: libraryId, item_type: "movie", title: "Unlinked Item", sort_title: "Unlinked Item", added_at_ms: now, updated_at_ms: now })
        .returningAll()
        .executeTakeFirstOrThrow();
      const unlinkedFile = await db
        .insertInto("media_files")
        .values({ item_id: unlinkedItem.id, path: `/media/unlinked-${libraryId}.mp4`, size_bytes: 2000 })
        .returningAll()
        .executeTakeFirstOrThrow();

      // ONE stash_scene_links row, matched to the "linked" item — the
      // "unlinked" item has no stash_scene_links row pointing at it at all.
      await db
        .insertInto("stash_scene_links")
        .values({
          library_id: libraryId,
          stash_scene_id: "scene-matched-1",
          stash_path: "/stash/scene-matched-1.mp4",
          stash_oshash: null,
          stash_size_bytes: 1000,
          stash_updated_at_ms: now,
          item_id: linkedItem.id,
          matched_by: "path",
          stale: false,
          last_synced_at_ms: now,
        })
        .execute();

      const res = await request(app.getHttpServer())
        .get(`/admin/libraries/${libraryId}/stash-sync-report`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.unmatchedLoombreFiles.items).toEqual([
        {
          mediaFileId: unlinkedFile.id,
          itemId: unlinkedItem.id,
          itemTitle: "Unlinked Item",
          path: `/media/unlinked-${libraryId}.mp4`,
          sizeBytes: 2000,
        },
      ]);
      expect(res.body.unmatchedLoombreFiles.nextCursor).toBeNull();
    } finally {
      await db.destroy();
    }
  });

  it("unmatchedLoombreFiles keyset pagination via unmatchedLoombreFilesCursor", async () => {
    const libraryId = await makeRestrictedLibrary("stash-report-unmatched-loombre-keyset-lib");
    const db = createDb(databaseUrl);
    try {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        const item = await db
          .insertInto("catalog_items")
          .values({ library_id: libraryId, item_type: "movie", title: `Item ${i}`, sort_title: `Item ${i}`, added_at_ms: now, updated_at_ms: now })
          .returningAll()
          .executeTakeFirstOrThrow();
        await db.insertInto("media_files").values({ item_id: item.id, path: `/media/keyset-${i}-${libraryId}.mp4`, size_bytes: 100 }).execute();
      }

      const page1 = await request(app.getHttpServer())
        .get(`/admin/libraries/${libraryId}/stash-sync-report`)
        .query({ limit: 2 })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(page1.status).toBe(200);
      expect(page1.body.unmatchedLoombreFiles.items.length).toBe(2);
      expect(page1.body.unmatchedLoombreFiles.nextCursor).not.toBeNull();

      const page2 = await request(app.getHttpServer())
        .get(`/admin/libraries/${libraryId}/stash-sync-report`)
        .query({ limit: 2, unmatchedLoombreFilesCursor: page1.body.unmatchedLoombreFiles.nextCursor })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(page2.status).toBe(200);
      expect(page2.body.unmatchedLoombreFiles.items.length).toBe(1);
      expect(page2.body.unmatchedLoombreFiles.nextCursor).toBeNull();
    } finally {
      await db.destroy();
    }
  });
});
