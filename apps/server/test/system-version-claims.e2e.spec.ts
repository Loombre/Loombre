// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/system-version-claims.e2e.spec.ts
//
// Remediation d3-b11 (P4, E/browser-admin-F8-contract-desc).
//
// `SystemUpdateInfo.currentVersion` was documented as "This server build's
// own version (matches SystemInfo.version)". It does not, except in a
// release build:
//
//   - GET /system/info  -> LOOMBRE_VERSION_FULL (admin.controller.ts),
//     which is "<version>-dev+<shorthash>" in a dev build,
//   - GET /system/update -> LOOMBRE_VERSION (update-check.service.ts's
//     resolveUpdateCheckConfig), the bare release version, because it is
//     compared against the signed manifest's semver.
//
// Both are correct — the update check MUST compare a bare semver — so the
// fix is the description, not the code. But a client that trusted the
// contract would show "0.9.0-rc.7" and "0.9.0-rc.7-dev+7ee87c4f" as the
// same fact, or diff them and conclude the server is inconsistent with
// itself.
//
// This suite pins the SHAPE rather than the two literal strings (a version
// bump must not break it): the two endpoints' values relate exactly as
// LOOMBRE_BUILD_MODE says they should, and the contract text states that
// condition instead of claiming an unconditional match.
//
// Self-sufficient (own ensureTestDatabase suffix, own reset+reseed).
// LOOMBRE_UPDATE_CHECK=off keeps GET /system/update deterministic and
// network-free, exactly as conformance.spec.ts does.

import "reflect-metadata";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { parse as parseYaml } from "yaml";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
import { LOOMBRE_BUILD_MODE, LOOMBRE_VERSION, LOOMBRE_VERSION_FULL } from "@loombre/shared";
import { AppModule } from "../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const OPENAPI_PATH = path.resolve(__dirname, "../../../packages/contract/openapi.yaml");
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

function buildDeviceProfile() {
  return {
    profileId: "system-version-claims",
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
let adminToken: string;

const ORIGINAL_UPDATE_CHECK = process.env["LOOMBRE_UPDATE_CHECK"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "system_version_claims_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "system-version-claims-secret-not-for-production";
  process.env["LOOMBRE_UPDATE_CHECK"] = "off";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const login = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "system-version-claims",
    deviceProfile: buildDeviceProfile(),
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  adminToken = login.body.accessToken;
});

afterAll(async () => {
  await app?.close();
  if (ORIGINAL_UPDATE_CHECK === undefined) delete process.env["LOOMBRE_UPDATE_CHECK"];
  else process.env["LOOMBRE_UPDATE_CHECK"] = ORIGINAL_UPDATE_CHECK;
});

function get(url: string) {
  return request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${adminToken}`);
}

function currentVersionDescription(): string {
  const doc = parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as {
    components: { schemas: Record<string, { properties?: Record<string, { description?: string }> }> };
  };
  const property = doc.components.schemas["SystemUpdateInfo"]?.properties?.["currentVersion"];
  expect(property, "openapi.yaml has no SystemUpdateInfo.currentVersion").toBeTruthy();
  return String(property!.description ?? "");
}

describe("d3-b11: SystemUpdateInfo.currentVersion vs SystemInfo.version", () => {
  it("the two endpoints report the two DIFFERENT constants they are each built on", async () => {
    const info = await get("/system/info");
    expect(info.status, JSON.stringify(info.body)).toBe(200);
    expect(info.body.version).toBe(LOOMBRE_VERSION_FULL);

    const update = await get("/system/update");
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    expect(update.body.currentVersion).toBe(LOOMBRE_VERSION);
    expect(update.body.verification).toBe("disabled");
  });

  it("they are equal ONLY in a release build — which is what makes an unconditional 'matches' wrong", async () => {
    const info = await get("/system/info");
    const update = await get("/system/update");
    if (LOOMBRE_BUILD_MODE === "release") {
      expect(update.body.currentVersion).toBe(info.body.version);
    } else {
      expect(update.body.currentVersion).not.toBe(info.body.version);
      expect(String(info.body.version).startsWith(String(update.body.currentVersion))).toBe(true);
    }
  });

  it("the contract states that condition instead of claiming an unconditional match", () => {
    const description = currentVersionDescription();
    expect(description.trim()).not.toBe("This server build's own version (matches SystemInfo.version).");
    // The two facts a client needs: this is the BARE version, and it only
    // equals SystemInfo.version in a release build.
    expect(description, "must say this is the bare/release version").toMatch(/bare|release build/i);
    expect(description, "must name SystemInfo.version and the condition").toMatch(/SystemInfo\.version/);
    expect(description, "must not promise an unconditional match").not.toMatch(/^This server build's own version \(matches/);
  });
});
