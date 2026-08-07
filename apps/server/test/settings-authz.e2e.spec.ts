// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/settings-authz.e2e.spec.ts
//
// Wave 2 W10 "API-LAYER ENFORCEMENT" (D-6, IA restructure): proves —
// empirically, over real HTTP, not by code reading alone — that every
// server-scoped System Settings surface the web client's admin pages call
// (settings registry read/write, provider keys, power, mail, notices,
// plugins, remote access, users admin, libraries admin + provider-chain +
// stash, invites, jobs/sessions/filesystem) rejects a signed-in NON-ADMIN
// with 403, and that the user-scoped surfaces the new /profile route calls
// (own profile, password, playback prefs, restricted opt-in/PIN) still work
// for that same non-admin. GET /admin/capabilities, GET /admin/crash-files
// (+/{name}), GET /admin/logs/tail already have their own 403 coverage in
// admin-capabilities-crash-logs.e2e.spec.ts — not duplicated here.
//
// Route table below is deliberately data-driven: every controller in this
// sweep calls its admin guard (requireAdmin/requireLiveAdmin/
// assertLiveAdmin) as the FIRST statement of the handler (or the service
// method it delegates to, before touching the request body) — ground-
// truthed by reading every controller in apps/server/src/{settings,mail,
// notices,invites,plugins,remote,catalog}/*.controller.ts before writing
// this table. That ordering is what lets every entry below send an empty
// `{}` body and a placeholder path id: the guard 403s before any body/id
// validation ever runs, so this table doesn't need to know each route's
// real request shape to prove the boundary.
//
// Self-sufficient (own ensureTestDatabase suffix, own login), same pattern
// as admin-capabilities-crash-logs.e2e.spec.ts.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";
const PLACEHOLDER_ID = "00000000-0000-7000-8000-000000000000";

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
  process.env["LOOMBRE_JWT_SECRET"] = "settings-authz-test-secret-not-for-production";

  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "settings_authz_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "settings-authz-admin",
    deviceProfile: buildDeviceProfile("settings-authz-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "settings-authz-casual",
    deviceProfile: buildDeviceProfile("settings-authz-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterAll(async () => {
  await app.close();
});

type Method = "get" | "post" | "put" | "patch" | "delete";

interface AdminRoute {
  method: Method;
  path: string;
}

