// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/ws-broadcaster.e2e.spec.ts
//
// Mission-mandated two-live-sockets test for the /v1/events websocket
// broadcaster (apps/server/src/gateway/ws-broadcaster.service.ts):
//   1. Boot the real app LISTENING on a real ephemeral TCP port (WS clients
//      need a real socket — unlike conformance.spec.ts's supertest-only
//      app.init(), this file calls app.listen(0)).
//   2. Open two REAL `ws` WebSocket connections: seed admin
//      (restricted-cleared + live-unlocked) and seed casual
//      (restricted-uncleared, no library grant on the restricted library).
//   3. Insert one restricted item.added event and one general item.added
//      event directly into the events outbox table via a raw @loombre/db
//      Kysely handle (createDb — the same pattern apps/server/test/
//      auth.e2e.spec.ts already uses for direct DB setup).
//   4. Assert: the general event reaches BOTH sockets; the restricted
//      event reaches ONLY the admin (cleared) socket; and — a negative
//      window — the casual socket receives NOTHING further within a grace
//      period after the restricted event was inserted.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed) per
// this package's established live-DB test convention.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
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
    throw new Error(
      `${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
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

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let app: INestApplication;
let baseWsUrl: string;

beforeAll(async () => {
  // Gate 1 (docs/PLAN.md §6.4) must be on for the admin socket to ever
  // reach restrictedCleared — set BEFORE any request that resolves
  // clearance (isRestrictedContentEnabled() reads this fresh every call,
  // not cached at boot, so setting it here is sufficient).
  process.env["LOOMBRE_RESTRICTED_ENABLED"] = "true";
  process.env["LOOMBRE_JWT_SECRET"] = "ws-broadcaster-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "ws_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address() as AddressInfo;
  baseWsUrl = `ws://127.0.0.1:${address.port}/v1/events`;
}, 30_000);

afterAll(async () => {
  await app.close();
});

