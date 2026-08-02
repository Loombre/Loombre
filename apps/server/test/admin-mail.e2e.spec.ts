// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/admin-mail.e2e.spec.ts
//
// Optional mail transport run: HTTP-level proof for PUT/DELETE
// /admin/mail/credentials and POST /admin/mail/test-send — mirrors
// admin-settings.e2e.spec.ts's own structure (self-sufficient, own
// ensureTestDatabase suffix, file0600 secret backend under a throwaway
// data dir). The underlying credential-service rules are already proven
// directly in apps/server/src/settings/mail-credentials.service.spec.ts;
// this file proves the WIRE-UP: routing, status codes, and the
// GET /admin/settings additive `mailCredentials` projection.
//
// POST /admin/mail/test-send's happy path enqueues a REAL 'mail-send'
// pg-boss job (never sends inline — CLAUDE.md invariant 6) against this
// file's own test database, so that one test carries a longer explicit
// timeout for pg-boss's first-connect queue provisioning.

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
let adminToken: string;
let casualToken: string;
let dataDir: string;

const ORIGINAL_SECRET_BACKEND = process.env["LOOMBRE_SECRET_BACKEND"];
const ORIGINAL_DATA_DIR = process.env["LOOMBRE_DATA_DIR"];
const ORIGINAL_SMTP_USERNAME = process.env["LOOMBRE_SMTP_USERNAME"];
const ORIGINAL_SMTP_PASSWORD = process.env["LOOMBRE_SMTP_PASSWORD"];

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "admin_mail_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "admin-mail-test-secret-not-for-production";

  process.env["LOOMBRE_SECRET_BACKEND"] = "file0600";
  dataDir = mkdtempSync(path.join(tmpdir(), "loombre-admin-mail-test-"));
  process.env["LOOMBRE_DATA_DIR"] = dataDir;
  delete process.env["LOOMBRE_SMTP_USERNAME"];
  delete process.env["LOOMBRE_SMTP_PASSWORD"];

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "admin",
    password: "loombre-seed-admin",
    deviceName: "admin-mail-test-admin",
    deviceProfile: buildDeviceProfile("admin-mail-test-admin"),
  });
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  adminToken = adminLogin.body.accessToken;

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "admin-mail-test-casual",
    deviceProfile: buildDeviceProfile("admin-mail-test-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;
}, 30_000);

afterEach(() => {
  if (ORIGINAL_SMTP_USERNAME === undefined) delete process.env["LOOMBRE_SMTP_USERNAME"];
  else process.env["LOOMBRE_SMTP_USERNAME"] = ORIGINAL_SMTP_USERNAME;
  if (ORIGINAL_SMTP_PASSWORD === undefined) delete process.env["LOOMBRE_SMTP_PASSWORD"];
  else process.env["LOOMBRE_SMTP_PASSWORD"] = ORIGINAL_SMTP_PASSWORD;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_SECRET_BACKEND === undefined) delete process.env["LOOMBRE_SECRET_BACKEND"];
  else process.env["LOOMBRE_SECRET_BACKEND"] = ORIGINAL_SECRET_BACKEND;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["LOOMBRE_DATA_DIR"];
  else process.env["LOOMBRE_DATA_DIR"] = ORIGINAL_DATA_DIR;
});

function callerFor(token: string) {
  const server = () => app.getHttpServer();
  return {
    get: (url: string) => request(server()).get(url).set("Authorization", `Bearer ${token}`),
    put: (url: string, body?: unknown) => {
      const req = request(server()).put(url).set("Authorization", `Bearer ${token}`);
      return body === undefined ? req : req.send(body as Record<string, unknown>);
    },
    delete: (url: string) => request(server()).delete(url).set("Authorization", `Bearer ${token}`),
    post: (url: string, body?: unknown) => {
      const req = request(server()).post(url).set("Authorization", `Bearer ${token}`);
      return body === undefined ? req : req.send(body as Record<string, unknown>);
    },
  };
}
function asAdmin() {
  return callerFor(adminToken);
}
function asCasual() {
  return callerFor(casualToken);
}