// One entry per server-scoped admin surface the System Settings pages
// (components/settings/sections/*.tsx) and the merged Dashboard
// (app/admin/page.tsx) call. Grouped to match the work-item's own list:
// "settings registry read/write, power, mail, notices, plugins, remote
// access, users admin, libraries admin, capabilities, jobs, crash/logs".
const ADMIN_ROUTES: AdminRoute[] = [
  // ── Settings registry (Advanced Server) + provider keys (Plugins tab) ──
  { method: "get", path: "/admin/settings" },
  { method: "get", path: "/admin/settings/schema" },
  { method: "put", path: "/admin/settings/tmdb-api-key" },
  { method: "put", path: "/admin/provider-keys/tmdb" },
  { method: "delete", path: "/admin/provider-keys/tmdb" },

  // ── Power (Server tab) ──
  { method: "post", path: "/system/restart" },
  { method: "post", path: "/system/shutdown" },

  // ── System info + update check (Dashboard cards, About tab) — W3-R:
  //    the sweep's first cut missed both; they ARE admin-guarded
  //    (admin.controller.ts requireAdmin first) and now stay proven so. ──
  { method: "get", path: "/system/info" },
  { method: "get", path: "/system/update" },

  // ── Mail (Mail tab) ──
  { method: "put", path: "/admin/mail/credentials" },
  { method: "delete", path: "/admin/mail/credentials" },
  { method: "post", path: "/admin/mail/test-send" },

  // ── Notices (Notices tab) ──
  { method: "post", path: "/system/notices" },
  { method: "post", path: `/system/notices/${PLACEHOLDER_ID}/cancel` },
  { method: "get", path: "/system/notices" },

  // ── Plugins (Plugins tab, the LOOMBRE PLUGIN PROTOCOL registry) ──
  { method: "get", path: "/admin/plugins" },
  { method: "post", path: "/admin/plugins" },
  { method: "post", path: "/admin/plugins/preview" },
  { method: "get", path: `/admin/plugins/${PLACEHOLDER_ID}` },
  { method: "delete", path: `/admin/plugins/${PLACEHOLDER_ID}` },
  { method: "put", path: `/admin/plugins/${PLACEHOLDER_ID}/config` },
  { method: "put", path: `/admin/plugins/${PLACEHOLDER_ID}/event-grants` },
  { method: "put", path: `/admin/plugins/${PLACEHOLDER_ID}/pseudonymization` },
  { method: "post", path: `/admin/plugins/${PLACEHOLDER_ID}/enable` },
  { method: "post", path: `/admin/plugins/${PLACEHOLDER_ID}/disable` },
  { method: "post", path: `/admin/plugins/${PLACEHOLDER_ID}/refresh` },
  { method: "post", path: `/admin/plugins/${PLACEHOLDER_ID}/reapprove` },
  { method: "post", path: `/admin/plugins/${PLACEHOLDER_ID}/rotate-hmac` },

  // ── Remote Access (Remote Access tab) ──
  { method: "get", path: "/admin/remote/state" },
  { method: "post", path: "/admin/remote/wireguard/enable" },
  { method: "post", path: "/admin/remote/wireguard/disable" },
  { method: "get", path: "/admin/remote/wireguard/status" },
  { method: "get", path: "/admin/remote/wireguard/devices" },
  { method: "post", path: "/admin/remote/wireguard/devices" },
  { method: "delete", path: `/admin/remote/wireguard/devices/${PLACEHOLDER_ID}` },
  { method: "post", path: "/admin/remote/tunnel/token" },
  { method: "delete", path: "/admin/remote/tunnel/token" },
  { method: "post", path: "/admin/remote/tunnel/enable" },
  { method: "post", path: "/admin/remote/tunnel/disable" },
  { method: "get", path: "/admin/remote/tunnel/status" },
  { method: "get", path: "/admin/remote/tunnel/logs" },
  { method: "post", path: "/admin/remote/direct/acme-test" },
  { method: "post", path: "/admin/remote/direct/enable" },
  { method: "post", path: "/admin/remote/direct/disable" },
  { method: "post", path: "/admin/remote/diagnosis" },
  { method: "post", path: "/admin/remote/probes" },
  { method: "get", path: `/admin/remote/probes/${PLACEHOLDER_ID}` },
  { method: "get", path: "/admin/remote/posture" },

  // ── Users & Profiles (admin actions on OTHER users) ──
  { method: "get", path: "/users" },
  { method: "post", path: "/users" },
  { method: "get", path: `/users/${PLACEHOLDER_ID}` },
  { method: "patch", path: `/users/${PLACEHOLDER_ID}` },
  { method: "delete", path: `/users/${PLACEHOLDER_ID}` },
  { method: "post", path: `/users/${PLACEHOLDER_ID}/reset-password` },
  { method: "get", path: "/invites" },
  { method: "post", path: "/invites" },
  { method: "delete", path: `/invites/${PLACEHOLDER_ID}` },

  // ── Libraries (Libraries tab) + provider-chain + Stash connector ──
  { method: "post", path: "/libraries" },
  { method: "patch", path: `/libraries/${PLACEHOLDER_ID}` },
  { method: "delete", path: `/libraries/${PLACEHOLDER_ID}` },
  { method: "post", path: `/libraries/${PLACEHOLDER_ID}/scan` },
  { method: "get", path: `/libraries/${PLACEHOLDER_ID}/permissions` },
  { method: "put", path: `/libraries/${PLACEHOLDER_ID}/permissions` },
  { method: "get", path: `/admin/libraries/${PLACEHOLDER_ID}/provider-chain` },
  { method: "put", path: `/admin/libraries/${PLACEHOLDER_ID}/provider-chain` },
  { method: "get", path: `/admin/libraries/${PLACEHOLDER_ID}/stash-connection` },
  { method: "put", path: `/admin/libraries/${PLACEHOLDER_ID}/stash-connection` },
  { method: "get", path: `/admin/libraries/${PLACEHOLDER_ID}/stash-path-mappings` },
  { method: "put", path: `/admin/libraries/${PLACEHOLDER_ID}/stash-path-mappings` },
  { method: "post", path: `/admin/libraries/${PLACEHOLDER_ID}/stash-path-mappings/preview` },
  { method: "post", path: `/admin/libraries/${PLACEHOLDER_ID}/stash-sync` },
  { method: "get", path: `/admin/libraries/${PLACEHOLDER_ID}/stash-sync-report` },
  { method: "get", path: `/admin/libraries/${PLACEHOLDER_ID}/unmatched` },
  { method: "post", path: `/admin/items/${PLACEHOLDER_ID}/match-search` },
  { method: "post", path: `/admin/items/${PLACEHOLDER_ID}/apply-match` },

  // ── Jobs / sessions / filesystem browser (Dashboard + Libraries "Add") ──
  { method: "get", path: "/admin/jobs" },
  { method: "get", path: `/admin/jobs/${PLACEHOLDER_ID}` },
  { method: "get", path: "/admin/sessions" },
  { method: "get", path: "/admin/filesystem/directories" },
];

