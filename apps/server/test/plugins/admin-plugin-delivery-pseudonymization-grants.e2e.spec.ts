// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/plugins/admin-plugin-delivery-pseudonymization-grants.e2e.spec.ts
//
// Lane W5b's HTTP-level exit proof for the remaining three deliverables
// (provider-chain admin has its own sibling spec file):
//
//   1. GET /admin/plugins/{id}'s additive `deliveryStatus` — null with no
//      plugin_delivery_cursors row, populated after a real delivery-loop
//      writer (packages/db's recordDeliverySuccess) seeds one.
//   2. PUT /admin/plugins/{id}/pseudonymization — toggles
//      plugins.pseudonymize_actor_ids, 409s for a plugin without the
//      event-subscriber capability granted, 422s a non-boolean `enabled`.
//   3. The "honest grants audit": PUT /admin/plugins/{id}/event-grants now
//      emits plugin.updated with change='event-grants' and sorted old/new
//      arrays (packages/db's updatePluginEventGrantsAndEmit,
//      apps/server/src/plugins/admin-plugin-grants.service.ts's rewire) —
//      asserted via `db.selectFrom('events')` directly against the
//      already-typed Kysely<DB> handle @loombre/db's createDb returns (no
//      REST events-list endpoint exists; outbox delivery is websocket-only,
//      apps/server/test/ws-broadcaster.e2e.spec.ts's own precedent for
//      reading the `events` table straight off a createDb() handle in a
//      test file — this is NOT a raw `pg`/`kysely` package import, which
//      dependency-cruiser forbids outside packages/db even in test/ scope
//      exclusions; it's method calls on an object @loombre/db's public
//      barrel already returned, zero new npm deps).
//
// Mirrors apps/server/test/plugins/admin-plugins.e2e.spec.ts's conventions
// (own ensureTestDatabase suffix, real NestFactory-booted AppModule,
// supertest, spawning examples/lpp-reference-provider and
// examples/lpp-discord-notifier as real child processes on ephemeral
// ports).

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase, recordDeliveryFailure, recordDeliverySuccess } from "@loombre/db";
import { AppModule } from "../../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../../packages/db");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
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

interface SpawnedServer {
  child: ChildProcessByStdio<null, Readable, Readable>;
  baseUrl: string;
  stop: () => Promise<void>;
}

