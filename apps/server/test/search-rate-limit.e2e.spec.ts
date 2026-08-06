// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/search-rate-limit.e2e.spec.ts
//
// Fix Wave 3 (audit fafa47f, AUD-A7d-002): GET /search and
// GET /restricted/search carried NO rate limiter at all, despite an N+1
// detail fetch per row and being named alongside auth in docs/PLAN.md §10.
// This file proves a limiter now applies to both routes, with the same
// RFC 9457 429 shape every other SurfaceRateLimitGuard-decorated route
// uses (setup-rate-limit.e2e.spec.ts's own precedent).
//
// Own private DB + own low LOOMBRE_RATE_SEARCH override — same
// one-app-per-file isolation rationale as every other dedicated
// rate-limit-trip spec in this directory.

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

const SEARCH_LIMIT = 5;

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

function buildDeviceProfile(profileId: string): Record<string, unknown> {
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

async function loginAndGetToken(username: string, password: string, deviceName: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName, deviceProfile: buildDeviceProfile(deviceName) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "search_rate_limit_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "search-rate-limit-test-secret";
  process.env["LOOMBRE_RATE_LOGIN"] = "100000"; // don't let login itself interfere
  process.env["LOOMBRE_RATE_SEARCH"] = String(SEARCH_LIMIT);

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
});

afterAll(async () => {
  await app.close();
  for (const key of ["LOOMBRE_RATE_LOGIN", "LOOMBRE_RATE_SEARCH"]) {
    delete process.env[key];
  }
});

describe("GET /search: no limiter -> now rate-limited (AUD-A7d-002)", () => {
  it(`trips 429 + Retry-After after ${SEARCH_LIMIT} requests from one identity`, async () => {
    const token = await loginAndGetToken("casual", "loombre-seed-casual", "search-limit-casual");

    const codes: number[] = [];
    let tripped: request.Response | undefined;
    for (let i = 0; i < SEARCH_LIMIT + 2; i++) {
      const res = await request(app.getHttpServer())
        .get("/search")
        .query({ q: "harbor" })
        .set("Authorization", `Bearer ${token}`);
      codes.push(res.status);
      if (res.status === 429) tripped ??= res;
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(SEARCH_LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    expect(tripped).toBeDefined();
    expect(tripped!.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(tripped!.body.type).toBe("urn:loombre:problem:rate-limited");
    expect(tripped!.body.status).toBe(429);
    const retryAfter = Number(tripped!.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("a DIFFERENT identity (different user+device) has its own independent budget", async () => {
    const token = await loginAndGetToken("admin", "loombre-seed-admin", "search-limit-admin");
    const res = await request(app.getHttpServer())
      .get("/search")
      .query({ q: "harbor" })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200); // NOT 429 — casual's budget above must not bleed over
  });
});

describe("GET /restricted/search: no limiter -> now rate-limited (AUD-A7d-002)", () => {
  it(`trips 429 after ${SEARCH_LIMIT} requests, regardless of restricted-zone entitlement (the guard runs before the handler)`, async () => {
    // A fresh device/session for a clean, independent "search" bucket —
    // casual has NO restricted-zone entitlement (packages/db/seed/seed.mjs),
    // so every pre-cap attempt here 404s (not entitled) rather than 200 —
    // the limiter must still fire on request #(SEARCH_LIMIT+1) regardless.
    const token = await loginAndGetToken("casual", "loombre-seed-casual", "restricted-search-limit-casual");

    const codes: number[] = [];
    let tripped: request.Response | undefined;
    for (let i = 0; i < SEARCH_LIMIT + 2; i++) {
      const res = await request(app.getHttpServer())
        .get("/restricted/search")
        .query({ q: "harbor" })
        .set("Authorization", `Bearer ${token}`);
      codes.push(res.status);
      if (res.status === 429) tripped ??= res;
    }
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    expect(tripped).toBeDefined();
    expect(tripped!.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(tripped!.body.type).toBe("urn:loombre:problem:rate-limited");
    expect(Number(tripped!.headers["retry-after"])).toBeGreaterThan(0);
  });
});