describe("websocket broadcaster (mission-mandated two-live-sockets test)", () => {
  it("delivers a general event to both sockets and a restricted event only to the cleared socket", async () => {
    const httpServer = app.getHttpServer();

    // --- admin: log in, then live-unlock restricted content (gates 1-5) ---
    const adminLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "ws-test-admin",
      deviceProfile: buildDeviceProfile("ws-test-admin"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;

    const unlock = await request(httpServer)
      .post("/restricted/unlock")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pin: "0000" });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);

    // --- casual: log in only (never opted in, no restricted library grant) ---
    const casualLogin = await request(httpServer).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "ws-test-casual",
      deviceProfile: buildDeviceProfile("ws-test-casual"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
    const casualToken: string = casualLogin.body.accessToken;

    // --- open two real sockets ---
    const adminWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(adminToken)}`);
    const casualWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(casualToken)}`);

    const adminMessages: unknown[] = [];
    const casualMessages: unknown[] = [];
    adminWs.on("message", (data) => adminMessages.push(JSON.parse(data.toString())));
    casualWs.on("message", (data) => casualMessages.push(JSON.parse(data.toString())));

    await Promise.all([waitForOpen(adminWs), waitForOpen(casualWs)]);

    // --- insert one general + one restricted item.added event directly ---
    const db = createDb(process.env["DATABASE_URL"]!);
    try {
      const libMovies = await db
        .selectFrom("libraries")
        .select("id")
        .where("name", "=", "Movies")
        .executeTakeFirstOrThrow();
      const libRestricted = await db
        .selectFrom("libraries")
        .select("id")
        .where("name", "=", "Restricted")
        .executeTakeFirstOrThrow();
      const generalMovie = await db
        .selectFrom("catalog_items")
        .select("id")
        .where("title", "=", "Neon Static")
        .executeTakeFirstOrThrow();
      const restrictedMovie = await db
        .selectFrom("catalog_items")
        .select("id")
        .where("title", "=", "Velvet Static")
        .executeTakeFirstOrThrow();

      const nowMs = Date.now();
      await db
        .insertInto("events")
        .values({
          type: "item.added",
          ts_ms: nowMs,
          actor_user_id: null,
          payload: {
            itemId: generalMovie.id,
            libraryId: libMovies.id,
            itemType: "movie",
            contentClass: "general",
            parentId: null,
            addedAtMs: nowMs,
          },
        })
        .execute();

      await db
        .insertInto("events")
        .values({
          type: "item.added",
          ts_ms: nowMs,
          actor_user_id: null,
          payload: {
            itemId: restrictedMovie.id,
            libraryId: libRestricted.id,
            itemType: "movie",
            contentClass: "restricted",
            parentId: null,
            addedAtMs: nowMs,
          },
        })
        .execute();

      // Broadcaster polls every 500ms — give it two ticks' worth of margin.
      await sleep(1500);

      expect(
        adminMessages.some((m: any) => m.payload?.itemId === generalMovie.id),
        `admin socket should receive the general event; got ${JSON.stringify(adminMessages)}`,
      ).toBe(true);
      expect(
        casualMessages.some((m: any) => m.payload?.itemId === generalMovie.id),
        `casual socket should receive the general event; got ${JSON.stringify(casualMessages)}`,
      ).toBe(true);

      expect(
        adminMessages.some((m: any) => m.payload?.itemId === restrictedMovie.id),
        `admin (cleared) socket should receive the restricted event; got ${JSON.stringify(adminMessages)}`,
      ).toBe(true);
      expect(
        casualMessages.some((m: any) => m.payload?.itemId === restrictedMovie.id),
        `casual (uncleared) socket must NEVER receive the restricted event; got ${JSON.stringify(casualMessages)}`,
      ).toBe(false);

      // Negative window: nothing further arrives for casual after this point.
      const casualCountAfterFirstWindow = casualMessages.length;
      await sleep(750);
      expect(
        casualMessages.length,
        "casual socket received additional message(s) during the negative-window grace period",
      ).toBe(casualCountAfterFirstWindow);
    } finally {
      await db.destroy();
      adminWs.close();
      casualWs.close();
    }
  }, 20_000);

  // STATE.md P2.8 (websocket-presence lane, task 3): restricted.locked/
  // restricted.unlocked are USER-SCOPED — delivered only to the subject
  // user's own sockets, never to any other connected viewer regardless of
  // clearance. Also proves the expiry-based auto-relock synthesis (task
  // 3c): a socket that observes its OWN ViewerContext transition
  // restrictedCleared true -> false (gate 5 unlock expiring, simulated here
  // by directly backdating user_settings.restricted_unlocked_until_ms
  // rather than waiting out the real 30-minute TTL) receives a LOCALLY
  // SYNTHESIZED restricted.locked within CONTEXT_CACHE_TTL_MS (5s) + one
  // poll tick, with NO outbox row behind it (apps/server/src/gateway/
  // ws-broadcaster.service.ts's header explains why).
  it("restricted.locked/restricted.unlocked: user-scoped delivery, and expiry synthesizes a locally-generated restricted.locked", async () => {
    const httpServer = app.getHttpServer();

    const adminLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "ws-test-admin-lock",
      deviceProfile: buildDeviceProfile("ws-test-admin-lock"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;
    // TokenPair carries no userId field (see conformance.spec.ts's
    // TOKEN_PAIR_SCHEMA) — decode the access JWT's `sub` claim instead,
    // same claim ws-broadcaster.service.ts itself reads (AccessTokenClaims).
    const adminUserId: string = JSON.parse(
      Buffer.from(adminToken.split(".")[1]!, "base64url").toString("utf8"),
    ).sub;

    const casualLogin = await request(httpServer).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "ws-test-casual-lock",
      deviceProfile: buildDeviceProfile("ws-test-casual-lock"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
    const casualToken: string = casualLogin.body.accessToken;

    // Connect BEFORE the first unlock so the outbox-delivered
    // restricted.unlocked event (which does not depend on cached ctx
    // freshness — see events.ts's USER_ONLY_TYPES) has a live socket to
    // reach, and so this socket's initial ctx starts uncleared (the
    // baseline the later expiry transition needs to observe a flip FROM).
    const adminWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(adminToken)}`);
    const casualWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(casualToken)}`);

    const adminMessages: any[] = [];
    const casualMessages: any[] = [];
    adminWs.on("message", (data) => adminMessages.push(JSON.parse(data.toString())));
    casualWs.on("message", (data) => casualMessages.push(JSON.parse(data.toString())));

    await Promise.all([waitForOpen(adminWs), waitForOpen(casualWs)]);
    const connectedAtMs = Date.now();

    try {
      const noRestrictedFor = (messages: any[]) =>
        messages.every((m) => typeof m.type !== "string" || !m.type.startsWith("restricted."));

      // --- Phase 1: explicit unlock -> restricted.unlocked to admin only ---
      const unlock1 = await request(httpServer)
        .post("/restricted/unlock")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pin: "0000" });
      expect(unlock1.status, JSON.stringify(unlock1.body)).toBe(200);
      await sleep(800);

      expect(
        adminMessages.some((m) => m.type === "restricted.unlocked" && m.payload?.userId === adminUserId),
        `admin should receive restricted.unlocked; got ${JSON.stringify(adminMessages)}`,
      ).toBe(true);
      expect(noRestrictedFor(casualMessages), `casual must never receive restricted.* events; got ${JSON.stringify(casualMessages)}`).toBe(true);

      // --- Phase 2: explicit lock -> restricted.locked to admin only ---
      const lock1 = await request(httpServer).post("/restricted/lock").set("Authorization", `Bearer ${adminToken}`).send();
      expect(lock1.status).toBe(204);
      await sleep(800);

      expect(
        adminMessages.some((m) => m.type === "restricted.locked" && m.payload?.userId === adminUserId),
        `admin should receive restricted.locked; got ${JSON.stringify(adminMessages)}`,
      ).toBe(true);
      expect(noRestrictedFor(casualMessages), "casual must never receive restricted.* events (after lock)").toBe(true);

      // --- Phase 3: unlock again, then let the socket's cached ctx catch up ---
      const unlock2 = await request(httpServer)
        .post("/restricted/unlock")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pin: "0000" });
      expect(unlock2.status, JSON.stringify(unlock2.body)).toBe(200);

      // Wait past this socket's first CONTEXT_CACHE_TTL_MS (5s) window so
      // the broadcaster re-resolves and observes restrictedCleared=TRUE at
      // least once — required before the expiry manipulation below can be
      // observed as a true->false TRANSITION rather than a no-op.
      const elapsedSinceConnectMs = Date.now() - connectedAtMs;
      await sleep(Math.max(0, 5000 - elapsedSinceConnectMs) + 700);

      // --- Phase 4: simulate gate-5 expiry directly (no /restricted/lock
      // call, no outbox row) — backdate the unlock deadline into the past.
      const lockedCountBeforeExpiry = adminMessages.filter((m) => m.type === "restricted.locked").length;

      const db = createDb(process.env["DATABASE_URL"]!);
      try {
        await db
          .updateTable("user_settings")
          .set({ restricted_unlocked_until_ms: Date.now() - 1 })
          .where("user_id", "=", adminUserId)
          .execute();
      } finally {
        await db.destroy();
      }

      // One full CONTEXT_CACHE_TTL_MS window + a poll tick + margin.
      await sleep(5000 + 500 + 1000);

      const lockedCountAfterExpiry = adminMessages.filter((m) => m.type === "restricted.locked").length;
      expect(
        lockedCountAfterExpiry,
        `expected a NEW (synthesized) restricted.locked after simulated expiry; messages: ${JSON.stringify(adminMessages)}`,
      ).toBeGreaterThan(lockedCountBeforeExpiry);
      expect(noRestrictedFor(casualMessages), "casual must never receive restricted.* events (after expiry)").toBe(true);
    } finally {
      adminWs.close();
      casualWs.close();
    }
  }, 40_000);

  // STATE.md P4.13 (Phase 4 deliverable D): job.updated is ADMIN_ONLY —
  // mirrors this file's own restricted.locked/unlocked user-scoped-delivery
  // test's shape, but the gate is "is this socket's connecting user an
  // admin" (apps/server/src/gateway/ws-broadcaster.service.ts's
  // ADMIN_ONLY_TYPES), not content visibility — so a casual (non-admin,
  // fully unrelated to restricted content one way or the other) socket
  // must NEVER receive it, while the admin socket always does. The event
  // row is inserted directly (same raw-outbox-row technique as this file's
  // first test) — packages/jobs/test/ledger-events.spec.ts already proves
  // the ledger writes this event transactionally at real job transitions;
  // this file's only job is proving the DELIVERY gate.
  it("job.updated: ADMIN_ONLY delivery — casual socket receives nothing, admin socket receives it", async () => {
    const httpServer = app.getHttpServer();

    const adminLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "ws-test-admin-jobs",
      deviceProfile: buildDeviceProfile("ws-test-admin-jobs"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;

    const casualLogin = await request(httpServer).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "ws-test-casual-jobs",
      deviceProfile: buildDeviceProfile("ws-test-casual-jobs"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
    const casualToken: string = casualLogin.body.accessToken;

    const adminWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(adminToken)}`);
    const casualWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(casualToken)}`);

    const adminMessages: unknown[] = [];
    const casualMessages: unknown[] = [];
    adminWs.on("message", (data) => adminMessages.push(JSON.parse(data.toString())));
    casualWs.on("message", (data) => casualMessages.push(JSON.parse(data.toString())));

    await Promise.all([waitForOpen(adminWs), waitForOpen(casualWs)]);

    const db = createDb(process.env["DATABASE_URL"]!);
    const jobId = "018f6f1e-0000-7000-8000-0000000000b1";
    try {
      const nowMs = Date.now();
      await db
        .insertInto("events")
        .values({
          type: "job.updated",
          ts_ms: nowMs,
          actor_user_id: null,
          payload: {
            jobId,
            jobType: "scan",
            status: "active",
            errorMessage: null,
            updatedAtMs: nowMs,
          },
        })
        .execute();

      // Two poll ticks' worth of margin (POLL_INTERVAL_MS = 500ms).
      await sleep(1500);

      const isJobUpdatedFor = (m: unknown, wantJobId: string): boolean => {
        const envelope = m as { type?: unknown; payload?: { jobId?: unknown } };
        return envelope.type === "job.updated" && envelope.payload?.jobId === wantJobId;
      };
      const isAnyJobUpdated = (m: unknown): boolean => (m as { type?: unknown }).type === "job.updated";

      expect(
        adminMessages.some((m) => isJobUpdatedFor(m, jobId)),
        `admin socket should receive job.updated; got ${JSON.stringify(adminMessages)}`,
      ).toBe(true);
      expect(
        casualMessages.some(isAnyJobUpdated),
        `casual (non-admin) socket must NEVER receive job.updated; got ${JSON.stringify(casualMessages)}`,
      ).toBe(false);

      // Negative window: nothing further arrives for casual after this point.
      const casualCountAfterFirstWindow = casualMessages.length;
      await sleep(750);
      expect(
        casualMessages.length,
        "casual socket received additional message(s) during the negative-window grace period",
      ).toBe(casualCountAfterFirstWindow);
    } finally {
      await db.destroy();
      adminWs.close();
      casualWs.close();
    }
  }, 20_000);

  it("job.updated: a demoted admin's live socket stops receiving admin-only events within the context TTL (L2)", async () => {
    const httpServer = app.getHttpServer();

    const seedLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "ws-test-demote-seed",
      deviceProfile: buildDeviceProfile("ws-test-demote-seed"),
    });
    expect(seedLogin.status, JSON.stringify(seedLogin.body)).toBe(200);
    const seedToken: string = seedLogin.body.accessToken;

    const created = await request(httpServer)
      .post("/users")
      .set("Authorization", `Bearer ${seedToken}`)
      .send({
        username: "ws-demote-me",
        email: "ws-demote-me@example.invalid",
        password: "ws-demote-me-password-1",
        isAdmin: true,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const secondAdminId: string = created.body.id;

    const secondLogin = await request(httpServer).post("/auth/login").send({
      username: "ws-demote-me",
      password: "ws-demote-me-password-1",
      deviceName: "ws-test-demote-socket",
      deviceProfile: buildDeviceProfile("ws-test-demote-socket"),
    });
    expect(secondLogin.status, JSON.stringify(secondLogin.body)).toBe(200);
    const secondToken: string = secondLogin.body.accessToken;

    const secondWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(secondToken)}`);
    const secondMessages: unknown[] = [];
    secondWs.on("message", (data) => secondMessages.push(JSON.parse(data.toString())));
    await waitForOpen(secondWs);

    const db = createDb(process.env["DATABASE_URL"]!);
    const beforeJobId = "018f6f1e-0000-7000-8000-0000000000c1";
    const afterJobId = "018f6f1e-0000-7000-8000-0000000000c2";
    const insertJobEvent = async (jobId: string) => {
      const nowMs = Date.now();
      await db
        .insertInto("events")
        .values({
          type: "job.updated",
          ts_ms: nowMs,
          actor_user_id: null,
          payload: { jobId, jobType: "scan", status: "active", errorMessage: null, updatedAtMs: nowMs },
        })
        .execute();
    };
    const isJobUpdatedFor = (m: unknown, wantJobId: string): boolean => {
      const envelope = m as { type?: unknown; payload?: { jobId?: unknown } };
      return envelope.type === "job.updated" && envelope.payload?.jobId === wantJobId;
    };

    try {
      // Positive control: while genuinely an admin, the socket receives it.
      await insertJobEvent(beforeJobId);
      await sleep(1500);
      expect(
        secondMessages.some((m) => isJobUpdatedFor(m, beforeJobId)),
        `pre-demotion admin socket should receive job.updated; got ${JSON.stringify(secondMessages)}`,
      ).toBe(true);

      const demoted = await request(httpServer)
        .patch(`/users/${secondAdminId}`)
        .set("Authorization", `Bearer ${seedToken}`)
        .send({ isAdmin: false });
      expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);

      // Wait out the broadcaster's per-socket context TTL (5s) plus poll
      // margin, then emit another admin-only event: the demoted socket
      // must NOT receive it — connect-time claims are not forever.
      await sleep(6000);
      await insertJobEvent(afterJobId);
      await sleep(1500);
      expect(
        secondMessages.some((m) => isJobUpdatedFor(m, afterJobId)),
        `post-demotion socket must NOT receive job.updated; got ${JSON.stringify(secondMessages)}`,
      ).toBe(false);
    } finally {
      await db.destroy();
      secondWs.close();
    }
  }, 30_000);

  // H2 (owner brief): `user.restricted-pin-reset` is the audit event the
  // server-local `loombre admin reset-pin <username>` CLI command emits
  // (packages/db/src/query/identity.ts's resetRestrictedPinAndEmit) —
  // ADMIN_ONLY delivery (apps/server/src/plugins/event-taxonomy.ts), the
  // SAME bucket job.updated is in, for the identical reason: instance-
  // administration/recovery activity, never content a non-admin viewer
  // should see over the live event stream. Mirrors this file's own
  // job.updated ADMIN_ONLY delivery test's shape exactly.
  it("user.restricted-pin-reset: ADMIN_ONLY delivery — casual socket receives nothing, admin socket receives it", async () => {
    const httpServer = app.getHttpServer();

    const adminLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "ws-test-admin-pin-reset",
      deviceProfile: buildDeviceProfile("ws-test-admin-pin-reset"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;

    const casualLogin = await request(httpServer).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "ws-test-casual-pin-reset",
      deviceProfile: buildDeviceProfile("ws-test-casual-pin-reset"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
    const casualToken: string = casualLogin.body.accessToken;

    const adminWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(adminToken)}`);
    const casualWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(casualToken)}`);

    const adminMessages: unknown[] = [];
    const casualMessages: unknown[] = [];
    adminWs.on("message", (data) => adminMessages.push(JSON.parse(data.toString())));
    casualWs.on("message", (data) => casualMessages.push(JSON.parse(data.toString())));

    await Promise.all([waitForOpen(adminWs), waitForOpen(casualWs)]);

    const db = createDb(process.env["DATABASE_URL"]!);
    const resetUserId = "018f6f1e-0000-7000-8000-0000000000d1";
    try {
      const nowMs = Date.now();
      await db
        .insertInto("events")
        .values({
          type: "user.restricted-pin-reset",
          ts_ms: nowMs,
          actor_user_id: null,
          payload: { userId: resetUserId, username: "ws-pin-reset-target", actor: "cli" },
        })
        .execute();

      // Two poll ticks' worth of margin (POLL_INTERVAL_MS = 500ms).
      await sleep(1500);

      const isPinResetFor = (m: unknown, wantUserId: string): boolean => {
        const envelope = m as { type?: unknown; payload?: { userId?: unknown } };
        return envelope.type === "user.restricted-pin-reset" && envelope.payload?.userId === wantUserId;
      };
      const isAnyPinReset = (m: unknown): boolean => (m as { type?: unknown }).type === "user.restricted-pin-reset";

      expect(
        adminMessages.some((m) => isPinResetFor(m, resetUserId)),
        `admin socket should receive user.restricted-pin-reset; got ${JSON.stringify(adminMessages)}`,
      ).toBe(true);
      expect(
        casualMessages.some(isAnyPinReset),
        `casual (non-admin) socket must NEVER receive user.restricted-pin-reset; got ${JSON.stringify(casualMessages)}`,
      ).toBe(false);

      const casualCountAfterFirstWindow = casualMessages.length;
      await sleep(750);
      expect(
        casualMessages.length,
        "casual socket received additional message(s) during the negative-window grace period",
      ).toBe(casualCountAfterFirstWindow);
    } finally {
      await db.destroy();
      adminWs.close();
      casualWs.close();
    }
  }, 20_000);

  // R1 review lane (STATE.md Stash run, S8/K12): the three stash.* event
  // types are ADMIN_ONLY, and the existing coverage for that classification
  // is a LIST-membership parity test (packages/contract/test/
  // admin-only-event-types-parity.spec.ts + apps/server/src/plugins/
  // event-taxonomy.spec.ts) — the ENFORCEMENT is only ever exercised here,
  // and only ever with job.updated/user.restricted-pin-reset. That matters
  // for the Stash types specifically because packages/db's own
  // eventVisibilityWhere() deliberately CANNOT gate them (ViewerContext
  // carries no isAdmin — they fall in its documented "no item/library/user
  // association to gate on, passes through unfiltered" bucket), so this
  // socket-level check is the ONLY thing standing between a non-admin
  // socket and a restricted library's id + its sync counts. Proven with a
  // real payload, not a synthetic type string.
  it("stash.sync.completed: ADMIN_ONLY delivery — a non-admin socket never learns a restricted library's id or sync counts, admin socket receives them", async () => {
    const httpServer = app.getHttpServer();

    const adminLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "ws-test-admin-stash-sync",
      deviceProfile: buildDeviceProfile("ws-test-admin-stash-sync"),
    });
    expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
    const adminToken: string = adminLogin.body.accessToken;

    const casualLogin = await request(httpServer).post("/auth/login").send({
      username: "casual",
      password: "loombre-seed-casual",
      deviceName: "ws-test-casual-stash-sync",
      deviceProfile: buildDeviceProfile("ws-test-casual-stash-sync"),
    });
    expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
    const casualToken: string = casualLogin.body.accessToken;

    const adminWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(adminToken)}`);
    const casualWs = new WebSocket(`${baseWsUrl}?token=${encodeURIComponent(casualToken)}`);

    const adminMessages: unknown[] = [];
    const casualMessages: unknown[] = [];
    adminWs.on("message", (data) => adminMessages.push(JSON.parse(data.toString())));
    casualWs.on("message", (data) => casualMessages.push(JSON.parse(data.toString())));

    await Promise.all([waitForOpen(adminWs), waitForOpen(casualWs)]);

    const db = createDb(process.env["DATABASE_URL"]!);
    const jobId = "018f6f1e-0000-7000-8000-0000000000e1";
    try {
      // The REAL restricted library's id — the exact value the payload
      // would carry in production, so "the casual socket never sees it" is
      // a statement about real zone data, not a placeholder uuid.
      const restrictedLibrary = await db
        .selectFrom("libraries")
        .select("id")
        .where("content_class", "=", "restricted")
        .executeTakeFirstOrThrow();

      const nowMs = Date.now();
      await db
        .insertInto("events")
        .values({
          type: "stash.sync.completed",
          ts_ms: nowMs,
          actor_user_id: null,
          payload: {
            jobId,
            libraryId: restrictedLibrary.id,
            mode: "incremental",
            status: "succeeded",
            counts: { matched: 12, updated: 12, unmatched: 3, stale: 1, skipped: 0 },
            durationMs: 4200,
            completedAtMs: nowMs,
          },
        })
        .execute();

      // Two poll ticks' worth of margin (POLL_INTERVAL_MS = 500ms).
      await sleep(1500);

      const isSyncCompletedFor = (m: unknown, wantJobId: string): boolean => {
        const envelope = m as { type?: unknown; payload?: { jobId?: unknown } };
        return envelope.type === "stash.sync.completed" && envelope.payload?.jobId === wantJobId;
      };

      expect(
        adminMessages.some((m) => isSyncCompletedFor(m, jobId)),
        `admin socket should receive stash.sync.completed; got ${JSON.stringify(adminMessages)}`,
      ).toBe(true);
      expect(
        casualMessages.some((m) => (m as { type?: unknown }).type === "stash.sync.completed"),
        `casual (non-admin) socket must NEVER receive stash.sync.completed; got ${JSON.stringify(casualMessages)}`,
      ).toBe(false);
      // Byte-level: the restricted library's id must not appear ANYWHERE
      // in anything that socket received, under any event type.
      expect(JSON.stringify(casualMessages)).not.toContain(restrictedLibrary.id);

      const casualCountAfterFirstWindow = casualMessages.length;
      await sleep(750);
      expect(
        casualMessages.length,
        "casual socket received additional message(s) during the negative-window grace period",
      ).toBe(casualCountAfterFirstWindow);
    } finally {
      await db.destroy();
      adminWs.close();
      casualWs.close();
    }
  }, 20_000);
});
