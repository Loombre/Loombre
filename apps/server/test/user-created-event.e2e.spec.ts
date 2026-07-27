// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/user-created-event.e2e.spec.ts
//
// The WIRE-UP half of packages/db/test/outbox-emission.spec.ts's
// `user.created` describe. That file proves the query-layer contract
// directly against createFirstAdminIfEmpty/createUserAdminAndEmit (emission,
// actor attribution, transactional atomicity); it cannot prove that
// apps/server actually CALLS the emitting entry point — users.controller.ts
// shipped for a while calling the non-emitting `createUserAdmin` sibling
// instead, so POST /v1/users created real users and wrote no outbox row at
// all. Nothing failed when that happened, which is exactly the gap this file
// closes: a controller-level regression back to `createUserAdmin` (or an
// omitted `actorUserId`) must break a test.
//
// docs/PLAN.md §4.3 requires the event row in the SAME transaction as the
// state change; packages/contract/event-schemas/user.created.schema.json
// pins the payload to exactly four properties (additionalProperties: false)
// and forbids secrets — both are asserted here against the row the real HTTP
// request produced.
//
// Reads the outbox with a raw @loombre/db Kysely handle (createDb), the same
// direct-DB pattern ws-broadcaster.e2e.spec.ts and auth.e2e.spec.ts already
// use. It deliberately does NOT go through readUnprocessedEvents(): the
// broadcaster polls and marks rows processed in the background of a booted
// app, which would make an unprocessed-only read racy.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed) per this
// package's established live-DB test convention.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
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
let db: ReturnType<typeof createDb>;

async function userCreatedEvents() {
  return db
    .selectFrom("events")
    .select(["id", "type", "ts_ms", "actor_user_id", "payload"])
    .where("type", "=", "user.created")
    .orderBy("id", "asc")
    .execute();
}

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "user-created-event-test-secret-not-for-production";

  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "user_created_event_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;

  db = createDb(databaseUrl);
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
});

describe("POST /v1/users emits the user.created outbox event (docs/PLAN.md §4.3)", () => {
  it("writes exactly one user.created row, attributed to the ACTING admin, with the contract payload and no secrets", async () => {
    const httpServer = app.getHttpServer();

    const seedLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "user-created-event-seed",
      deviceProfile: buildDeviceProfile("user-created-event-seed"),
    });
    expect(seedLogin.status, JSON.stringify(seedLogin.body)).toBe(200);
    const seedToken: string = seedLogin.body.accessToken;

    const me = await request(httpServer).get("/users/me").set("Authorization", `Bearer ${seedToken}`);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    const actingAdminId: string = me.body.id;

    // The seed itself writes a user.created row (packages/db/seed/seed.mjs)
    // — assert the DELTA, never an absolute count.
    const before = await userCreatedEvents();

    const created = await request(httpServer)
      .post("/users")
      .set("Authorization", `Bearer ${seedToken}`)
      .send({
        username: "outbox-invitee",
        email: "outbox-invitee@example.invalid",
        password: "outbox-invitee-password-1",
        isAdmin: false,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const newUserId: string = created.body.id;

    const after = await userCreatedEvents();
    expect(
      after.length,
      `POST /users must write exactly one user.created outbox row (before=${before.length}, after=${after.length})`,
    ).toBe(before.length + 1);

    const emitted = after[after.length - 1]!;

    // Attributed to the admin who performed the creation — NOT to the new
    // user (which is what an omitted actorUserId would silently fall back
    // to, per CreateUserAdminAndEmitInput's doc comment).
    expect(emitted.actor_user_id).toBe(actingAdminId);
    expect(emitted.actor_user_id).not.toBe(newUserId);

    // Exactly user.created.schema.json's required set, nothing more
    // (additionalProperties: false) — notably no password/passwordHash.
    expect(emitted.payload).toEqual({
      userId: newUserId,
      username: "outbox-invitee",
      isAdmin: false,
      createdAtMs: created.body.createdAtMs,
    });
    expect(JSON.stringify(emitted.payload)).not.toContain("outbox-invitee-password-1");

    // Event timestamp is the same clock reading the row was written with.
    expect(Number(emitted.ts_ms)).toBe(created.body.createdAtMs);
  });

  it("emits nothing when the creation is rejected (duplicate username) — no orphan event", async () => {
    const httpServer = app.getHttpServer();

    const seedLogin = await request(httpServer).post("/auth/login").send({
      username: "admin",
      password: "loombre-seed-admin",
      deviceName: "user-created-event-dup",
      deviceProfile: buildDeviceProfile("user-created-event-dup"),
    });
    expect(seedLogin.status, JSON.stringify(seedLogin.body)).toBe(200);
    const seedToken: string = seedLogin.body.accessToken;

    const before = await userCreatedEvents();

    const dup = await request(httpServer)
      .post("/users")
      .set("Authorization", `Bearer ${seedToken}`)
      .send({
        username: "outbox-invitee",
        email: "outbox-invitee-again@example.invalid",
        password: "outbox-invitee-password-2",
        isAdmin: false,
      });
    expect(dup.status).toBeGreaterThanOrEqual(400);

    expect(await userCreatedEvents()).toHaveLength(before.length);
  });
});
