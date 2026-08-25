// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/capabilities-auth-scoping.e2e.spec.ts
//
// api-restricted-leak-F1 (2026-08-20/21 QA, owner ruling 2026-08-24):
// GET /system/capabilities used to report the LIVE `restricted.enabled`
// setting to ANY anonymous caller, so a passer-by could detect whether this
// operator had switched adult/restricted-content gating on. The ruling: the
// restricted capability becomes AUTH-ONLY — unauthenticated callers get the
// capability report WITHOUT the flag (ABSENT, not `false`: the less-
// informative of the two shapes, since `false` would still confirm the
// server was asked and answered about this instance's setting), any
// authenticated session gets the full report. Entitlement gates g2..g5
// (docs/PLAN.md §6.4) are untouched — this only moves gate 1's VISIBILITY
// behind auth.
//
// The load-bearing property is the byte-identity test below: with the
// setting ON and with it OFF, the anonymous response is the SAME BYTES.
// Anything weaker (an absent key in one case, `enabled:false` in the other)
// would leak the same bit through a different channel.
//
// Self-sufficient: own ensureTestDatabase suffix + own reset/seed, same
// convention as auth.e2e.spec.ts (whose own capabilities block covers the
// per-flag honesty of the rest of the map).

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
import { SettingsService } from "../src/settings/settings.service.js";

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

function buildDeviceProfile(profileId = "web-chrome") {
  return {
    profileId,
    directPlayContainers: ["mp4", "mkv"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "h264",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
        maxBitrateBps: 20_000_000,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let settingsService: SettingsService;
let adminToken: string;
let casualToken: string;

/** Addendum A, lane S3: SettingsService caches its env-pin resolution — every
 *  mid-test mutation must reload() for the new value to take effect (see
 *  settings.service.ts's header, and auth.e2e.spec.ts's identical helper). */
async function setRestrictedEnabled(value: "true" | undefined): Promise<void> {
  if (value === undefined) {
    delete process.env["LOOMBRE_RESTRICTED_ENABLED"];
  } else {
    process.env["LOOMBRE_RESTRICTED_ENABLED"] = value;
  }
  await settingsService.reload();
}

async function login(username: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password, deviceName: `caps-scope-${username}`, deviceProfile: buildDeviceProfile() });
  if (res.status !== 200) throw new Error(`login as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "server_test_capabilities_scope");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "caps-scope-e2e-secret-not-for-production";
  process.env["LOOMBRE_RATE_LOGIN"] = "1000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  settingsService = app.get(SettingsService);

  adminToken = await login("admin", "loombre-seed-admin");
  casualToken = await login("casual", "loombre-seed-casual");
}, 120_000);

afterAll(async () => {
  await app?.close();
  delete process.env["LOOMBRE_RATE_LOGIN"];
  delete process.env["LOOMBRE_RESTRICTED_ENABLED"];
});

describe("GET /system/capabilities: gate-1 disclosure is auth-only (api-restricted-leak-F1)", () => {
  it("unauthenticated, restricted ON: the restricted-content key is ABSENT from details and flags", async () => {
    await setRestrictedEnabled("true");
    const res = await request(app.getHttpServer()).get("/system/capabilities");

    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(res.body.details, "restricted-content")).toBe(false);
    expect(res.body.flags).not.toContain("restricted-content");
  });

  it("unauthenticated: the response is BYTE-IDENTICAL with the setting on and off", async () => {
    await setRestrictedEnabled("true");
    const on = await request(app.getHttpServer()).get("/system/capabilities");
    await setRestrictedEnabled(undefined);
    const off = await request(app.getHttpServer()).get("/system/capabilities");

    expect(on.status).toBe(200);
    expect(off.status).toBe(200);
    expect(JSON.stringify(on.body)).toBe(JSON.stringify(off.body));
  });

  it("unauthenticated: every OTHER capability, and passwordResetAvailable, still ship", async () => {
    await setRestrictedEnabled("true");
    const res = await request(app.getHttpServer()).get("/system/capabilities");

    expect(Object.keys(res.body.details).sort()).toEqual(
      ["data-export", "data-import", "hls-ll", "hw-transcode", "music", "remote-access"],
    );
    expect(res.body.flags).toContain("music");
    expect(res.body.flags).toContain("data-export");
    // The login screen's FORGOT affordance (M8) reads this pre-auth — it must
    // keep shipping unauthenticated.
    expect(typeof res.body.passwordResetAvailable).toBe("boolean");
  });

  it("a garbage Bearer is treated as anonymous — no 401, key still absent", async () => {
    await setRestrictedEnabled("true");
    const res = await request(app.getHttpServer())
      .get("/system/capabilities")
      .set("authorization", "Bearer not-a-real-token");

    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(res.body.details, "restricted-content")).toBe(false);
  });

  it("authenticated NON-ENTITLED casual: sees the live flag (gate 1 visibility, not entitlement)", async () => {
    await setRestrictedEnabled("true");
    const res = await request(app.getHttpServer())
      .get("/system/capabilities")
      .set("authorization", `Bearer ${casualToken}`);

    expect(res.status).toBe(200);
    expect(res.body.details["restricted-content"].enabled).toBe(true);
    expect(res.body.flags).toContain("restricted-content");
  });

  it("authenticated admin: sees the live flag", async () => {
    await setRestrictedEnabled("true");
    const res = await request(app.getHttpServer())
      .get("/system/capabilities")
      .set("authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.details["restricted-content"].enabled).toBe(true);
    expect(res.body.flags).toContain("restricted-content");
  });

  it("authenticated, restricted OFF: the detail is PRESENT and false (the setup wizard's own read)", async () => {
    await setRestrictedEnabled(undefined);
    const res = await request(app.getHttpServer())
      .get("/system/capabilities")
      .set("authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.details["restricted-content"].enabled).toBe(false);
    expect(res.body.flags).not.toContain("restricted-content");
  });
});
