// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/trust-proxy-hardening.e2e.spec.ts
//
// Lane F / P4.4 deliverable 2: "verify LOOMBRE_TRUST_PROXY handling is a
// strict allowlist/boolean, not a blind trust of X-Forwarded-*; fix ONLY
// if broken, with tests; report findings either way."
//
// FINDING (documented here, not just in the lane report): the existing
// implementation is NOT broken.
//   - src/main.ts's resolveTrustProxySetting() parses LOOMBRE_TRUST_PROXY
//     into exactly what Express's OWN `trust proxy` setting understands
//     (boolean flag / hop-count integer / preset-or-CIDR string) and
//     calls `app.set('trust proxy', ...)` with that value — it never
//     parses X-Forwarded-For itself.
//   - When the env var is unset/empty/falsy, `app.set()` is never called
//     at all (Express's own default, disabled, wins) — confirmed by a
//     repo-wide grep: `X-Forwarded` appears in this codebase ONLY in
//     comments and in this env-var name; there is no direct
//     `req.headers['x-forwarded-for']` read anywhere. Every consumer
//     (playback/resolve-network.ts, session/auth.controller.ts, this
//     file's own rate limiter/anomaly-log path) reads `req.ip`/`req.ips`,
//     which is Express's OWN computed value — gated by the SAME trust
//     proxy setting, not a second, independently-trusting code path.
//
// auth-security.e2e.spec.ts already proves the ON case (a forwarded
// request's rate-limit key becomes the forwarded IP when
// LOOMBRE_TRUST_PROXY is explicitly enabled). What was NOT proven anywhere
// is the OFF (default) case end-to-end over real HTTP — this file closes
// that gap: with LOOMBRE_TRUST_PROXY unset, a spoofed X-Forwarded-For
// header must have ZERO effect on the rate-limit bucket key, the auth
// anomaly log's recorded IP, and req.ip generally. This is the real,
// live-HTTP proof that "blind trust of X-Forwarded-*" is NOT what ships.
//
// Self-sufficient (own "trust_proxy_hardening_test" DB suffix, own
// reset+seed), same pattern as every other e2e file here.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";
import { applyTrustProxy } from "../src/main.js";

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
let logDir: string;
let logFile: string;

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "trust_proxy_hardening_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "trust-proxy-hardening-test-secret";

  logDir = mkdtempSync(join(tmpdir(), "loombre-trust-proxy-log-"));
  logFile = join(logDir, "auth-anomaly.log");
  process.env["LOOMBRE_AUTH_LOG_FILE"] = logFile;

  // Deliberately low login cap so a handful of requests can trip 429 —
  // this file's whole point is which KEY those attempts get bucketed
  // under, same technique as auth-security.e2e.spec.ts.
  process.env["LOOMBRE_RATE_LOGIN"] = "3";

  // THE point of this file: LOOMBRE_TRUST_PROXY is deliberately left
  // UNSET — the default, off, "do not trust X-Forwarded-*" posture.
  delete process.env["LOOMBRE_TRUST_PROXY"];

  app = await NestFactory.create(AppModule, { logger: false });
  applyTrustProxy(app, process.env["LOOMBRE_TRUST_PROXY"]);
  await app.init();
}, 30_000);

afterAll(async () => {
  await app.close();
  rmSync(logDir, { recursive: true, force: true });
  for (const key of ["LOOMBRE_RATE_LOGIN", "LOOMBRE_AUTH_LOG_FILE", "LOOMBRE_TRUST_PROXY"]) {
    delete process.env[key];
  }
});

function anomalyLogLines(): string[] {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

async function loginAttempt(forwardedFor: string, password = "wrong-password"): Promise<request.Response> {
  return request(app.getHttpServer())
    .post("/auth/login")
    .set("X-Forwarded-For", forwardedFor)
    .send({
      username: "casual",
      password,
      deviceName: "trust-proxy-hardening-device",
      deviceProfile: buildDeviceProfile("trust-proxy-hardening-device"),
    });
}

describe("LOOMBRE_TRUST_PROXY unset (default): X-Forwarded-For is completely inert", () => {
  it("req.ip does not vary with a spoofed X-Forwarded-For header (proven via the rate-limit bucket key)", async () => {
    // Trip the 3-attempt cap using THREE DIFFERENT spoofed
    // X-Forwarded-For values. If the header had any effect, each of
    // these would land in its own bucket and NONE would trip 429 — the
    // real behavior (header ignored, all three share supertest's single
    // real loopback socket IP) is that the 4th attempt is already over
    // cap regardless of which spoofed IP rides along.
    const spoofedIps = ["203.0.113.50", "198.51.100.77", "10.10.10.10"];
    for (const ip of spoofedIps) {
      const res = await loginAttempt(ip);
      expect(res.status, `attempt from spoofed IP ${ip}`).toBe(401); // wrong password, not yet capped
    }

    // A FOURTH attempt, with YET ANOTHER spoofed IP never seen before —
    // if X-Forwarded-For were honored this would be a fresh bucket
    // (401). Since it is ignored, this is bucket-mate #4 on the real
    // socket IP and must be 429.
    const fourth = await loginAttempt("192.0.2.99");
    expect(fourth.status).toBe(429);
    expect(fourth.headers["retry-after"]).toBeDefined();
  });

  it("the fail2ban-format anomaly log records the REAL socket IP, never the spoofed header value", async () => {
    await loginAttempt("66.66.66.66", "still-wrong");
    const lines = anomalyLogLines();
    const failedLoginLines = lines.filter((l) => l.includes("FAILED_LOGIN") || l.includes("RATE_LIMITED"));
    expect(failedLoginLines.length).toBeGreaterThan(0);
    for (const line of failedLoginLines) {
      expect(line).not.toContain("66.66.66.66");
    }
  });

  it("resolveTrustProxySetting(undefined) never causes app.set('trust proxy', ...) to be called (unit-level cross-check of the e2e result above)", async () => {
    const { resolveTrustProxySetting } = await import("../src/main.js");
    expect(resolveTrustProxySetting(process.env["LOOMBRE_TRUST_PROXY"])).toBeUndefined();
  });
});