describe("Server-scoped System Settings surfaces reject a non-admin (D-6 authz sweep)", () => {
  for (const route of ADMIN_ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path} -> 403 for a non-admin token`, async () => {
      const res = await request(app.getHttpServer())
        [route.method](route.path)
        .set("Authorization", `Bearer ${casualToken}`)
        .send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });
  }

  // Control case: the SAME routes must NOT 403 an admin (proves the table
  // above is exercising a real admin gate, not a route that 403s everyone —
  // e.g. a typo'd path that 404s would otherwise pass the loop above too).
  // A light sample across every group, not the full table, keeps this fast.
  const ADMIN_SANITY_SAMPLE: AdminRoute[] = [
    { method: "get", path: "/admin/settings" },
    { method: "get", path: "/system/notices" },
    { method: "get", path: "/admin/plugins" },
    { method: "get", path: "/admin/remote/state" },
    { method: "get", path: "/users" },
    { method: "get", path: "/admin/jobs" },
  ];
  for (const route of ADMIN_SANITY_SAMPLE) {
    it(`${route.method.toUpperCase()} ${route.path} -> not 403 for the real admin token (proves the route exists and the gate is admin-specific)`, async () => {
      const res = await request(app.getHttpServer())
        [route.method](route.path)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      expect(res.status).not.toBe(403);
    });
  }
});

describe("User-scoped self-service surfaces still work for a non-admin (the new /profile route)", () => {
  it("GET /users/me works for a non-admin", async () => {
    const res = await request(app.getHttpServer()).get("/users/me").set("Authorization", `Bearer ${casualToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.username).toBe("casual");
    expect(res.body.isAdmin).toBe(false);
  });

  it("PATCH /users/me (own profile, e.g. display name) works for a non-admin", async () => {
    const res = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${casualToken}`)
      .send({ displayName: "Casual Viewer" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.displayName).toBe("Casual Viewer");
  });

  it("GET+PUT /users/me/settings (own playback prefs) works for a non-admin", async () => {
    const getRes = await request(app.getHttpServer())
      .get("/users/me/settings")
      .set("Authorization", `Bearer ${casualToken}`);
    expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);

    const putRes = await request(app.getHttpServer())
      .put("/users/me/settings")
      .set("Authorization", `Bearer ${casualToken}`)
      .send({
        restrictedOptIn: getRes.body.restrictedOptIn,
        locale: getRes.body.locale,
        theme: getRes.body.theme,
        subtitlePreferredLanguage: "jpn",
        audioPreferredLanguage: "fra",
        autoplayNextEpisode: getRes.body.autoplayNextEpisode,
        updatedAtMs: getRes.body.updatedAtMs,
      });
    expect(putRes.status, JSON.stringify(putRes.body)).toBe(200);
    expect(putRes.body.subtitlePreferredLanguage).toBe("jpn");
    expect(putRes.body.audioPreferredLanguage).toBe("fra");
  });

  it("PUT /users/me/restricted (own restricted opt-in) works for a non-admin", async () => {
    const res = await request(app.getHttpServer())
      .put("/users/me/restricted")
      .set("Authorization", `Bearer ${casualToken}`)
      .send({ optIn: false, currentPassword: "loombre-seed-casual" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.optIn).toBe(false);
  });

  it("PATCH /users/me (own password change) works for a non-admin, and is reverted", async () => {
    const changed = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${casualToken}`)
      .send({ password: "temporary-password-for-this-test", currentPassword: "loombre-seed-casual" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    // auth.guard.ts (F3/R-F7): a successful password change stamps
    // users.password_changed_at_ms and rejects any access token whose
    // whole-SECOND `iat` ties or precedes it (Math.ceil — "ties resolve to
    // reject", auth.guard.ts's own doc comment) — INCLUDING the current
    // device's own token, not just other devices' (only the underlying
    // SESSION row survives, for a refresh-token exchange a real client
    // would perform silently). This test has no refresh flow wired, so it
    // re-authenticates with the new password instead, exactly what a real
    // client's next request would effectively do — sleeping past the
    // 1-second tie window first, so the fresh login's `iat` is
    // unambiguously after the epoch rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const relogin = await request(app.getHttpServer()).post("/auth/login").send({
      username: "casual",
      password: "temporary-password-for-this-test",
      deviceName: "settings-authz-casual-revert",
      deviceProfile: buildDeviceProfile("settings-authz-casual-revert"),
    });
    expect(relogin.status, JSON.stringify(relogin.body)).toBe(200);

    // Revert, so this file leaves the seeded fixture exactly as it found
    // it — same "self-contained, not order-dependent" discipline
    // admin-capabilities-crash-logs.e2e.spec.ts's cleanup blocks use.
    const reverted = await request(app.getHttpServer())
      .patch("/users/me")
      .set("Authorization", `Bearer ${relogin.body.accessToken}`)
      .send({ password: "loombre-seed-casual", currentPassword: "temporary-password-for-this-test" });
    expect(reverted.status, JSON.stringify(reverted.body)).toBe(200);
  });
});