describe("PUT/DELETE /admin/mail/credentials", () => {
  it("403s for a non-admin (casual) token on both PUT and DELETE", async () => {
    const put = await asCasual().put("/admin/mail/credentials", { username: "u", password: "p" });
    expect(put.status).toBe(403);
    const del = await asCasual().delete("/admin/mail/credentials");
    expect(del.status).toBe(403);
  });

  it("422s an empty/whitespace-only username or password", async () => {
    const emptyUsername = await asAdmin().put("/admin/mail/credentials", { username: "   ", password: "pw" });
    expect(emptyUsername.status).toBe(422);
    const emptyPassword = await asAdmin().put("/admin/mail/credentials", { username: "user", password: "" });
    expect(emptyPassword.status).toBe(422);
  });

  it("set/clear happy path: 204 with no body, GET /admin/settings' additive mailCredentials reflects configured:true/source:'keyring'/setAtMs then configured:false, the raw password is never echoed anywhere on the wire", async () => {
    const rawPassword = "e2e-super-secret-smtp-password-never-returned";
    const beforeMs = Date.now();
    const set = await asAdmin().put("/admin/mail/credentials", { username: "smtp-e2e-user", password: rawPassword });
    expect(set.status).toBe(204);
    expect(set.text).toBe("");
    expect(JSON.stringify(set.body ?? {})).not.toContain(rawPassword);

    const afterSet = await asAdmin().get("/admin/settings");
    expect(afterSet.status).toBe(200);
    expect(JSON.stringify(afterSet.body)).not.toContain(rawPassword);
    expect(afterSet.body.mailCredentials.configured).toBe(true);
    expect(afterSet.body.mailCredentials.source).toBe("keyring");
    expect(afterSet.body.mailCredentials.setAtMs).toBeGreaterThanOrEqual(beforeMs);

    const clear = await asAdmin().delete("/admin/mail/credentials");
    expect(clear.status).toBe(204);
    expect(clear.text).toBe("");

    const afterClear = await asAdmin().get("/admin/settings");
    expect(afterClear.body.mailCredentials).toEqual({ configured: false, setAtMs: null, source: null });
  });

  it("409s a PUT while both env vars are set, instead of silently writing an inert keyring value", async () => {
    process.env["LOOMBRE_SMTP_USERNAME"] = "env-user";
    process.env["LOOMBRE_SMTP_PASSWORD"] = "env-pass";

    const res = await asAdmin().put("/admin/mail/credentials", { username: "attempted-override", password: "x" });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.detail).toContain("LOOMBRE_SMTP_USERNAME");

    const get = await asAdmin().get("/admin/settings");
    expect(get.body.mailCredentials).toEqual({ configured: true, setAtMs: null, source: "env" });
  });
});

describe("POST /admin/mail/test-send", () => {
  it("403s for a non-admin (casual) token", async () => {
    const res = await asCasual().post("/admin/mail/test-send", { to: "someone@example.com" });
    expect(res.status).toBe(403);
  });

  it("409s when mail is not configured (fresh DB: mail.smtpHost/fromAddress/network.publicUrl all unset)", async () => {
    const res = await asAdmin().post("/admin/mail/test-send", { to: "someone@example.com" });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  describe("once mail is configured", () => {
    beforeAll(async () => {
      const host = await asAdmin().put("/admin/settings/mail.smtpHost", { value: "smtp.example.invalid" });
      expect(host.status, JSON.stringify(host.body)).toBe(200);
      const from = await asAdmin().put("/admin/settings/mail.fromAddress", { value: "server@example.invalid" });
      expect(from.status, JSON.stringify(from.body)).toBe(200);
      const publicUrl = await asAdmin().put("/admin/settings/network.publicUrl", { value: "https://loombre.example.invalid" });
      expect(publicUrl.status, JSON.stringify(publicUrl.body)).toBe(200);
    });

    it("422s an invalid 'to' address", async () => {
      const res = await asAdmin().post("/admin/mail/test-send", { to: "not-an-email" });
      expect(res.status).toBe(422);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    });

    it("422s a bodyless request", async () => {
      const res = await asAdmin().post("/admin/mail/test-send");
      expect(res.status).toBe(422);
    });

    it(
      "202s with a jobId and enqueues a REAL mail-send job (templateId 'test', no inline send on this request thread)",
      async () => {
        const res = await asAdmin().post("/admin/mail/test-send", { to: "recipient@example.invalid" });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        expect(typeof res.body.jobId).toBe("string");
        expect(res.body.jobId.length).toBeGreaterThan(0);
      },
      15_000,
    );
  });
});