function spawnExamplePlugin(exampleDir: string, extraEnv: Record<string, string> = {}): Promise<SpawnedServer> {
  const scriptPath = path.join(REPO_ROOT, "examples", exampleDir, "server.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, PORT: "0", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let settled = false;
    const stderrChunks: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const match = /LISTENING (\d+)/.exec(stdoutBuffer);
      if (match && !settled) {
        settled = true;
        resolve({
          child,
          baseUrl: `http://127.0.0.1:${match[1]}`,
          stop: () =>
            new Promise<void>((res) => {
              child.once("exit", () => res());
              child.kill();
            }),
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`${exampleDir} exited before listening (code ${code}): ${stderrChunks.join("")}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`${exampleDir} did not print LISTENING within 5000ms: ${stderrChunks.join("")}`));
      }
    }, 5000);
  });
}

let app: INestApplication;
let adminToken: string;
let databaseUrl: string;
let db: ReturnType<typeof createDb>;
let referenceProvider: SpawnedServer;
let discordNotifier: SpawnedServer;

beforeAll(async () => {
  databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_plugin_delivery_pseudo_grants_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "admin-plugin-delivery-pseudo-grants-test-secret-not-for-production";

  db = createDb(databaseUrl);

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-plugin-w5b-test-admin",
    deviceProfile: buildDeviceProfile("admin-plugin-w5b-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  [referenceProvider, discordNotifier] = await Promise.all([
    spawnExamplePlugin("lpp-reference-provider"),
    spawnExamplePlugin("lpp-discord-notifier", { LOOMBRE_LPP_SIGNING_SECRET: "operational-webhook-secret-unrelated-to-w5b" }),
  ]);
}, 30_000);

afterAll(async () => {
  await app.close();
  await db?.destroy();
  await Promise.all([referenceProvider?.stop(), discordNotifier?.stop()]);
});

function asAdmin() {
  const server = () => app.getHttpServer();
  return {
    get: (url: string) => request(server()).get(url).set("Authorization", `Bearer ${adminToken}`),
    put: (url: string, body: unknown) => request(server()).put(url).set("Authorization", `Bearer ${adminToken}`).send(body as Record<string, unknown>),
    delete: (url: string) => request(server()).delete(url).set("Authorization", `Bearer ${adminToken}`),
  };
}

/** Every plugin.* outbox row for one plugin, oldest first — filters
 *  client-side (payload is a plain deserialized JS object off the JSONB
 *  column) rather than a `payload ->> 'pluginId'` SQL predicate, so this
 *  file never needs the `sql` template tag (a literal `kysely` import
 *  dependency-cruiser forbids outside packages/db) for a JSONB operator. */
async function pluginEventsFor(pluginId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const rows = await db.selectFrom("events").select(["type", "payload", "ts_ms", "id"]).orderBy("ts_ms", "asc").orderBy("id", "asc").execute();
  return rows.filter((r) => r.type.startsWith("plugin.") && (r.payload as Record<string, unknown>)["pluginId"] === pluginId);
}

/** C-2 fix wave: registerPlugin now requires a manifestDigest pinning it to
 *  whatever manifest a prior POST /admin/plugins/preview actually saw. */
async function previewManifestDigest(url: string, lanAllowlist: string[]): Promise<string> {
  const preview = await request(app.getHttpServer())
    .post("/admin/plugins/preview")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ url, lanAllowlist });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  return preview.body.manifestDigest;
}

async function registerEventSubscriber(webhookUrl: string, eventTypeGrants: string[]): Promise<string> {
  const manifestDigest = await previewManifestDigest(discordNotifier.baseUrl, ["127.0.0.1"]);
  const registered = await request(app.getHttpServer())
    .post("/admin/plugins")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      url: discordNotifier.baseUrl,
      grantedCapabilityTypes: ["event-subscriber"],
      eventTypeGrants,
      config: { webhookUrl },
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  return registered.body.plugin.id;
}

async function registerMetadataProviderOnly(): Promise<string> {
  const manifestDigest = await previewManifestDigest(referenceProvider.baseUrl, ["127.0.0.1"]);
  const registered = await request(app.getHttpServer())
    .post("/admin/plugins")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      url: referenceProvider.baseUrl,
      grantedCapabilityTypes: ["metadata-provider"],
      eventTypeGrants: [],
      config: {},
      lanAllowlist: ["127.0.0.1"],
      manifestDigest,
    });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  return registered.body.plugin.id;
}

const registeredPluginIds: string[] = [];
afterEach(async () => {
  while (registeredPluginIds.length > 0) {
    const id = registeredPluginIds.pop()!;
    await asAdmin().delete(`/admin/plugins/${id}`);
  }
});

describe("GET /admin/plugins/{id} deliveryStatus (Lane W5b)", () => {
  it("null with no plugin_delivery_cursors row; populated after a real delivery-loop write", async () => {
    const pluginId = await registerEventSubscriber("https://distinctive-webhook-w5b.example.invalid/hook", ["item.added"]);
    registeredPluginIds.push(pluginId);

    const before = await asAdmin().get(`/admin/plugins/${pluginId}`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.deliveryStatus).toBeNull();

    const nowMs = Date.now();
    await recordDeliverySuccess(db, {
      pluginId,
      cursorEventId: "01960000-0000-7000-8000-000000000000",
      deliveredEventCount: 3,
      nowMs,
    });

    const afterSuccess = await asAdmin().get(`/admin/plugins/${pluginId}`);
    expect(afterSuccess.status, JSON.stringify(afterSuccess.body)).toBe(200);
    expect(afterSuccess.body.deliveryStatus).toMatchObject({
      lastAttemptMs: nowMs,
      lastSuccessMs: nowMs,
      consecutiveFailures: 0,
      deliveredBatches: 1,
      deliveredEvents: 3,
      gapReportedThroughMs: null,
    });

    await recordDeliveryFailure(db, { pluginId, nowMs: nowMs + 1000 });
    const afterFailure = await asAdmin().get(`/admin/plugins/${pluginId}`);
    expect(afterFailure.body.deliveryStatus).toMatchObject({
      lastAttemptMs: nowMs + 1000,
      lastSuccessMs: nowMs, // unchanged by a failure
      consecutiveFailures: 1,
      deliveredBatches: 1, // unchanged by a failure
      deliveredEvents: 3,
    });
  });

  it("listAdminPlugins also carries deliveryStatus for the same plugin", async () => {
    const pluginId = await registerEventSubscriber("https://distinctive-webhook-w5b-list.example.invalid/hook", ["item.added"]);
    registeredPluginIds.push(pluginId);
    await recordDeliverySuccess(db, { pluginId, cursorEventId: "01960000-0000-7000-8000-000000000001", deliveredEventCount: 1, nowMs: Date.now() });

    const list = await asAdmin().get("/admin/plugins");
    const item = list.body.items.find((p: { id: string }) => p.id === pluginId);
    expect(item.deliveryStatus).toMatchObject({ deliveredBatches: 1, deliveredEvents: 1 });
  });
});

describe("PUT /admin/plugins/{id}/pseudonymization (Lane W5b)", () => {
  it("default ON at registration, toggles off then back on, and rejects a non-boolean enabled with 422", async () => {
    const pluginId = await registerEventSubscriber("https://distinctive-webhook-w5b-pseudo.example.invalid/hook", ["item.added"]);
    registeredPluginIds.push(pluginId);

    const registered = await asAdmin().get(`/admin/plugins/${pluginId}`);
    expect(registered.body.pseudonymizeActorIds).toBe(true);

    const turnedOff = await asAdmin().put(`/admin/plugins/${pluginId}/pseudonymization`, { enabled: false });
    expect(turnedOff.status, JSON.stringify(turnedOff.body)).toBe(200);
    expect(turnedOff.body.pseudonymizeActorIds).toBe(false);

    const turnedOn = await asAdmin().put(`/admin/plugins/${pluginId}/pseudonymization`, { enabled: true });
    expect(turnedOn.status, JSON.stringify(turnedOn.body)).toBe(200);
    expect(turnedOn.body.pseudonymizeActorIds).toBe(true);

    const events = await pluginEventsFor(pluginId);
    const pseudonymizationEvents = events.filter((e) => e.type === "plugin.updated" && e.payload["change"] === "pseudonymization");
    expect(pseudonymizationEvents).toHaveLength(2);
    expect(pseudonymizationEvents[0]?.payload).toMatchObject({ oldValue: true, newValue: false });
    expect(pseudonymizationEvents[1]?.payload).toMatchObject({ oldValue: false, newValue: true });

    const invalid = await asAdmin().put(`/admin/plugins/${pluginId}/pseudonymization`, { enabled: "yes" });
    expect(invalid.status, JSON.stringify(invalid.body)).toBe(422);
  });

  it("409s for a plugin without the event-subscriber capability granted", async () => {
    const pluginId = await registerMetadataProviderOnly();
    registeredPluginIds.push(pluginId);

    const res = await asAdmin().put(`/admin/plugins/${pluginId}/pseudonymization`, { enabled: false });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("404s for an unknown plugin", async () => {
    const res = await asAdmin().put("/admin/plugins/11111111-1111-4111-8111-111111111111/pseudonymization", { enabled: false });
    expect(res.status).toBe(404);
  });
});

describe("PUT /admin/plugins/{id}/event-grants — honest audit (Lane W5b)", () => {
  it("emits plugin.updated with change='event-grants' and correct sorted old/new arrays, no longer change='manifest'", async () => {
    const pluginId = await registerEventSubscriber("https://distinctive-webhook-w5b-grants.example.invalid/hook", ["item.added"]);
    registeredPluginIds.push(pluginId);

    const widen = await asAdmin().put(`/admin/plugins/${pluginId}/event-grants`, {
      eventTypeGrants: ["item.added", "playback.started"],
    });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
    expect(widen.body.eventGrants.map((g: { eventType: string }) => g.eventType).sort()).toEqual(["item.added", "playback.started"]);

    const events = await pluginEventsFor(pluginId);
    const grantsEvents = events.filter((e) => e.type === "plugin.updated" && e.payload["change"] === "event-grants");
    expect(grantsEvents).toHaveLength(1);
    expect(grantsEvents[0]?.payload).toMatchObject({
      change: "event-grants",
      oldValue: ["item.added"],
      newValue: ["item.added", "playback.started"],
    });

    // The stale documented workaround emitted change='manifest' instead —
    // prove it's gone for THIS write (a manifest event still legitimately
    // exists from registration's own insertPluginAndEmit, which is a
    // plugin.registered event, not plugin.updated, so this narrows
    // correctly to updates only).
    const manifestUpdateEvents = events.filter((e) => e.type === "plugin.updated" && e.payload["change"] === "manifest");
    expect(manifestUpdateEvents).toEqual([]);

    const narrow = await asAdmin().put(`/admin/plugins/${pluginId}/event-grants`, { eventTypeGrants: ["playback.started"] });
    expect(narrow.status, JSON.stringify(narrow.body)).toBe(200);
    const eventsAfterNarrow = await pluginEventsFor(pluginId);
    const secondGrantsEvent = eventsAfterNarrow.filter((e) => e.type === "plugin.updated" && e.payload["change"] === "event-grants").at(-1);
    expect(secondGrantsEvent?.payload).toMatchObject({
      oldValue: ["item.added", "playback.started"],
      newValue: ["playback.started"],
    });
  });
});
