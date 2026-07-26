// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/setup-rate-limit.e2e.spec.ts
//
// P4.15 / security-review M1: the /setup surface is UNAUTHENTICATED and
// POST /setup/first-admin runs argon2id BEFORE the emptiness check, so an
// un-throttled surface is a hashing-amplification / admin-race DoS on a
// fresh instance and countUsers() spam on a configured one. Both routes
// carry the per-IP "setup" rate limiter (@RateLimit("setup","ip"),
// SurfaceRateLimitGuard). This proves the 429 + Retry-After actually fires.
//
// Its OWN spec file (one app, LOOMBRE_RATE_SETUP set before boot) rather than
// a describe inside setup.e2e.spec.ts: that file's functional/race tests
// need an effectively-unlimited ceiling, and standing up a SECOND app with a
// low ceiling in the same process alongside the first did not exercise the
// low limiter reliably. One app per file keeps the limiter state
// unambiguous — matching the pattern every other e2e file here uses.

import { afterAll, beforeAll, expect, it } from "vitest";
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

const SETUP_LIMIT = 3;
let app: INestApplication;

beforeAll(async () => {
  process.env["LOOMBRE_JWT_SECRET"] = "setup-rate-limit-test-secret-not-for-production";
  process.env["LOOMBRE_RATE_SETUP"] = String(SETUP_LIMIT);
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "setup_rate_limit_e2e_test");
  process.env["DATABASE_URL"] = databaseUrl;
  // ensureTestDatabase creates the DB but not its schema — migrate so
  // GET /setup/state's countUsers() has a `users` table to read (else 500).
  const res = spawnSync(process.execPath, [path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), "reset"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`migrate reset failed: ${res.stderr ?? ""}`);
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
});

afterAll(async () => {
  await app.close();
  delete process.env["LOOMBRE_RATE_SETUP"];
});

it("GET /setup/state trips 429 + Retry-After past the per-IP ceiling", async () => {
  const server = app.getHttpServer();
  // Fire the ceiling + 2 more from one IP. Refill is minutes away (capacity/
  // 60_000 ms per token), so within the test the bucket only drains: the
  // first SETUP_LIMIT succeed, everything after is 429. Assert on the
  // aggregate shape (not each request's exact index) so ordinary scheduling
  // jitter can't make it brittle.
  const codes: number[] = [];
  let limited: request.Response | undefined;
  for (let i = 0; i < SETUP_LIMIT + 2; i++) {
    const r = await request(server).get("/setup/state");
    codes.push(r.status);
    if (r.status === 429) limited ??= r;
  }
  expect(codes.filter((c) => c === 200)).toHaveLength(SETUP_LIMIT);
  expect(codes.filter((c) => c === 429)).toHaveLength(2);
  expect(limited?.headers["retry-after"]).toBeDefined();
  expect(limited?.body.type).toBe("urn:loombre:problem:rate-limited");
});
