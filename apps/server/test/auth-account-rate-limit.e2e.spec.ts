// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/auth-account-rate-limit.e2e.spec.ts
//
// Fix Wave 3 (audit fafa47f, AUD-A7d-001): POST /auth/login and POST
// /auth/refresh were limited PER-IP ONLY — a distributed attempt against
// one account (or one device's refresh chain) from many source addresses
// was unthrottled. This file proves the per-ACCOUNT / per-DEVICE
// dimension now exists and trips INDEPENDENTLY of the per-IP one, by
// firing every attempt from a brand-new, never-before-seen forwarded IP —
// exactly the shape auth-security.e2e.spec.ts's own per-IP tests use, just
// inverted (there, the IP stays fixed and the account is incidental; here,
// the account/device stays fixed and the IP is what varies).
//
// Own private DB + own low-cap env overrides (LOOMBRE_RATE_LOGIN_BY_IDENTIFIER,
// LOOMBRE_RATE_REFRESH_BY_DEVICE) — same one-app-per-file isolation
// rationale setup-rate-limit.e2e.spec.ts's header documents (a low ceiling
// sharing a process with tests that need effectively-unlimited headroom
// doesn't mix reliably). LOOMBRE_RATE_LOGIN/LOOMBRE_RATE_REFRESH (the
// PER-IP policies) are set generously high so this file's own per-IP
// buckets — one per synthetic address, each seeing exactly one request —
// can never be what trips a 429 here; only the per-account/per-device
// dimension can.

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
import { applyTrustProxy } from "../src/main.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

const LOGIN_BY_IDENTIFIER_LIMIT = 4;
const REFRESH_BY_DEVICE_LIMIT = 4;

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
let ipCounter = 0;

/** A never-before-used synthetic forwarded IP — every call gets its own,
 *  so the PER-IP bucket (LOOMBRE_RATE_LOGIN/REFRESH, both set generously
 *  high below) can never accumulate more than one hit per address. */
function freshIp(): string {
  ipCounter += 1;
  const b = Math.floor(ipCounter / 65536) % 256;
  const c = Math.floor(ipCounter / 256) % 256;
  const d = ipCounter % 256;
  return `198.${b}.${c}.${d}`;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "auth_account_rate_limit_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "auth-account-rate-limit-test-secret";
  process.env["LOOMBRE_TRUST_PROXY"] = "1";
  // Generous per-IP headroom — this file's whole point is the OTHER
  // dimension, and every request here uses a fresh, never-repeated IP
  // anyway (see freshIp()), so this is belt-and-suspenders.
  process.env["LOOMBRE_RATE_LOGIN"] = "100000";
  process.env["LOOMBRE_RATE_REFRESH"] = "100000";
  process.env["LOOMBRE_RATE_LOGIN_BY_IDENTIFIER"] = String(LOGIN_BY_IDENTIFIER_LIMIT);
  process.env["LOOMBRE_RATE_REFRESH_BY_DEVICE"] = String(REFRESH_BY_DEVICE_LIMIT);

  app = await NestFactory.create(AppModule, { logger: false });
  applyTrustProxy(app, process.env["LOOMBRE_TRUST_PROXY"]);
  await app.init();
});

afterAll(async () => {
  await app.close();
  for (const key of [
    "LOOMBRE_TRUST_PROXY",
    "LOOMBRE_RATE_LOGIN",
    "LOOMBRE_RATE_REFRESH",
    "LOOMBRE_RATE_LOGIN_BY_IDENTIFIER",
    "LOOMBRE_RATE_REFRESH_BY_DEVICE",
  ]) {
    delete process.env[key];
  }
});

async function loginAttempt(username: string, deviceName: string, password = "definitely-the-wrong-password") {
  return request(app.getHttpServer())
    .post("/auth/login")
    .set("X-Forwarded-For", freshIp())
    .send({ username, password, deviceName, deviceProfile: buildDeviceProfile(deviceName) });
}

describe("POST /auth/login: per-ACCOUNT rate limit, independent of per-IP (AUD-A7d-001)", () => {
  it(`trips 429 after ${LOGIN_BY_IDENTIFIER_LIMIT} attempts against ONE identifier, even though EVERY attempt arrives from a brand-new IP`, async () => {
    const codes: number[] = [];
    let tripped: request.Response | undefined;
    for (let i = 0; i < LOGIN_BY_IDENTIFIER_LIMIT + 2; i++) {
      const res = await loginAttempt("casual", `account-limit-probe-${i}`);
      codes.push(res.status);
      if (res.status === 429) tripped ??= res;
    }
    // Every attempt used a UNIQUE X-Forwarded-For — if the only limiter in
    // effect were per-IP, NONE of these would ever 429 (each IP's own
    // bucket only ever sees one request). A 429 appearing here can only be
    // explained by a limiter keyed on the submitted identifier itself.
    expect(codes.filter((c) => c === 401)).toHaveLength(LOGIN_BY_IDENTIFIER_LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    expect(tripped).toBeDefined();
    expect(tripped!.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(tripped!.body.type).toBe("urn:loombre:problem:rate-limited");
    expect(tripped!.body.status).toBe(429);
    const retryAfter = Number(tripped!.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("a DIFFERENT identifier is on its own independent budget, even from IPs already used against the first account", async () => {
    // "admin" has never been attempted in this file — its bucket must be
    // fully fresh regardless of how many casual/IP combinations preceded it.
    const res = await loginAttempt("admin", "account-limit-different-identity");
    expect(res.status).toBe(401); // wrong password, NOT 429
  });

  it("the identifier bucket is keyed case/whitespace-normalized (CITEXT parity: 'Casual' and 'casual' share ONE budget)", async () => {
    // 'casual' already spent its whole LOGIN_BY_IDENTIFIER_LIMIT budget in
    // the first test above — a differently-cased submission must still hit
    // the SAME exhausted bucket (users.username is CITEXT: 'casual' and
    // 'Casual' are literally the same account), not a fresh one.
    const res = await loginAttempt("Casual", "account-limit-case-variant");
    expect(res.status).toBe(429);
  });
});

describe("POST /auth/refresh: per-DEVICE rate limit, independent of per-IP (AUD-A7d-001)", () => {
  const deviceId = "22222222-2222-4222-8222-222222222222";

  it(`trips 429 after ${REFRESH_BY_DEVICE_LIMIT} attempts against ONE submitted deviceId, even though EVERY attempt arrives from a brand-new IP`, async () => {
    const codes: number[] = [];
    let tripped: request.Response | undefined;
    for (let i = 0; i < REFRESH_BY_DEVICE_LIMIT + 2; i++) {
      const res = await request(app.getHttpServer())
        .post("/auth/refresh")
        .set("X-Forwarded-For", freshIp())
        .send({ refreshToken: "not-a-real-token", deviceId });
      codes.push(res.status);
      if (res.status === 429) tripped ??= res;
    }
    expect(codes.filter((c) => c === 401)).toHaveLength(REFRESH_BY_DEVICE_LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    expect(tripped!.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(tripped!.body.type).toBe("urn:loombre:problem:rate-limited");
    expect(Number(tripped!.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a DIFFERENT deviceId is on its own independent budget", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", freshIp())
      .send({ refreshToken: "not-a-real-token", deviceId: "33333333-3333-4333-8333-333333333333" });
    expect(res.status).toBe(401); // invalid token, NOT 429
  });
});
